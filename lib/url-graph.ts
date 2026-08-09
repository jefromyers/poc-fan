// Read-URL graph (Phase 1 of Garrett's comparison dev-request) — SERVER-ONLY.
//
// One row per distinct READ url across a comparison group, with frequencies at
// every resolution (exact url / folder / subdomain / registrable domain), a
// site_type + weight, a high_volume flag, a cited flag, and which roles read it.
//
// Pure (no I/O): takes CompareInput[] and returns the graph + CSV/JSON/Markdown.
// Reuses deriveRunState. Imports `tldts` (Public Suffix List) for correct eTLD+1.
// Deliberately NOT imported by client code or by derive.ts, so the PSL never
// reaches the browser bundle. Its own graph-local URL normalization (graphNorm)
// is isolated here — the shared normalizeUrl / existing Compare are untouched.

import { parse as tldParse } from "tldts";
import { deriveRunState, searchQueries } from "@/lib/derive";
import type { CompareInput } from "@/lib/compare-export";
import {
  AUTO_FLAG,
  PROFILE_VERSION,
  resolveProfile,
  type SiteProfile,
} from "@/lib/site-profiles";

export type PerRole = { role: string; cited: boolean; opened: boolean };

export type GraphRow = {
  url: string;
  runs_read: number;
  total_reads: number; // == runs_read today (per-run dedup; see header note in MD)
  subdomain: string; // full host (www stripped)
  subdomain_freq: number;
  folder: string; // host + first N segments, or the url for page-level sites
  folder_freq: number;
  registrable_domain: string; // eTLD+1 via PSL
  domain_freq: number;
  site_type: string;
  weight: number; // STORED, never a filter
  high_volume_flag: boolean;
  flag_source: "profile" | "auto" | null;
  cited_any: boolean;
  opened_any: boolean;
  per_role: PerRole[];
};

export type RoleLegendEntry = { role: string; run_id: string; query: string; model: string };

export type QueryFanoutAction = {
  index: number;
  type: string;
  status: string;
  queries: string[];
  url?: string;
  pattern?: string;
  source_count?: number;
};

export type QueryFanoutEntry = {
  role: string;
  run_id: string;
  query: string;
  model: string;
  actions: QueryFanoutAction[];
  search_queries: string[];
};

