import { initDb, pool } from "@/lib/db";
import type { StreamEvent } from "@/lib/events";
import { runToMarkdown, type RunRow } from "@/lib/markdown-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/export — recent runs (most recent 50, matching the history
// rail) concatenated into a single downloadable Markdown document.
export async function GET() {
  await initDb();

  const runsResult = await pool.query(
    `SELECT id, model, query, effort, status, created_at, usage, error
     FROM runs
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  const runs = runsResult.rows as RunRow[];

  if (runs.length === 0) {
    return new Response("# Thinking Inspector Runs\n\n_No runs yet._\n", {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="thinking-inspector-runs.md"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // One query for all events, grouped in memory (avoids an N+1 per run).
  const ids = runs.map((r) => r.id);
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

  const docs = runs.map((run) => runToMarkdown(run, byRun.get(run.id) ?? []));
  const markdown = docs.join("\n\n---\n\n") + "\n";

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="thinking-inspector-runs.md"`,
      "Cache-Control": "no-store",
    },
  });
}
