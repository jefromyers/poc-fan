import { buildCompactCompare } from "@/lib/compact-compare";
import { initDb, pool } from "@/lib/db";
import { deriveRunState, domain, normalizeUrl } from "@/lib/derive";
import type { StreamEvent } from "@/lib/events";
import type { CompareInput } from "@/lib/compare-export";
import type { RunRow } from "@/lib/markdown-export";
import {
  buildReadUrlGraph,
  type GraphRow,
  type ReadUrlGraph,
} from "@/lib/url-graph";

type PullInclude = "summary" | "outputs" | "query_fanout" | "compact" | "read_urls" | "overlap";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const keyFor = (i: number) => LETTERS[i] ?? `#${i + 1}`;

function envInt(name: string, fallback: number) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pageRows(rows: GraphRow[], limit: number, offset: number) {
  return rows.slice(offset, offset + limit);
}

async function loadRuns(runIds: string[]) {
  const runsResult = await pool.query(
    `SELECT id, model, query, effort, status, created_at, usage, error
     FROM runs WHERE id = ANY($1::uuid[])`,
    [runIds],
  );
  const byId = new Map<string, RunRow>(
    runsResult.rows.map((row) => [row.id as string, row as RunRow]),
  );

  const eventsResult = await pool.query(
    `SELECT run_id, payload FROM events
     WHERE run_id = ANY($1::uuid[])
     ORDER BY run_id, seq ASC, id ASC`,
    [runIds],
  );
  const eventsByRun = new Map<string, StreamEvent[]>();
  for (const row of eventsResult.rows) {
    const list = eventsByRun.get(row.run_id) ?? [];
    list.push(row.payload as StreamEvent);
    eventsByRun.set(row.run_id, list);
  }

  return runIds
    .map((id, i) => {
      const run = byId.get(id);
      if (!run) return null;
      return {
        role: keyFor(i),
        run,
        events: eventsByRun.get(id) ?? [],
      };
    })
    .filter((item): item is { role: string; run: RunRow; events: StreamEvent[] } =>
      Boolean(item),
    );
}

function roleOutputs(prepared: Awaited<ReturnType<typeof loadRuns>>) {
  return prepared.map((p) => {
    const d = deriveRunState(p.events);
    const read = new Set<string>([...d.consultedUrls, ...d.openedUrls, ...d.citedUrls]);
    const domains = new Set<string>();
    for (const url of read) domains.add(domain(url));
    return {
      role: p.role,
      run_id: p.run.id,
      query: p.run.query,
      model: p.run.model,
      effort: p.run.effort,
      status: p.run.status,
      created_at: p.run.created_at,
      usage: p.run.usage,
      error: p.run.error,
      counts: {
        pages: read.size,
        domains: domains.size,
        cited: d.citedUrls.size,
        opened: d.openedUrls.size,
        consulted: d.consultedUrls.size,
        actions: d.fanouts.length,
        citations: d.citationCount,
      },
      output: d.answer,
    };
  });
}

function relabelGraph(graph: ReadUrlGraph, roles: string[]): ReadUrlGraph {
  const labelMap = new Map<string, string>();
  graph.roleLegend.forEach((entry, index) => {
    labelMap.set(entry.role, roles[index] ?? entry.role);
  });
  return {
    ...graph,
    roleLegend: graph.roleLegend.map((entry, index) => ({
      ...entry,
      role: roles[index] ?? entry.role,
    })),
    queryFanout: graph.queryFanout.map((entry) => ({
      ...entry,
      role: labelMap.get(entry.role) ?? entry.role,
    })),
    rows: graph.rows.map((row) => ({
      ...row,
      per_role: row.per_role.map((p) => ({ ...p, role: labelMap.get(p.role) ?? p.role })),
    })),
  };
}

function intersect(a: Set<string>, b: Set<string>) {
  const out: string[] = [];
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) out.push(item);
  return out.sort();
}

function buildOverlap(prepared: Awaited<ReturnType<typeof loadRuns>>) {
  const derived = prepared.map((p) => {
    const d = deriveRunState(p.events);
    const pages = new Set<string>();
    for (const url of [...d.consultedUrls, ...d.openedUrls, ...d.citedUrls]) {
      pages.add(normalizeUrl(url));
    }
    const domains = new Set<string>();
    for (const page of pages) domains.add(domain(page));
    return { role: p.role, pages, domains };
  });

  const shared_pages: Record<string, Record<string, number>> = {};
  const shared_domains: Record<string, Record<string, number>> = {};
  const pairs: { a: string; b: string; shared_pages: string[]; shared_domains: string[] }[] = [];

  for (const a of derived) {
    shared_pages[a.role] = {};
    shared_domains[a.role] = {};
    for (const b of derived) {
      shared_pages[a.role][b.role] = a.role === b.role ? 0 : intersect(a.pages, b.pages).length;
      shared_domains[a.role][b.role] =
        a.role === b.role ? 0 : intersect(a.domains, b.domains).length;
    }
  }
  for (let i = 0; i < derived.length; i++) {
    for (let j = i + 1; j < derived.length; j++) {
      pairs.push({
        a: derived[i].role,
        b: derived[j].role,
        shared_pages: intersect(derived[i].pages, derived[j].pages),
        shared_domains: intersect(derived[i].domains, derived[j].domains),
      });
    }
  }
  return { shared_pages, shared_domains, pairs };
}

