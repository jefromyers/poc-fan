import { initDb, pool } from "@/lib/db";
import { runsToCompareMarkdown, type CompareInput } from "@/lib/compare-export";
import type { StreamEvent } from "@/lib/events";
import type { RunRow } from "@/lib/markdown-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/compare?ids=a,b,c — compares the given runs (same decision
// researched from different angles) into one downloadable Markdown document:
// page-overlap matrix, the isolate, and per-run cited domains. Derived from the
// stored event log, so it works for any historical run.
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

  // Preserve the caller's id order (so labels A/B/C match the selection order),
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

  const markdown = runsToCompareMarkdown(inputs);

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="thinking-inspector-comparison.md"`,
      "Cache-Control": "no-store",
    },
  });
}
