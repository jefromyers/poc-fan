// Pure serialization of N runs into a single Markdown comparison document,
// meant to be pasted into an LLM (the same workflow as the per-run export).
//
// Answers three questions about a set of runs of the *same* decision researched
// from different angles:
//   1. Which pages / domains do the runs share, and which are unique to each?
//   2. Which run researches in the most sealed-off corner of the web?  (isolate)
//   3. What did each run actually cite, by domain?
//
// "Read" for a run = the pages it Cited ∪ the pages it Consulted (surfaced in
// search results), deduped by the shared normalizeUrl (tracking params stripped)
// so the same page isn't counted twice. Overlap is reported at BOTH levels:
//   - page  — exact URL match (strict; two pages on the same site don't match)
//   - domain — the unit you actually act on (you publish on a domain, not a URL)
// No I/O here — the route reads the DB and hands us rows.

import {
  deriveRunState,
  domain,
  normalizeUrl,
  type DerivedRunState,
} from "@/lib/derive";
import type { StreamEvent } from "@/lib/events";
import type { RunRow } from "@/lib/markdown-export";

export type CompareInput = { run: RunRow; events: StreamEvent[] };

type Prepared = {
  key: string; // A, B, C, …
  run: RunRow;
  d: DerivedRunState;
  read: Set<string>; // cited ∪ consulted page URLs, normalized
  domains: Set<string>; // distinct domains across `read`
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_LISTED = 40; // cap per-pair shared lists so the doc stays readable

function keyFor(i: number): string {
  return LETTERS[i] ?? `#${i + 1}`;
}

// Markdown table cell: pipes break columns, newlines break rows.
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function clip(value: string, max: number): string {
  const v = value.trim().replace(/\s+/g, " ");
  return v.length > max ? v.slice(0, max - 1) + "…" : v;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out: string[] = [];
  for (const x of small) if (large.has(x)) out.push(x);
  return out;
}

function domainsOf(urls: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const u of urls) s.add(domain(u));
  return s;
}

