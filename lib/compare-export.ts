// Pure serialization of N runs into a single Markdown comparison document,
// meant to be pasted into an LLM (the same workflow as the per-run export).
//
// Answers three questions about a set of runs of the *same* decision researched
// from different angles:
//   1. Which pages do the runs share, and which are unique to each?  (overlap)
//   2. Which run researches in the most sealed-off corner of the web?  (isolate)
//   3. What did each run actually cite, by domain?  (cited domains)
//
// "Read" for a run = the pages it Cited ∪ the pages it Consulted (surfaced in
// search results), deduped by the shared normalizeUrl (tracking params stripped)
// so the same page isn't counted twice. No I/O here — the route reads the DB.

import { deriveRunState, domain, type DerivedRunState } from "@/lib/derive";
import type { StreamEvent } from "@/lib/events";
import type { RunRow } from "@/lib/markdown-export";

export type CompareInput = { run: RunRow; events: StreamEvent[] };

type Prepared = {
  key: string; // A, B, C, …
  run: RunRow;
  d: DerivedRunState;
  read: Set<string>; // cited ∪ consulted, normalized
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

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

function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (large.has(x)) n++;
  return n;
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

export function runsToCompareMarkdown(inputs: CompareInput[]): string {
  const runs: Prepared[] = inputs.map((inp, i) => {
    const d = deriveRunState(inp.events);
    const read = new Set<string>([...d.consultedUrls, ...d.citedUrls]);
    return { key: keyFor(i), run: inp.run, d, read };
  });

  const out: string[] = [];
  out.push("# Thinking Inspector — Run Comparison");
  out.push("");
  out.push(
    `Comparing **${runs.length} runs**. "Pages read" for a run = pages it ` +
      "**cited** plus pages **consulted** (surfaced in its search results), " +
      "deduped after stripping tracking parameters. Overlap counts shared " +
      "*distinct pages* between runs.",
  );
  out.push("");
  out.push(
    "> Caveat: most consulted pages *surfaced* in search results; only pages " +
      "reached via an explicit Open action were demonstrably read in full. " +
      "Overlap below is measured over surfaced-or-cited pages.",
  );
  out.push("");

  // Union of every run's read pages, and how many runs each page appears in.
  const pageRunCount = new Map<string, number>();
  for (const r of runs) {
    for (const u of r.read) {
      pageRunCount.set(u, (pageRunCount.get(u) ?? 0) + 1);
    }
  }
  const totalDistinctPages = pageRunCount.size;
  let sharedByMultiple = 0;
  for (const n of pageRunCount.values()) if (n > 1) sharedByMultiple++;
  const uniquePct =
    totalDistinctPages > 0
      ? Math.round(
          ((totalDistinctPages - sharedByMultiple) / totalDistinctPages) * 100,
        )
      : 0;

  // --- Runs table -----------------------------------------------------------
  out.push("## Runs");
  out.push("");
  out.push("| Key | Query | Status | Pages read | Cited | Opened | Unique |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    let unique = 0;
    for (const u of r.read) if (pageRunCount.get(u) === 1) unique++;
    out.push(
      `| ${r.key} | ${cell(clip(r.run.query || "(empty)", 70))} | ` +
        `${cell(r.run.status)} | ${r.read.size} | ${r.d.citedUrls.size} | ` +
        `${r.d.openedUrls.size} | ${unique} |`,
    );
  }
  out.push("");
  out.push(
    `Across **${totalDistinctPages} distinct pages**, **${uniquePct}%** were ` +
      `read by only one run (${totalDistinctPages - sharedByMultiple} of ` +
      `${totalDistinctPages}); ${sharedByMultiple} were shared by two or more.`,
  );
  out.push("");

  // --- Pairwise shared-page matrix -----------------------------------------
  out.push("## Pairwise shared pages");
  out.push("");
  out.push(`|  | ${runs.map((r) => r.key).join(" | ")} |`);
  out.push(`| --- | ${runs.map(() => "---").join(" | ")} |`);
  // Precompute the symmetric overlap matrix.
  const overlap: number[][] = runs.map(() => runs.map(() => 0));
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const n = intersectionSize(runs[i].read, runs[j].read);
      overlap[i][j] = n;
      overlap[j][i] = n;
    }
  }
  for (let i = 0; i < runs.length; i++) {
    const cells = runs.map((_, j) => (i === j ? "—" : String(overlap[i][j])));
    out.push(`| ${runs[i].key} | ${cells.join(" | ")} |`);
  }
  out.push("");

  // --- Isolate --------------------------------------------------------------
  // The run whose research overlaps least with the rest: fewest peers shared
  // with, tie-broken by fewest total shared pages.
  const stats = runs.map((r, i) => {
    let peersShared = 0;
    let totalShared = 0;
    for (let j = 0; j < runs.length; j++) {
      if (j === i) continue;
      if (overlap[i][j] > 0) peersShared++;
      totalShared += overlap[i][j];
    }
    return { r, peersShared, totalShared };
  });
  const isolate = stats.reduce((best, s) =>
    s.peersShared < best.peersShared ||
    (s.peersShared === best.peersShared && s.totalShared < best.totalShared)
      ? s
      : best,
  );
  out.push("## Isolate");
  out.push("");
  const peerCount = runs.length - 1;
  if (isolate.peersShared === 0) {
    out.push(
      `**Run ${isolate.r.key}** is fully isolated — it shares **zero pages** ` +
        `with the other ${peerCount} run${peerCount === 1 ? "" : "s"}. ` +
        "Researching this angle, the model drew on a completely separate " +
        "corner of the web; nothing reaches it by accident from the others.",
    );
  } else {
    out.push(
      `**Run ${isolate.r.key}** overlaps least — it shares pages with only ` +
        `**${isolate.peersShared} of ${peerCount}** other run` +
        `${peerCount === 1 ? "" : "s"} (${isolate.totalShared} shared ` +
        "page-overlaps total). It researches in the most sealed-off corner " +
        "of the web among these runs.",
    );
  }
  out.push("");
  out.push(`> Query ${isolate.r.key}: ${cell(clip(isolate.r.run.query || "(empty)", 200))}`);
  out.push("");

  // --- Per-run cited domains ------------------------------------------------
  out.push("## Cited domains per run");
  out.push("");
  out.push(
    "_Domains the run actually cited in its answer, separate from everything " +
      "it merely consulted._",
  );
  out.push("");
  for (const r of runs) {
    out.push(`### ${r.key} — ${clip(r.run.query || "(empty)", 80)}`);
    out.push("");
    const doms = domainCounts(r.d.citedUrls);
    if (doms.length === 0) {
      out.push("_No cited sources._");
    } else {
      for (const [dom, n] of doms) {
        out.push(`- ${dom}${n > 1 ? ` (${n})` : ""}`);
      }
    }
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "\n");
}
