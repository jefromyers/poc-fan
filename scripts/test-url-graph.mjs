// Verification harness for the Deep-compare read-URL graph. Mirrors the loader
// pattern used to verify compare-export. Run:
//   node --experimental-strip-types --import ./scripts/test-url-graph.mjs ...
// but it's self-contained: it registers an @/ alias loader for the repo root,
// builds synthetic CompareInput[], and asserts the graph + serializers + ZIP.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
// Register an inline @/ resolver via a data: loader.
const loader = `
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(${JSON.stringify(ROOT + "/")}).href;
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) {
    let t = root + spec.slice(2);
    if (!/\\.[a-z]+$/.test(t)) t += '.ts';
    return next(t, ctx);
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(loader), pathToFileURL("./"));

const {
  buildReadUrlGraph,
  graphToCsv,
  graphToJson,
  graphToMarkdown,
  deepCompareFilename,
} = await import("@/lib/url-graph.ts");
const { zipStore } = await import("@/lib/zip.ts");

// --- synthetic events ---
const search = (id, urls) => ({
  type: "response.output_item.done",
  item: {
    id,
    type: "web_search_call",
    action: { type: "search", query: "q", sources: urls.map((u) => ({ url: u, title: "T " + u })) },
  },
});
const open = (id, url) => ({
  type: "response.output_item.done",
  item: { id, type: "web_search_call", action: { type: "open_page", url } },
});
const cite = (url) => ({
  type: "response.output_text.annotation.added",
  annotation: { type: "url_citation", url, title: "T " + url },
});

// Run A: an FDA regulator page (cited), a EUR-Lex regulator page, and 20 distinct
// reddit pages (should auto-flag reddit as high-volume even though it's profiled).
const redditA = Array.from({ length: 20 }, (_, i) => `https://www.reddit.com/r/x/comments/${i}/post`);
const A = {
  run: { id: "aaaa1111", model: "gpt-5.5", query: "regulatory affairs lead", effort: "high", status: "completed", created_at: "2026-01-01" },
  events: [
    search("s1", [
      "https://www.fda.gov/vaccines-blood-biologics/safety/warning?utm_source=openai",
      "https://eur-lex.europa.eu/eli/reg/2024/2847/oj",
      ...redditA,
    ]),
    open("o1", "https://www.fda.gov/vaccines-blood-biologics/safety/warning"),
    cite("https://www.fda.gov/vaccines-blood-biologics/safety/warning"),
  ],
};
// Run B: shares the FDA page (not cited), plus a unique gov.uk page, plus a
// fragment-variant of the FDA page that must collapse to the same row.
const B = {
  run: { id: "bbbb2222", model: "gpt-5.5", query: "pharmacovigilance lead", effort: "medium", status: "completed", created_at: "2026-01-01" },
  events: [
    search("s2", [
      "https://www.fda.gov/vaccines-blood-biologics/safety/warning#section-2",
      "https://www.service.gov.uk/guidance/foo",
    ]),
  ],
};

const g = buildReadUrlGraph([A, B], { generatedAt: "2026-06-03T00:00:00.000Z" });

let pass = 0, fail = 0;
const must = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " — " + label); cond ? pass++ : fail++; };

const byUrl = (frag) => g.rows.find((r) => r.url.includes(frag));

// 1. FDA page: read by both A and B (fragment collapsed), cited only by A.
const fda = byUrl("/vaccines-blood-biologics/safety/warning");
must(fda && fda.runs_read === 2, "FDA page read by 2 runs (fragment + utm collapsed)");
must(fda && fda.cited_any === true, "FDA page cited_any true");
must(fda && fda.per_role.find((p) => p.role === "A")?.cited === true && fda.per_role.find((p) => p.role === "B")?.cited === false, "FDA per_role: A cited, B not");
must(fda && fda.registrable_domain === "fda.gov" && fda.site_type === "regulator", "FDA registrable=fda.gov, site_type=regulator");

// 2. PSL: gov.uk resolves to service.gov.uk, europa.eu correct.
const govuk = byUrl("service.gov.uk");
must(govuk && govuk.registrable_domain === "service.gov.uk", "gov.uk eTLD+1 = service.gov.uk (PSL)");
const eurlex = byUrl("eur-lex.europa.eu");
must(eurlex && eurlex.registrable_domain === "europa.eu" && eurlex.site_type === "regulator", "eur-lex → europa.eu regulator (host profile)");