export async function listRunsForPull(args: {
  limit?: number;
  before?: string;
  search?: string;
  status?: string;
}) {
  await initDb();
  const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 20)));
  const params: unknown[] = [];
  const where: string[] = [];

  if (args.before) {
    params.push(args.before);
    where.push(`created_at < $${params.length}::timestamptz`);
  }
  if (args.search?.trim()) {
    params.push(`%${args.search.trim()}%`);
    where.push(`query ILIKE $${params.length}`);
  }
  if (args.status?.trim()) {
    params.push(args.status.trim());
    where.push(`status = $${params.length}`);
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, model, effort, status, created_at, query, left(query, 160) AS query_preview
     FROM runs
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return {
    runs: rows.map((row) => ({
      run_id: row.id,
      model: row.model,
      effort: row.effort,
      status: row.status,
      created_at: new Date(row.created_at).toISOString(),
      query: row.query,
      query_preview: row.query_preview,
    })),
    nextBefore: rows.length ? new Date(rows[rows.length - 1].created_at).toISOString() : null,
    note: "Use run_id values with get_run_result or compare_runs.",
  };
}

export async function getRunResult(args: { run_id: string; include_reasoning?: boolean }) {
  await initDb();
  const prepared = await loadRuns([args.run_id]);
  if (prepared.length === 0) throw new Error("run not found");
  const p = prepared[0];
  const d = deriveRunState(p.events);
  const output = roleOutputs(prepared)[0];
  return {
    ...output,
    reasoning: args.include_reasoning ? d.reasoning : undefined,
    sources: d.sources.map((s) => ({
      url: s.url,
      title: s.title,
      domain: domain(s.url),
      cited: d.citedUrls.has(normalizeUrl(s.url)),
      opened: d.openedUrls.has(normalizeUrl(s.url)),
    })),
  };
}

export async function compareRunsForPull(args: {
  run_ids: string[];
  include?: PullInclude[];
  read_urls_limit?: number;
  read_urls_offset?: number;
}) {
  await initDb();
  const runIds = Array.isArray(args.run_ids) ? args.run_ids.filter(Boolean) : [];
  if (runIds.length < 2) throw new Error("compare_runs requires at least two run_ids");

  const include = args.include?.length
    ? args.include
    : ["summary", "query_fanout", "compact"];
  const prepared = await loadRuns(runIds);
  if (prepared.length < 2) throw new Error("fewer than two run_ids matched stored runs");

  const generatedAt = new Date().toISOString();
  const graph = relabelGraph(
    buildReadUrlGraph(
      prepared.map((p) => ({ run: p.run, events: p.events }) satisfies CompareInput),
      { generatedAt },
    ),
    prepared.map((p) => p.role),
  );
  const defaultLimit = envInt("MCP_RESULT_READ_URL_LIMIT", 500);
  const limit = Math.min(1000, Math.max(1, Math.floor(args.read_urls_limit ?? defaultLimit)));
  const offset = Math.max(0, Math.floor(args.read_urls_offset ?? 0));

  const result: Record<string, unknown> = {
    meta: {
      run_ids: prepared.map((p) => p.run.id),
      runCount: prepared.length,
      profileVersion: graph.profileVersion,
      generatedAt,
    },
  };
  if (include.includes("summary")) {
    result.summary = {
      roles: prepared.map((p) => ({
        role: p.role,
        run_id: p.run.id,
        query: p.run.query,
        status: p.run.status,
        model: p.run.model,
        created_at: p.run.created_at,
      })),
      read_url_count: graph.rowCount,
    };
  }
  const roles = roleOutputs(prepared);
  if (include.includes("outputs")) result.roles = roles;
  if (include.includes("query_fanout")) result.query_fanout = graph.queryFanout;
  if (include.includes("compact")) {
    result.compact = buildCompactCompare(graph, roles, { topN: 25 });
  }
  if (include.includes("read_urls")) {
    result.read_urls = pageRows(graph.rows, limit, offset);
    result.read_urls_page = {
      offset,
      limit,
      returned: Math.min(limit, Math.max(0, graph.rows.length - offset)),
      total: graph.rows.length,
    };
  }
  if (include.includes("overlap")) result.overlap = buildOverlap(prepared);
  return result;
}
