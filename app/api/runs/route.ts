import { randomUUID } from "node:crypto";
import { initDb, pool } from "@/lib/db";
import { MODEL_CANDIDATES } from "@/lib/model-options";
import { executeOpenAIRun, type Effort } from "@/lib/run-executor";

// Node runtime: we hold a long-lived SSE connection to OpenAI and tee every
// event to both Postgres and the browser. force-dynamic so it's never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MODELS = new Set<string>(MODEL_CANDIDATES);
const ALLOWED_EFFORT = new Set<string>(["none", "low", "medium", "high", "xhigh"]);

// GET /api/runs — a page of recent runs for the history rail. Keyset paginated:
// ?limit=N (default 20, max 50) and ?before=<ISO created_at> to fetch the next
// older page. Returns { runs, nextBefore, hasMore }.
export async function GET(req: Request) {
  await initDb();
  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
  const before = url.searchParams.get("before");

  const params: unknown[] = [];
  let where = "";
  if (before) {
    params.push(before);
    where = `WHERE created_at < $1::timestamptz`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, model, effort, status, created_at,
            query,
            left(query, 80) AS query_preview
     FROM runs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  const nextBefore = rows.length ? rows[rows.length - 1].created_at : null;
  return Response.json({ runs: rows, nextBefore, hasMore: rows.length === limit });
}

export async function POST(req: Request) {
  await initDb();

  const body = await req.json().catch(() => ({}));
  const model: string = body.model;
  const query: string = (body.query ?? "").trim();
  const effort: Effort = (ALLOWED_EFFORT.has(body.effort) ? body.effort : "medium") as Effort;

  if (!ALLOWED_MODELS.has(model)) {
    return Response.json({ error: `unknown model: ${model}` }, { status: 400 });
  }
  if (!query) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  const runId = randomUUID();
  await pool.query(
    "INSERT INTO runs (id, model, query, effort, status) VALUES ($1,$2,$3,$4,'running')",
    [runId, model, query, effort],
  );

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const abortRun = () => abort.abort();
  req.signal.addEventListener("abort", abortRun, { once: true });

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      abortRun();
      controller = null;
    },
  });

  const send = (obj: unknown) => {
    if (!controller) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      controller = null; // consumer gone; stop forwarding (pump keeps persisting)
    }
  };
  const closeStream = () => {
    if (!controller) return;
    try {
      controller.close();
    } catch {
      /* already closed */
    }
    controller = null;
  };

  // Detached pump: deliberately NOT awaited by the route response. Browser
  // disconnects still abort this UI-initiated run so we stop upstream work.
  void (async () => {
    send({ type: "run.created", run_id: runId });
    try {
      const result = await executeOpenAIRun({
        runId,
        model,
        query,
        effort,
        signal: abort.signal,
        onEvent: send,
      });
      if (result.status !== "cancelled" && result.status !== "failed") {
        send({ type: "stream.done" });
      } else {
        if (result.error) send({ type: "stream.error", error: result.error });
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      send({ type: "stream.error", error: message });
    } finally {
      req.signal.removeEventListener("abort", abortRun);
      closeStream();
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Disable proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
