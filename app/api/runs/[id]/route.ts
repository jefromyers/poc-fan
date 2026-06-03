import { initDb, pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/:id — the run row plus every stored event in order, for replay.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await initDb();
  const { id } = params;

  const runResult = await pool.query(
    `SELECT id, model, query, effort, status, created_at, final_response, usage, error
     FROM runs WHERE id = $1`,
    [id],
  );
  if (runResult.rowCount === 0) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const eventsResult = await pool.query(
    `SELECT seq, type, payload FROM events WHERE run_id = $1 ORDER BY seq ASC, id ASC`,
    [id],
  );

  return Response.json({ run: runResult.rows[0], events: eventsResult.rows });
}

// DELETE /api/runs/:id — remove a run and its events. Used by the history
// trashcan and by retry (which replaces a dead run). Events are deleted first
// since the FK has no ON DELETE CASCADE. Idempotent: 404 once it's gone.
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  await initDb();
  const { id } = params;

  await pool.query(`DELETE FROM events WHERE run_id = $1`, [id]);
  const res = await pool.query(`DELETE FROM runs WHERE id = $1`, [id]);
  if (res.rowCount === 0) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