export type ReadUrlGraph = {
  profileVersion: string;
  generatedAt: string;
  runCount: number;
  rowCount: number;
  roleLegend: RoleLegendEntry[];
  queryFanout: QueryFanoutEntry[];
  rows: GraphRow[];
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const keyFor = (i: number) => LETTERS[i] ?? `#${i + 1}`;

// Graph-local extra tracking params, stripped ON TOP of the already-normalized
// URL. Kept here (not in the shared normalizeUrl) so existing Compare is unchanged.
const EXTRA_TRACKING = new Set(["trk", "attachment", "openai"]);

// Normalize a (already-normalized) URL further for the graph: drop the fragment
// and a few more tracking params, re-sort. Same input → same key, so per-run and
// cross-run counts stay internally consistent.
function graphNorm(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      const k = key.toLowerCase();
      const v = (u.searchParams.get(key) ?? "").toLowerCase();
      if (
        EXTRA_TRACKING.has(k) ||
        ((k === "ref" || k === "ref_") && (v.includes("openai") || v.includes("chatgpt")))
      ) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}

// Full host, lowercased, leading www. stripped (www treated as apex).
function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function pathSegments(u: string): string[] {
  try {
    return new URL(u).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function folderOf(u: string, host: string, profile: SiteProfile): string {
  if (profile.page_level) return u; // each URL its own unit
  const segs = pathSegments(u).slice(0, Math.max(0, profile.folder_depth));
  return segs.length ? `${host}/${segs.join("/")}` : host;
}

type Accum = {
  url: string;
  host: string;
  registrable: string;
  perRole: PerRole[]; // one entry per run that read it (input order)
  citedAny: boolean;
  openedAny: boolean;
};

export function buildReadUrlGraph(
  inputs: CompareInput[],
  opts: { generatedAt: string },
): ReadUrlGraph {
  const roleLegend: RoleLegendEntry[] = [];
  const queryFanout: QueryFanoutEntry[] = [];

  // Per-run read/opened/cited sets, graph-normalized.
  const runs = inputs.map((inp, i) => {
    const role = keyFor(i);
    const d = deriveRunState(inp.events);
    const read = new Set<string>();
    for (const u of [...d.consultedUrls, ...d.openedUrls, ...d.citedUrls]) {
      read.add(graphNorm(u));
    }
    const cited = new Set<string>();
    for (const u of d.citedUrls) cited.add(graphNorm(u));
    const opened = new Set<string>();
    for (const u of d.openedUrls) opened.add(graphNorm(u));
    roleLegend.push({
      role,
      run_id: inp.run.id,
      query: inp.run.query ?? "", // full prompt — never truncated
      model: inp.run.model,
    });
    const actions = d.fanouts.map((f, index) => {
      const queries = f.action?.type === "search" && f.action ? searchQueries(f.action) : [];
      return {
        index: index + 1,
        type: f.action?.type ?? "unknown",
        status: f.status,
        queries,
        url: f.action?.url,
        pattern: f.action?.pattern,
        source_count: Array.isArray(f.action?.sources) ? f.action.sources.length : undefined,
      };
    });
    queryFanout.push({
      role,
      run_id: inp.run.id,
      query: inp.run.query ?? "",
      model: inp.run.model,
      actions,
      search_queries: actions.flatMap((a) => a.queries),
    });
    return { role, read, cited, opened };
  });

  // Pass A: accumulate per distinct url across the group.
  const hostCache = new Map<string, string>();
  const acc = new Map<string, Accum>();
  for (const r of runs) {
    for (const url of r.read) {
      let a = acc.get(url);
      if (!a) {
        const host = hostOf(url);
        let registrable = hostCache.get(host);
        if (registrable === undefined) {
          registrable = tldParse(host).domain ?? host;
          hostCache.set(host, registrable);
        }
        a = {
          url,
          host,
          registrable,
          perRole: [],
          citedAny: false,
          openedAny: false,
        };
        acc.set(url, a);
      }
      const cited = r.cited.has(url);
      const opened = r.opened.has(url);
      a.perRole.push({ role: r.role, cited, opened });
      if (cited) a.citedAny = true;
      if (opened) a.openedAny = true;
    }
  }

  const all = [...acc.values()];

  // Pass B: per-registrable corpus stats (for the auto-flag heuristic).
  const domDistinct = new Map<string, number>();
  const domReads = new Map<string, number>();
  for (const a of all) {
    domDistinct.set(a.registrable, (domDistinct.get(a.registrable) ?? 0) + 1);
    domReads.set(a.registrable, (domReads.get(a.registrable) ?? 0) + a.perRole.length);
  }
  const autoFlagged = new Set<string>();
  for (const [dom, distinct] of domDistinct) {
    const mean = (domReads.get(dom) ?? 0) / distinct;
    if (distinct > AUTO_FLAG.minDistinctUrls && mean < AUTO_FLAG.maxMeanReadsPerUrl) {
      autoFlagged.add(dom);
    }
  }

  // Pass C: resolve final profile + folder per url.
  type Resolved = Accum & {
    profile: SiteProfile;
    site_type: string;
    weight: number;
    high_volume_flag: boolean;
    flag_source: "profile" | "auto" | null;
    folder: string;
  };
  const resolved: Resolved[] = all.map((a) => {
    const base = resolveProfile(a.host, a.registrable);
    let profile = base;
    let site_type = base.site_type;
    let flag_source: "profile" | "auto" | null = base.high_volume ? "profile" : null;
    // Auto-flag only when no explicit (non-default) profile matched.
    if (base.site_type === "default" && autoFlagged.has(a.registrable)) {
      profile = { ...base, weight: 0.2, page_level: true, high_volume: true };
      site_type = "hub/scraper (auto)";
      flag_source = "auto";
    }
    return {
      ...a,
      profile,
      site_type,
      weight: profile.weight,
      high_volume_flag: profile.high_volume,
      flag_source,
      folder: folderOf(a.url, a.host, profile),
    };
  });

  // Pass D: frequencies (distinct-url counts) at each resolution.
  const subFreq = new Map<string, number>();
  const domFreq = new Map<string, number>();
  const folderFreq = new Map<string, number>();
  for (const r of resolved) {
    subFreq.set(r.host, (subFreq.get(r.host) ?? 0) + 1);
    domFreq.set(r.registrable, (domFreq.get(r.registrable) ?? 0) + 1);
    folderFreq.set(r.folder, (folderFreq.get(r.folder) ?? 0) + 1);
  }

  const rows: GraphRow[] = resolved.map((r) => ({
    url: r.url,
    runs_read: r.perRole.length,
    total_reads: r.perRole.length,
    subdomain: r.host,
    subdomain_freq: subFreq.get(r.host) ?? 1,
    folder: r.folder,
    folder_freq: folderFreq.get(r.folder) ?? 1,
    registrable_domain: r.registrable,
    domain_freq: domFreq.get(r.registrable) ?? 1,
    site_type: r.site_type,
    weight: r.weight,
    high_volume_flag: r.high_volume_flag,
    flag_source: r.flag_source,
    cited_any: r.citedAny,
    opened_any: r.openedAny,
    per_role: r.perRole,
  }));

  // Default sort: domain_freq desc, folder_freq desc, then stable tie-breakers.
  rows.sort(
    (a, b) =>
      b.domain_freq - a.domain_freq ||
      b.folder_freq - a.folder_freq ||
      a.registrable_domain.localeCompare(b.registrable_domain) ||
      a.subdomain.localeCompare(b.subdomain) ||
      a.url.localeCompare(b.url),
  );

  return {
    profileVersion: PROFILE_VERSION,
    generatedAt: opts.generatedAt,
    runCount: inputs.length,
    rowCount: rows.length,
    roleLegend,
    queryFanout,
    rows,
  };
}

// ---- serializers ----------------------------------------------------------

// Prefix every line so a multi-line prompt renders as one Markdown blockquote.
function blockquote(text: string): string {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

// RFC-4180 CSV cell: quote if it contains comma, quote, CR or LF; double quotes.
function csv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const CSV_HEADER = [
  "url",
  "runs_read",
  "total_reads",
  "subdomain",
  "subdomain_freq",
  "folder",
  "folder_freq",
  "registrable_domain",
  "domain_freq",
  "site_type",
  "weight",
  "high_volume_flag",
  "flag_source",
  "cited_any",
  "per_role",
];

export function graphToCsv(g: ReadUrlGraph): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of g.rows) {
    lines.push(
      [
        csv(r.url),
        String(r.runs_read),
        String(r.total_reads),
        csv(r.subdomain),
        String(r.subdomain_freq),
        csv(r.folder),
        String(r.folder_freq),
        csv(r.registrable_domain),
        String(r.domain_freq),
        csv(r.site_type),
        String(r.weight),
        String(r.high_volume_flag),
        r.flag_source ?? "",
        String(r.cited_any),
        csv(JSON.stringify(r.per_role)),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

const FANOUT_CSV_HEADER = [
  "role",
  "run_id",
  "model",
  "prompt",
  "action_index",
  "action_type",
  "status",
  "queries",
  "url",
  "pattern",
  "source_count",
];

export function graphFanoutToCsv(g: ReadUrlGraph): string {
  const lines = [FANOUT_CSV_HEADER.join(",")];
  for (const entry of g.queryFanout) {
    for (const action of entry.actions) {
      lines.push(
        [
          csv(entry.role),
          csv(entry.run_id),
          csv(entry.model),
          csv(entry.query),
          String(action.index),
          csv(action.type),
          csv(action.status),
          csv(JSON.stringify(action.queries)),
          csv(action.url ?? ""),
          csv(action.pattern ?? ""),
          action.source_count == null ? "" : String(action.source_count),
        ].join(","),
      );
    }
    if (entry.actions.length === 0) {
      lines.push(
        [
          csv(entry.role),
          csv(entry.run_id),
          csv(entry.model),
          csv(entry.query),
          "",
          "",
          "",
          "[]",
          "",
          "",
          "",
        ].join(","),
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

export function graphToJson(g: ReadUrlGraph): string {
  return JSON.stringify(g, null, 2);
}

// Markdown cell: pipes/newlines break tables.
function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function graphToMarkdown(g: ReadUrlGraph): string {
  const out: string[] = [];
  out.push("# Read-URL Graph");
  out.push("");
  out.push(
    `Comparing **${g.runCount} runs** · **${g.rowCount} distinct read URLs** · ` +
      `profile \`${g.profileVersion}\` · generated ${g.generatedAt}`,
  );
  out.push("");
  out.push(
    "> One row per distinct page any run read (consulted ∪ opened ∪ cited). " +
      "`weight` is informational, never a filter. `total_reads` = `runs_read` " +
      "(a page is read 0/1× per run after dedup). Roles below: `✓` = that role cited it.",
  );
  out.push("");
  out.push("## Roles");
  out.push("");
  for (const e of g.roleLegend) {
    out.push(`### ${e.role} — _${mdCell(e.model)}, ${e.run_id.slice(0, 8)}_`);
    out.push("");
    // Full prompt, verbatim — never truncated.
    out.push(blockquote(e.query || "(empty)"));
    out.push("");
  }
  out.push("## Query fan-out");
  out.push("");
  out.push(
    "_Every web-search action each role issued, in order. This shows how the " +
      "model framed its research before sources entered the URL graph._",
  );
  out.push("");
  for (const e of g.queryFanout) {
    out.push(`### ${e.role} — _${mdCell(e.model)}, ${e.run_id.slice(0, 8)}_`);
    out.push("");
    if (e.actions.length === 0) {
      out.push("_No web-search actions recorded._");
      out.push("");
      continue;
    }
    for (const action of e.actions) {
      const label = action.type === "search" ? "Search" : action.type;
      out.push(`**${action.index}. ${mdCell(label)}** — ${mdCell(action.status)}`);
      if (action.queries.length > 0) {
        action.queries.forEach((q, i) =>
          out.push(`${i + 1}. ${q.replace(/\r?\n/g, " ").trim()}`),
        );
      } else if (action.url) {
        out.push(`- ${action.url}`);
      } else if (action.pattern) {
        out.push(`- ${action.pattern}`);
      }
      if (action.source_count != null) out.push(`- surfaced sources: ${action.source_count}`);
      out.push("");
    }
  }
  out.push("## URLs");
  out.push("");
  out.push(
    "| Domain | dom_freq | Subdomain | sub_freq | Folder | fld_freq | site_type | wt | hv | Roles | URL |",
  );
  out.push("| --- | --: | --- | --: | --- | --: | --- | --: | :-: | --- | --- |");
  for (const r of g.rows) {
    const roles = r.per_role
      .map((p) => `${p.role}${p.cited ? "✓" : ""}`)
      .join(" ");
    const hv = r.high_volume_flag ? (r.flag_source === "auto" ? "◆auto" : "◆") : "";
    out.push(
      `| ${mdCell(r.registrable_domain)} | ${r.domain_freq} | ${mdCell(r.subdomain)} | ${r.subdomain_freq} | ` +
        `${mdCell(r.folder)} | ${r.folder_freq} | ${mdCell(r.site_type)} | ${r.weight} | ${hv} | ` +
        `${mdCell(roles)} | ${mdCell(r.url)} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

// Download base name (no extension): deep-compare-<slug>-<n>runs-<ids>.
export function deepCompareFilename(runs: { id: string; query: string }[]): string {
  const slug =
    (runs[0]?.query ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "runs";
  const ids = runs.map((r) => r.id.slice(0, 4)).join("-").slice(0, 40);
  return `deep-compare-${slug}-${runs.length}runs-${ids}`;
}