function domainCounts(urls: Iterable<string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const dom = domain(u);
    counts.set(dom, (counts.get(dom) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

// Host without a leading www. Empty string if the URL won't parse.
function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Registrable domain heuristic: the last two labels (zenbusiness.com,
// help.zenbusiness.com → zenbusiness.com). Good enough without a public-suffix
// list; multi-part TLDs like co.uk will group one level too deep, which is fine
// for sorting/grouping here.
function registrable(host: string): string {
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

// The subdomain portion ahead of the registrable domain ("help" for
// help.zenbusiness.com; "" for the apex).
function subOf(host: string): string {
  const reg = registrable(host);
  return host.length > reg.length ? host.slice(0, host.length - reg.length - 1) : "";
}

// Path + remaining (non-tracking) query, already normalized upstream.
function pathOf(u: string): string {
  try {
    const x = new URL(u);
    return (x.pathname + x.search) || "/";
  } catch {
    return "";
  }
}

// A symmetric NxN overlap matrix rendered as a Markdown table; cells off the
// diagonal hold |sets[i] ∩ sets[j]|.
function matrix(runs: Prepared[], sets: Set<string>[]): string[] {
  const out: string[] = [];
  out.push(`|  | ${runs.map((r) => r.key).join(" | ")} |`);
  out.push(`| --- | ${runs.map(() => "---").join(" | ")} |`);
  for (let i = 0; i < runs.length; i++) {
    const cells = runs.map((_, j) =>
      i === j ? "—" : String(intersect(sets[i], sets[j]).length),
    );
    out.push(`| ${runs[i].key} | ${cells.join(" | ")} |`);
  }
  return out;
}

// The run that overlaps least with the rest: fewest peers shared with, tie-broken
// by fewest total shared items. `sets` is page- or domain-level.
function findIsolate(runs: Prepared[], sets: Set<string>[]) {
  const stats = runs.map((r, i) => {
    let peersShared = 0;
    let totalShared = 0;
    for (let j = 0; j < runs.length; j++) {
      if (j === i) continue;
      const n = intersect(sets[i], sets[j]).length;
      if (n > 0) peersShared++;
      totalShared += n;
    }
    return { r, peersShared, totalShared };
  });
  return stats.reduce((best, s) =>
    s.peersShared < best.peersShared ||
    (s.peersShared === best.peersShared && s.totalShared < best.totalShared)
      ? s
      : best,
  );
}

export function runsToCompareMarkdown(inputs: CompareInput[]): string {
  const runs: Prepared[] = inputs.map((inp, i) => {
    const d = deriveRunState(inp.events);
    // Everything the run engaged with: surfaced (consulted), opened, or cited.
    const read = new Set<string>([
      ...d.consultedUrls,
      ...d.openedUrls,
      ...d.citedUrls,
    ]);
    return { key: keyFor(i), run: inp.run, d, read, domains: domainsOf(read) };
  });

  // Global lookup so shared pages can be rendered as titled links.
  const titleByUrl = new Map<string, { url: string; title: string }>();
  for (const r of runs) {
    for (const s of r.d.sources) {
      const k = normalizeUrl(s.url);
      if (!titleByUrl.has(k))
        titleByUrl.set(k, { url: s.url, title: s.title || s.url });
    }
  }
  const pageLink = (u: string): string => {
    const info = titleByUrl.get(u) ?? { url: u, title: u };
    const title = (info.title || info.url).replace(/[\[\]]/g, "");
    return `[${clip(title, 90)}](${info.url}) — ${domain(info.url)}`;
  };

  const pageSets = runs.map((r) => r.read);
  const domainSets = runs.map((r) => r.domains);

  const out: string[] = [];
  out.push("# Thinking Inspector — Run Comparison");
  out.push("");
  out.push(
    `Comparing **${runs.length} runs**. "Pages read" for a run = pages it ` +
      "**cited** plus pages **consulted** (surfaced in its search results), " +
      "deduped after stripping tracking parameters. Overlap is reported at two " +
      "levels: **page** (exact URL — strict) and **domain** (the unit you act " +
      "on — two different pages on the same site count as a shared domain).",
  );
  out.push("");
  out.push(
    "> Caveat: most consulted pages *surfaced* in search results; only pages " +
      "reached via an explicit Open action were demonstrably read in full. " +
      "Overlap is measured over surfaced-or-cited pages.",
  );
  out.push("");

  // Headline stats at both levels.
  const pageRunCount = new Map<string, number>();
  for (const r of runs) for (const u of r.read) pageRunCount.set(u, (pageRunCount.get(u) ?? 0) + 1);
  const domainRunCount = new Map<string, number>();
  for (const r of runs) for (const dn of r.domains) domainRunCount.set(dn, (domainRunCount.get(dn) ?? 0) + 1);
  const pct = (only: number, total: number) =>
    total > 0 ? Math.round((only / total) * 100) : 0;
  const distinctPages = pageRunCount.size;
  const distinctDomains = domainRunCount.size;
  const pagesSolo = [...pageRunCount.values()].filter((n) => n === 1).length;
  const domainsSolo = [...domainRunCount.values()].filter((n) => n === 1).length;

  // --- Runs table -----------------------------------------------------------
  out.push("## Runs");
  out.push("");
  out.push(
    "| Key | Query | Status | Pages | Domains | Cited | Opened | Unique pages | Unique domains |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    let uPages = 0;
    for (const u of r.read) if (pageRunCount.get(u) === 1) uPages++;
    let uDomains = 0;
    for (const dn of r.domains) if (domainRunCount.get(dn) === 1) uDomains++;
    out.push(
      `| ${r.key} | ${cell(clip(r.run.query || "(empty)", 70))} | ` +
        `${cell(r.run.status)} | ${r.read.size} | ${r.domains.size} | ` +
        `${r.d.citedUrls.size} | ${r.d.openedUrls.size} | ${uPages} | ${uDomains} |`,
    );
  }
  out.push("");
  out.push(
    `Across **${distinctPages} distinct pages** / **${distinctDomains} distinct ` +
      `domains**: **${pct(pagesSolo, distinctPages)}%** of pages and ` +
      `**${pct(domainsSolo, distinctDomains)}%** of domains were read by only one ` +
      `run. Domain overlap is the truer signal — exact-URL overlap is near-zero ` +
      `by nature.`,
  );
  out.push("");

  // --- Overlap matrices -----------------------------------------------------
  out.push("## Overlap");
  out.push("");
  out.push("**Shared pages** (exact URL)");
  out.push("");
  out.push(...matrix(runs, pageSets));
  out.push("");
  out.push("**Shared domains**");
  out.push("");
  out.push(...matrix(runs, domainSets));
  out.push("");

  // --- Named shares per pair ------------------------------------------------
  // The actionable part: not just *how many* overlap, but *which* — most
  // connected pairs first.
  out.push("## What each pair shares");
  out.push("");
  type Pair = { a: Prepared; b: Prepared; domains: string[]; pages: string[] };
  const pairs: Pair[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      pairs.push({
        a: runs[i],
        b: runs[j],
        domains: intersect(domainSets[i], domainSets[j]).sort(),
        pages: intersect(pageSets[i], pageSets[j]),
      });
    }
  }
  pairs.sort((x, y) => y.domains.length - x.domains.length);
  for (const p of pairs) {
    out.push(`### ${p.a.key} ↔ ${p.b.key}`);
    out.push("");
    if (p.domains.length === 0) {
      out.push(
        `_No shared domains — these two researched fully disjoint corners of the web._`,
      );
      out.push("");
      continue;
    }
    out.push(
      `**${p.domains.length} shared domain${p.domains.length === 1 ? "" : "s"}:** ` +
        p.domains.slice(0, MAX_LISTED).join(", ") +
        (p.domains.length > MAX_LISTED ? `, +${p.domains.length - MAX_LISTED} more` : ""),
    );
    out.push("");
    if (p.pages.length === 0) {
      out.push(
        "_Shared at the domain level only — no identical pages (each read a different page on those sites)._",
      );
    } else {
      out.push(
        `**${p.pages.length} identical page${p.pages.length === 1 ? "" : "s"}:**`,
      );
      for (const u of p.pages.slice(0, MAX_LISTED)) out.push(`- ${pageLink(u)}`);
      if (p.pages.length > MAX_LISTED)
        out.push(`- _+${p.pages.length - MAX_LISTED} more_`);
    }
    out.push("");
  }

  // --- Isolate (both levels) ------------------------------------------------
  out.push("## Isolate");
  out.push("");
  const peerCount = runs.length - 1;
  const pageIso = findIsolate(runs, pageSets);
  const domainIso = findIsolate(runs, domainSets);
  const describe = (
    iso: ReturnType<typeof findIsolate>,
    level: "page" | "domain",
  ) => {
    if (iso.peersShared === 0) {
      return (
        `**Run ${iso.r.key}** shares **zero ${level}s** with the other ` +
        `${peerCount} run${peerCount === 1 ? "" : "s"} — a fully sealed-off ` +
        `corner of the web at the ${level} level.`
      );
    }
    return (
      `**Run ${iso.r.key}** overlaps least — shares ${level}s with only ` +
      `**${iso.peersShared} of ${peerCount}** other run${peerCount === 1 ? "" : "s"} ` +
      `(${iso.totalShared} total ${level}-overlaps).`
    );
  };
  out.push(`- By domain: ${describe(domainIso, "domain")}`);
  out.push(`- By page: ${describe(pageIso, "page")}`);
  out.push("");
  if (domainIso.r.key === pageIso.r.key) {
    out.push(
      `Run **${domainIso.r.key}** is the isolate on both measures — the role ` +
        `whose research is hardest to reach by accident. Query: ` +
        `_${cell(clip(domainIso.r.run.query || "(empty)", 200))}_`,
    );
  } else {
    out.push(
      `The domain-level isolate (**${domainIso.r.key}**) is the one that ` +
        `matters for content placement. Query: ` +
        `_${cell(clip(domainIso.r.run.query || "(empty)", 200))}_`,
    );
  }
  out.push("");

  // --- Per-run footprint ----------------------------------------------------
  // Each run's whole research territory: every domain it touched (consulted +
  // cited) with page counts, ✓ marking domains that contributed a citation —
  // plus the quick cited-only list called out separately.
  out.push("## Research footprint per run");
  out.push("");
  out.push(
    "_Every domain the run touched, by pages read (✓ = contributed a citation). " +
      "The **Cited** line is the quick list of what actually shaped the answer._",
  );
  out.push("");
  for (const r of runs) {
    out.push(`### ${r.key} — ${clip(r.run.query || "(empty)", 80)}`);
    out.push("");
    const citedDomains = domainsOf(r.d.citedUrls);
    const citedList = domainCounts(r.d.citedUrls);
    out.push(
      `**Cited:** ` +
        (citedList.length
          ? citedList.map(([d, n]) => `${d}${n > 1 ? ` (${n})` : ""}`).join(", ")
          : "_none_"),
    );
    out.push("");
    const footprint = domainCounts(r.read);
    out.push(
      `**Footprint** — ${footprint.length} domain${footprint.length === 1 ? "" : "s"} across ${r.read.size} pages:`,
    );
    for (const [dom, n] of footprint.slice(0, MAX_LISTED * 2)) {
      const mark = citedDomains.has(dom) ? " ✓" : "";
      out.push(`- ${dom}${n > 1 ? ` (${n})` : ""}${mark}`);
    }
    if (footprint.length > MAX_LISTED * 2)
      out.push(`- _+${footprint.length - MAX_LISTED * 2} more_`);
    out.push("");
  }

  // --- Opened pages per run -------------------------------------------------
  // Pages the model demonstrably opened (Open / find-in-page actions) — read in
  // full, not just surfaced. The strongest signal of deliberate attention.
  out.push("## Opened pages per run");
  out.push("");
  out.push(
    "_Pages the model actually opened and read in full (not just surfaced in " +
      "search results). ✓ marks ones it then cited._",
  );
  out.push("");
  for (const r of runs) {
    out.push(`### ${r.key} — ${clip(r.run.query || "(empty)", 80)}`);
    out.push("");
    const opened = [...r.d.openedUrls].sort(
      (a, b) =>
        hostOf(a).localeCompare(hostOf(b)) || pathOf(a).localeCompare(pathOf(b)),
    );
    if (opened.length === 0) {
      out.push("_None opened — every source merely surfaced in search results._");
    } else {
      for (const u of opened) {
        const info = titleByUrl.get(u) ?? { url: u, title: u };
        const title = (info.title || info.url).replace(/[\[\]]/g, "");
        const citedMark = r.d.citedUrls.has(u) ? " ✓" : "";
        out.push(
          `- [${clip(title, 90)}](${info.url}) — ${domain(info.url)}${citedMark}`,
        );
      }
    }
    out.push("");
  }

  // --- All read URLs (spreadsheet grid) -------------------------------------
  // Every distinct page any run read (cited or consulted), one row each, sorted
  // by domain → host (subdomain) → path, with a column per run marking
  // ✓ cited / • consulted. Meant to be dropped into a spreadsheet.
  const allUrls = new Set<string>();
  for (const r of runs) for (const u of r.read) allUrls.add(u);
  const urlRows = [...allUrls]
    .map((u) => {
      const host = hostOf(u);
      return { u, host, reg: registrable(host), sub: subOf(host), path: pathOf(u) };
    })
    .sort(
      (a, b) =>
        a.reg.localeCompare(b.reg) ||
        a.host.localeCompare(b.host) ||
        a.path.localeCompare(b.path),
    );

  out.push(`## All read URLs (${urlRows.length})`);
  out.push("");
  out.push(
    "_Every page any run read, sorted by domain → subdomain → path. " +
      "✓ = cited · ◆ = opened (read in full) · • = consulted (surfaced only)._",
  );
  out.push("");
  out.push(
    `| Domain | Subdomain | Path | ${runs.map((r) => r.key).join(" | ")} | URL |`,
  );
  out.push(
    `| --- | --- | --- | ${runs.map(() => ":-:").join(" | ")} | --- |`,
  );
  for (const row of urlRows) {
    const marks = runs.map((r) =>
      r.d.citedUrls.has(row.u)
        ? "✓"
        : r.d.openedUrls.has(row.u)
          ? "◆"
          : r.read.has(row.u)
            ? "•"
            : "",
    );
    const display = titleByUrl.get(row.u)?.url ?? row.u;
    out.push(
      `| ${cell(row.reg)} | ${cell(row.sub || "—")} | ${cell(row.path)} | ` +
        `${marks.join(" | ")} | ${cell(display)} |`,
    );
  }
  out.push("");

  // --- Outputs per run ------------------------------------------------------
  // The full prompt and the model's answer for each run, so the conclusions can
  // be compared against the sources/overlap above. Answers are already Markdown
  // and emitted verbatim.
  out.push("## Outputs per run");
  out.push("");
  out.push(
    "_The prompt and the model's answer for each run — compare what each role " +
      "was asked, what it concluded, and how that tracks with the sources above._",
  );
  out.push("");
  for (const r of runs) {
    out.push(`### ${r.key} — ${clip(r.run.query || "(empty)", 80)}`);
    out.push("");
    out.push("**Prompt:**");
    out.push("");
    out.push(blockquote(r.run.query || "(empty)"));
    out.push("");
    out.push("**Answer:**");
    out.push("");
    out.push(r.d.answer.trim() || "_No answer._");
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "\n");
}

// Prefix every line so multi-line text renders as one Markdown blockquote.
function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

// Distinct, meaningful download name for a comparison: a slug from the first
// run's prompt + the run count + each run's short id, so different selections
// (and different decisions) don't all collide on one filename.
export function compareFilename(
  runs: { id: string; query: string }[],
): string {
  const slug =
    (runs[0]?.query ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "runs";
  const ids = runs.map((r) => r.id.slice(0, 4)).join("-").slice(0, 40);
  return `compare-${slug}-${runs.length}runs-${ids}.md`;
}
