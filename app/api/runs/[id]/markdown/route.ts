import { initDb, pool } from "@/lib/db";
import type { StreamEvent } from "@/lib/events";
import {
  exportFilename,
  runToMarkdown,
  type RunRow,
} from "@/lib/markdown-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/:id/markdown — the run rendered as a downloadable Markdown
// document, derived from the stored event log (works for any historical run).
// Append ?raw=1 to include the raw event JSON.
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  await initDb();
  const { id } = params;

  const runResult = await pool.query(
    `SELECT id, model, query, effort, status, created_at, usage, error
     FROM runs WHERE id = $1`,
    [id],
  );
  if (runResult.rowCount === 0) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const eventsResult = await pool.query(
    `SELECT payload FROM events WHERE run_id = $1 ORDER BY seq ASC, id ASC`,
    [id],
  );

  const run = runResult.rows[0] as RunRow;
  const events = eventsResult.rows.map((r) => r.payload as StreamEvent);
  const raw = new URL(req.url).searchParams.get("raw") === "1";

  const markdown = runToMarkdown(run, events, { raw });

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(run)}"`,
      "Cache-Control": "no-store",
    },
  });
}
