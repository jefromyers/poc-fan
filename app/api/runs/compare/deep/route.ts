import { initDb, pool } from "@/lib/db";
import type { CompareInput } from "@/lib/compare-export";
import type { StreamEvent } from "@/lib/events";
import type { RunRow } from "@/lib/markdown-export";
import {
  buildReadUrlGraph,
  deepCompareFilename,
  graphToCsv,
  graphToJson,
  graphToMarkdown,
} from "@/lib/url-graph";
import { zipStore } from "@/lib/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/compare/deep?ids=a,b,c — "Deep compare": a multi-resolution
// read-URL graph (one row per distinct read URL, counts at exact/folder/
// subdomain/registrable-domain, site_type + weight, cited flag, per-role) over
// the selected runs. Returns a ZIP of read_url_graph.csv + .json + .md. Derived
// from the stored event log, like the regular compare. Does not touch the
// existing /api/runs/compare path.
export async function GET(req: Request) {
  await initDb();

  const idsParam = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length < 2) {
    return Response.json(
      { error: "provide at least 2 run ids via ?ids=a,b,c" },
      { status: 400 },
    );
  }

  const runsResult = await pool.query(
    `SELECT id, model, query, effort, status, created_at, usage, error
     FROM runs WHERE id = ANY($1)`,
    [ids],
  );
  const runsById = new Map<string, RunRow>(
    runsResult.rows.map((r) => [r.id as string, r as RunRow]),
  );

  const eventsResult = await pool.query(
    `SELECT run_id, payload FROM events
     WHERE run_id = ANY($1)
     ORDER BY run_id, seq ASC, id ASC`,
    [ids],
  );
  const byRun = new Map<string, StreamEvent[]>();
  for (const row of eventsResult.rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(row.payload as StreamEvent);
    byRun.set(row.run_id, list);
  }

  // Preserve the caller's id order (so role labels A/B/C match selection order),
  // and silently drop any id that doesn't resolve to a run.
  const inputs: CompareInput[] = [];
  for (const id of ids) {
    const run = runsById.get(id);
    if (run) inputs.push({ run, events: byRun.get(id) ?? [] });
  }

  if (inputs.length < 2) {
    return Response.json(
      { error: "fewer than 2 of the given ids matched a run" },
      { status: 404 },
    );
  }

  // Route owns the clock so the graph builder stays pure.
  const graph = buildReadUrlGraph(inputs, { generatedAt: new Date().toISOString() });
  const base = deepCompareFilename(inputs.map((i) => i.run));
  const zip = zipStore([
    { name: `${base}.csv`, text: graphToCsv(graph) },
    { name: `${base}.json`, text: graphToJson(graph) },
    { name: `${base}.md`, text: graphToMarkdown(graph) },
  ]);

  return new Response(zip.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${base}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
