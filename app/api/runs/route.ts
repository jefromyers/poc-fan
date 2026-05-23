import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { initDb, pool } from "@/lib/db";

// Node runtime: we hold a long-lived SSE connection to OpenAI and tee every
// event to both Postgres and the browser. force-dynamic so it's never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MODELS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5", "gpt-5-mini", "o4-mini"]);
type Effort = "low" | "medium" | "high";
const ALLOWED_EFFORT = new Set<string>(["low", "medium", "high"]);

// GET /api/runs — recent runs for the history rail.
export async function GET() {
  await initDb();
  const { rows } = await pool.query(
    `SELECT id, model, effort, status, created_at,
            left(query, 80) AS query_preview
     FROM runs
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  return Response.json({ runs: rows });
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

  // Persist an event. Errors propagate so the pump can fail the run rather than
  // forward an event that isn't in the audit log (the DB is the source of truth).
  const persist = async (seq: number, type: string, payload: unknown) => {
    await pool.query(
      "INSERT INTO events (run_id, seq, type, payload) VALUES ($1,$2,$3,$4)",
      [runId, seq, type, JSON.stringify(payload)],
    );
  };

  // Terminal status writes. `AND status='running'` makes this idempotent and
  // prevents a later cancel/error from clobbering a real terminal state.
  let finalized = false;
  const finalize = async (status: string, response: any, errorMsg: string | null) => {
    if (finalized) return; // first terminal state wins
    finalized = true;
    try {
      await pool.query(
        `UPDATE runs SET status=$2, final_response=$3, usage=$4, error=$5
         WHERE id=$1 AND status='running'`,
        [
          runId,
          status,
          response ? JSON.stringify(response) : null,
          response?.usage ? JSON.stringify(response.usage) : null,
          errorMsg,
        ],
      );
    } catch (e) {
      console.error(`[run ${runId}] finalize(${status}) failed:`, e);
    }
  };

  const client = new OpenAI();
  const encoder = new TextEncoder();
  const abort = new AbortController();

  // Client disconnect (tab close, network drop, or the UI Stop button aborting
  // its fetch) fires req.signal — abort the upstream request so we stop
  // consuming/billing OpenAI tokens. cancel() below is a belt-and-suspenders.
  // On client disconnect: abort the OpenAI request (stops billing) AND finalize
  // here. We can't rely on the pump's catch — this SDK's async iterator can hang
  // instead of rejecting when its request is aborted, freezing the pump.
  const onDisconnect = () => {
    abort.abort();
    void finalize("cancelled", null, null);
  };
  req.signal.addEventListener("abort", onDisconnect);

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel: onDisconnect,
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

  // Detached pump: deliberately NOT awaited and NOT tied to the response
  // stream, so it runs to a terminal state (persisting every event, then
  // finalizing runs.status) even after the client disconnects. `next start` is
  // a long-lived Node server, so this background task keeps running.
  void (async () => {
    send({ type: "run.created", run_id: runId });
    let seq = 0;
    try {
      const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model,
        input: query,
        stream: true,
        reasoning: { effort, summary: "detailed" },
        // Two fields where this SDK version's types lag the live API (both
        // verified working at runtime): the tool is "web_search" (SDK only
        // types "web_search_preview"), and the include literal below isn't in
        // the union yet. Escapes are localized so the rest stays type-checked.
        tools: [{ type: "web_search" } as any],
        // @ts-expect-error - include literal not in this SDK version's union.
        include: ["web_search_call.action.sources"],
      };
      const events = await client.responses.create(params, { signal: abort.signal });

      // Drive the iterator manually and race each step against the abort signal:
      // when aborted, this SDK's iterator hangs instead of rejecting, so racing
      // lets the pump break cleanly (run its finally) rather than leak frozen.
      const iterator = events[Symbol.asyncIterator]();
      const aborted = new Promise<{ done: true }>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve({ done: true })),
      );

      while (true) {
        const result: any = await Promise.race([iterator.next(), aborted]);
        if (result.done) break;
        const ev = result.value;
        const s = typeof ev.sequence_number === "number" ? ev.sequence_number : seq++;

        // Persist BEFORE forwarding so the DB is the source of truth: the
        // browser never sees an event that isn't already in the audit log. If
        // the insert fails, fail the run rather than forward an unstored event.
        try {
          await persist(s, ev.type, ev);
        } catch (e: any) {
          const message = `persistence failed: ${e?.message ?? String(e)}`;
          await finalize("failed", null, message);
          send({ type: "stream.error", error: message });
          return; // stop forwarding; skip the stream.done below
        }
        send(ev);

        if (ev.type === "response.completed") await finalize("completed", ev.response, null);
        else if (ev.type === "response.incomplete") await finalize("incomplete", ev.response, null);
        else if (ev.type === "response.failed")
          await finalize("failed", ev.response, ev.response?.error?.message ?? "response failed");
      }

      if (abort.signal.aborted) {
        await finalize("cancelled", null, null); // guarded; onDisconnect usually ran first
      } else {
        send({ type: "stream.done" });
      }
    } catch (err: any) {
      if (abort.signal.aborted) {
        // Disconnect / Stop — not a failure. Events consumed before the abort
        // were already persisted above.
        await finalize("cancelled", null, null);
      } else {
        const message = err?.message ?? String(err);
        await finalize("failed", null, message);
        send({ type: "stream.error", error: message });
      }
    } finally {
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
