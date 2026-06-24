import { randomUUID } from "node:crypto";
import { buildCompactCompare } from "@/lib/compact-compare";
import { initDb, pool } from "@/lib/db";
import { deriveRunState, domain, normalizeUrl } from "@/lib/derive";
import type { StreamEvent } from "@/lib/events";
import { MODEL_CANDIDATES } from "@/lib/model-options";
import { executeOpenAIRun, type Effort } from "@/lib/run-executor";
import { PROFILE_VERSION } from "@/lib/site-profiles";
import {
  buildReadUrlGraph,
  type GraphRow,
  type ReadUrlGraph,
} from "@/lib/url-graph";
import type { CompareInput } from "@/lib/compare-export";
import type { RunRow } from "@/lib/markdown-export";

type JobStatus = "queued" | "running" | "completed" | "failed";
type IncludeSection = "summary" | "outputs" | "query_fanout" | "compact" | "read_urls" | "overlap";

export type RunCompareArgs = {
  prompts: string[];
  runs?: number;
  model: string;
  effort?: Effort;
  profile?: string;
  label?: string;
};

export type GetResultsArgs = {
  job_id: string;
  include?: IncludeSection[];
  read_urls_limit?: number;
  read_urls_offset?: number;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALLOWED_MODELS = new Set<string>(MODEL_CANDIDATES);
const ALLOWED_EFFORT = new Set<string>(["none", "low", "medium", "high", "xhigh"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);

function envInt(name: string, fallback: number) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function promptRole(index: number) {
  return LETTERS[index] ?? `#${index + 1}`;
}

function childRole(promptIndex: number, repeatIndex: number, repeats: number) {
  const base = promptRole(promptIndex);
  return repeats === 1 ? base : `${base}${repeatIndex + 1}`;
}

function cleanPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertValidSubmit(args: RunCompareArgs) {
  const maxPrompts = envInt("MCP_MAX_PROMPTS", 12);
  const maxTotalRuns = envInt("MCP_MAX_TOTAL_RUNS", 72);
  const prompts = Array.isArray(args.prompts) ? args.prompts.map(cleanPrompt).filter(Boolean) : [];
  const repeats = Math.max(1, Math.floor(args.runs ?? 6));
  const effort = (ALLOWED_EFFORT.has(args.effort ?? "") ? args.effort : "medium") as Effort;
  const profile = args.profile ?? "latest";

  if (prompts.length === 0) throw new Error("prompts must contain at least one non-empty string");
  if (prompts.length > maxPrompts) throw new Error(`prompts is capped at ${maxPrompts}`);
  if (prompts.length * repeats > maxTotalRuns) {
    throw new Error(`prompts.length * runs is capped at ${maxTotalRuns}`);
  }
  if (!ALLOWED_MODELS.has(args.model)) throw new Error(`unknown model: ${args.model}`);
  if (profile !== "latest" && profile !== PROFILE_VERSION) {
    throw new Error(`unsupported profile: ${profile}; use "latest" or ${PROFILE_VERSION}`);
  }

  return { prompts, repeats, effort, profileVersion: PROFILE_VERSION };
}

async function markStaleJobs() {
  const minutes = envInt("MCP_STALE_JOB_MINUTES", 720);
  const stale = await pool.query(
    `SELECT id FROM compare_jobs
     WHERE status IN ('queued','running')
       AND updated_at < now() - ($1::text || ' minutes')::interval`,
    [String(minutes)],
  );
  for (const row of stale.rows) {
    await failJob(row.id, `job was still active after ${minutes} minutes`);
  }
}

async function updateJobProgress(jobId: string): Promise<{
  status: JobStatus;
  runs_done: number;
  runs_total: number;
  runs_failed: number;
  error?: string;
}> {
  const { rows } = await pool.query(
    `SELECT r.status, r.error
     FROM compare_job_runs cjr
     JOIN runs r ON r.id = cjr.run_id
     WHERE cjr.job_id = $1`,
    [jobId],
  );
  const runsTotal = rows.length;
  const runsDone = rows.filter((r) => TERMINAL_RUN_STATUSES.has(r.status)).length;
  const failedRows = rows.filter((r) => r.status !== "completed" && TERMINAL_RUN_STATUSES.has(r.status));
  const runsFailed = failedRows.length;
  let status: JobStatus = runsDone >= runsTotal && runsTotal > 0 ? "completed" : "running";
  let error: string | undefined;
  if (runsDone >= runsTotal && runsFailed > 0) {
    status = "failed";
    error = failedRows.find((r) => r.error)?.error ?? `${runsFailed} child run(s) did not complete`;
  }

  await pool.query(
    `UPDATE compare_jobs
     SET status=$2, runs_done=$3, updated_at=now(), error=COALESCE($4, error)
     WHERE id=$1`,
    [jobId, status, runsDone, error ?? null],
  );

  return {
    status,
    runs_done: runsDone,
    runs_total: runsTotal,
    runs_failed: runsFailed,
    error,
  };
}

async function failJob(jobId: string, error: string) {
  await pool.query(
    `UPDATE runs
     SET status='failed', error=$2
     WHERE id IN (SELECT run_id FROM compare_job_runs WHERE job_id=$1)
       AND status='running'`,
    [jobId, error],
  );
  await pool.query(
    `UPDATE compare_jobs
     SET status='failed', error=$2, updated_at=now()
     WHERE id=$1 AND status IN ('queued','running')`,
    [jobId, error],
  );
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function processCompareJob(jobId: string) {
  try {
    await pool.query(
      `UPDATE compare_jobs SET status='running', updated_at=now()
       WHERE id=$1 AND status='queued'`,
      [jobId],
    );
    const { rows } = await pool.query(
      `SELECT cjr.run_id, cjr.query, r.model, r.effort
       FROM compare_job_runs cjr
       JOIN runs r ON r.id = cjr.run_id
       WHERE cjr.job_id = $1
       ORDER BY cjr.prompt_index ASC, cjr.repeat_index ASC`,
      [jobId],
    );
    const concurrency = envInt("MCP_JOB_CONCURRENCY", 2);
    await runWithConcurrency(rows, concurrency, async (row) => {
      await executeOpenAIRun({
        runId: row.run_id,
        model: row.model,
        query: row.query,
        effort: (row.effort ?? "medium") as Effort,
      });
      await updateJobProgress(jobId);
    });
    await updateJobProgress(jobId);
  } catch (e: any) {
    await failJob(jobId, e?.message ?? String(e));
  }
}

export async function submitCompareJob(args: RunCompareArgs) {
  await initDb();
  const { prompts, repeats, effort, profileVersion } = assertValidSubmit(args);
  const jobId = randomUUID();
  const totalRuns = prompts.length * repeats;

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO compare_jobs
       (id, label, status, model, effort, profile_version, prompt_count, runs_per_prompt, total_runs)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8)`,
      [
        jobId,
        typeof args.label === "string" && args.label.trim() ? args.label.trim() : null,
        args.model,
        effort,
        profileVersion,
        prompts.length,
        repeats,
        totalRuns,
      ],
    );

    for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
        const runId = randomUUID();
        const query = prompts[promptIndex];
        const role = childRole(promptIndex, repeatIndex, repeats);
        const baseRole = promptRole(promptIndex);
        await pool.query(
          "INSERT INTO runs (id, model, query, effort, status) VALUES ($1,$2,$3,$4,'running')",
          [runId, args.model, query, effort],
        );
        await pool.query(
          `INSERT INTO compare_job_runs
           (job_id, run_id, role, prompt_role, prompt_index, repeat_index, query)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [jobId, runId, role, baseRole, promptIndex, repeatIndex, query],
        );
      }
    }
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }

  void processCompareJob(jobId);

  return {
    job_id: jobId,
    status: "queued",
    prompt_count: prompts.length,
    runs: repeats,
    total_runs: totalRuns,
    model: args.model,
    submitted_at: new Date().toISOString(),
  };
}