// 3. reddit profiled as hub/scraper, weight 0.2, high_volume.
const reddit = g.rows.find((r) => r.registrable_domain === "reddit.com");
must(reddit && reddit.weight === 0.2 && reddit.high_volume_flag === true, "reddit weight 0.2 + high_volume");
must(g.rows.filter((r) => r.registrable_domain === "reddit.com").length === 20, "20 distinct reddit rows (domain_freq)");
must(reddit && reddit.domain_freq === 20, "reddit domain_freq = 20");

// 4. invariant domain_freq >= subdomain_freq >= folder_freq for every row.
must(g.rows.every((r) => r.domain_freq >= r.subdomain_freq && r.subdomain_freq >= r.folder_freq && r.folder_freq >= 1), "freq invariant holds for all rows");

// 5. row count = distinct read URLs (FDA + eurlex + 20 reddit + gov.uk = 23).
must(g.rowCount === 23, `rowCount = 23 (got ${g.rowCount})`);

// 6. total_reads == runs_read everywhere.
must(g.rows.every((r) => r.total_reads === r.runs_read), "total_reads == runs_read");

// 7. CSV: header + correct row count, and quoting of per_role JSON cell.
const csv = graphToCsv(g);
const csvLines = csv.trimEnd().split("\r\n");
must(csvLines.length === 24, `CSV has 1 header + 23 rows (got ${csvLines.length})`);
must(csvLines[0].startsWith("url,runs_read,total_reads"), "CSV header correct");
must(csv.includes('"[{""role"":""A"",'), "CSV per_role JSON cell properly double-quoted");

// 8. CSV comma-in-URL quoting.
const Ccomma = {
  run: { id: "cccc3333", model: "m", query: "x", effort: null, status: "completed", created_at: "2026-01-01" },
  events: [search("s3", ["https://ex.com/a,b?q=1,2"])],
};
const g2 = buildReadUrlGraph([Ccomma, Ccomma], { generatedAt: "t" });
must(graphToCsv(g2).includes('"https://ex.com/a,b'), "CSV quotes URL containing a comma");

// 9. JSON parses and round-trips rowCount.
const parsed = JSON.parse(graphToJson(g));
must(parsed.rows.length === 23 && parsed.profileVersion && parsed.roleLegend.length === 2, "JSON valid, roleLegend present");

// 10. Markdown contains all rows (no truncation) + roles section.
const md = graphToMarkdown(g);
must((md.match(/^\| /gm) || []).length >= 23, "Markdown table has all rows (no truncation)");
must(md.includes("## Roles") && md.includes("aaaa1111".slice(0, 8)), "Markdown roles legend present");

// 11. filename.
must(deepCompareFilename([A.run, B.run]).startsWith("deep-compare-regulatory-affairs-lead-2runs-aaaa-bbbb"), "filename shaped correctly");

// 11b. Full prompt is NOT truncated in roleLegend / JSON / Markdown.
const longPrompt =
  "I'm the OT security lead deploying ~200 headless edge computers and reviewers now require secure boot, signed updates, attestation, and a defensible vulnerability-handling posture across the whole plant lifecycle for the next decade — what exactly do they expect?";
const L1 = { run: { id: "dddd4444", model: "gpt-5.5", query: longPrompt, effort: "high", status: "completed", created_at: "2026-01-01" }, events: [search("s4", ["https://nist.gov/x"])] };
const L2 = { run: { id: "eeee5555", model: "gpt-5.5", query: "short one", effort: "low", status: "completed", created_at: "2026-01-01" }, events: [search("s5", ["https://nist.gov/y"])] };
const gl = buildReadUrlGraph([L1, L2], { generatedAt: "t" });
must(gl.roleLegend[0].query === longPrompt, "roleLegend keeps the full prompt (no truncation)");
must(graphToJson(gl).includes(longPrompt), "JSON contains the full prompt");
must(graphToMarkdown(gl).includes("next decade — what exactly do they expect?"), "Markdown contains the full prompt tail");

// 12. ZIP integrity via unzip -t.
const base = deepCompareFilename([A.run, B.run]);
const zip = zipStore([
  { name: `${base}.csv`, text: csv },
  { name: `${base}.json`, text: graphToJson(g) },
  { name: `${base}.md`, text: md },
]);
const zpath = join(tmpdir(), "deep-test.zip");
writeFileSync(zpath, Buffer.from(zip));
try {
  const out = execSync(`unzip -t ${zpath}`, { encoding: "utf8" });
  must(/No errors detected/.test(out) && out.includes(".csv") && out.includes(".json") && out.includes(".md"), "ZIP passes unzip -t with 3 entries");
} catch (e) {
  must(false, "ZIP unzip -t failed: " + (e.message || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