async function loadJob(jobId: string) {
  const jobResult = await pool.query(`SELECT * FROM compare_jobs WHERE id = $1`, [jobId]);
  if (jobResult.rowCount === 0) throw new Error("job not found");
  return jobResult.rows[0];
}

export async function getCompareStatus(jobId: string) {
  await initDb();
  await markStaleJobs();
  const job = await loadJob(jobId);
  const progress = await updateJobProgress(jobId);
  return {
    job_id: jobId,
    status: progress.status,
    runs_done: progress.runs_done,
    runs_total: progress.runs_total,
    runs_failed: progress.runs_failed,
    error: progress.error ?? job.error ?? undefined,
  };
}

type PreparedRun = {
  role: string;
  prompt_role: string;
  prompt_index: number;
  repeat_index: number;
  run: RunRow;
  events: StreamEvent[];
};

async function loadPreparedRuns(jobId: string): Promise<PreparedRun[]> {
  const runsResult = await pool.query(
    `SELECT cjr.role, cjr.prompt_role, cjr.prompt_index, cjr.repeat_index,
            r.id, r.model, r.query, r.effort, r.status, r.created_at, r.usage, r.error
     FROM compare_job_runs cjr
     JOIN runs r ON r.id = cjr.run_id
     WHERE cjr.job_id = $1
     ORDER BY cjr.prompt_index ASC, cjr.repeat_index ASC`,
    [jobId],
  );
  const runIds = runsResult.rows.map((r) => r.id);
  const eventsResult = await pool.query(
    `SELECT run_id, payload FROM events
     WHERE run_id = ANY($1::uuid[])
     ORDER BY run_id, seq ASC, id ASC`,
    [runIds],
  );
  const byRun = new Map<string, StreamEvent[]>();
  for (const row of eventsResult.rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(row.payload as StreamEvent);
    byRun.set(row.run_id, list);
  }
  return runsResult.rows.map((r) => ({
    role: r.role,
    prompt_role: r.prompt_role,
    prompt_index: r.prompt_index,
    repeat_index: r.repeat_index,
    run: r as RunRow,
    events: byRun.get(r.id) ?? [],
  }));
}

function graphWithJobRoles(graph: ReadUrlGraph, prepared: PreparedRun[]): ReadUrlGraph {
  const labelMap = new Map<string, string>();
  graph.roleLegend.forEach((entry, index) => {
    labelMap.set(entry.role, prepared[index]?.role ?? entry.role);
  });
  return {
    ...graph,
    roleLegend: graph.roleLegend.map((entry, index) => ({
      ...entry,
      role: prepared[index]?.role ?? entry.role,
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

function buildRoles(prepared: PreparedRun[]) {
  return prepared.map((p) => {
    const d = deriveRunState(p.events);
    const read = new Set<string>([...d.consultedUrls, ...d.openedUrls, ...d.citedUrls]);
    const domains = new Set<string>();
    for (const url of read) domains.add(domain(url));
    return {
      role: p.role,
      prompt_role: p.prompt_role,
      prompt_index: p.prompt_index,
      repeat_index: p.repeat_index,
      run_id: p.run.id,
      query: p.run.query,
      model: p.run.model,
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

function intersect(a: Set<string>, b: Set<string>) {
  const out: string[] = [];
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) out.push(item);
  return out.sort();
}

function buildOverlap(prepared: PreparedRun[]) {
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

function pageRows(rows: GraphRow[], limit: number, offset: number) {
  return rows.slice(offset, offset + limit);
}

export async function getCompareResults(args: GetResultsArgs) {
  await initDb();
  await markStaleJobs();
  const include = args.include?.length
    ? args.include
    : ["summary", "query_fanout", "compact"];
  const job = await loadJob(args.job_id);
  await updateJobProgress(args.job_id);
  const prepared = await loadPreparedRuns(args.job_id);
  const generatedAt = new Date().toISOString();
  const compareInputs: CompareInput[] = prepared.map((p) => ({ run: p.run, events: p.events }));
  const graph = graphWithJobRoles(
    buildReadUrlGraph(compareInputs, { generatedAt }),
    prepared,
  );
  const defaultLimit = envInt("MCP_RESULT_READ_URL_LIMIT", 500);
  const limit = Math.min(1000, Math.max(1, Math.floor(args.read_urls_limit ?? defaultLimit)));
  const offset = Math.max(0, Math.floor(args.read_urls_offset ?? 0));

  const result: Record<string, unknown> = {
    meta: {
      job_id: job.id,
      label: job.label,
      model: job.model,
      effort: job.effort,
      profileVersion: job.profile_version,
      prompt_count: job.prompt_count,
      runs_per_prompt: job.runs_per_prompt,
      runCount: job.total_runs,
      status: job.status,
      submittedAt: new Date(job.created_at).toISOString(),
      generatedAt,
    },
  };

  if (include.includes("summary")) {
    result.summary = {
      roles: prepared.map((p) => ({
        role: p.role,
        prompt_role: p.prompt_role,
        run_id: p.run.id,
        query: p.run.query,
        status: p.run.status,
      })),
      read_url_count: graph.rowCount,
    };
  }
  const roles = buildRoles(prepared);
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

export async function listCompareJobs(limit = 20) {
  await initDb();
  await markStaleJobs();
  const cleanLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const { rows } = await pool.query(
    `SELECT id, label, status, model, effort, profile_version, prompt_count,
            runs_per_prompt, total_runs, runs_done, created_at, updated_at, error
     FROM compare_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [cleanLimit],
  );
  return {
    jobs: rows.map((row) => ({
      job_id: row.id,
      label: row.label,
      status: row.status,
      model: row.model,
      effort: row.effort,
      profileVersion: row.profile_version,
      prompt_count: row.prompt_count,
      runs_per_prompt: row.runs_per_prompt,
      total_runs: row.total_runs,
      runs_done: row.runs_done,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      error: row.error,
    })),
  };
}
