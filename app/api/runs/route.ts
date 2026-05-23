import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { initDb, pool } from "@/lib/db";

// Node runtime: we hold a long-lived SSE connection to OpenAI and tee every
// event to both Postgres and the browser. force-dynamic so it's never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5",
  "gpt-5-mini",
  "o4-mini",
]);
const ALLOWED_EFFORT = new Set(["low", "medium", "high"]);

export async function POST(req: Request) {
  await initDb();

  const body = await req.json().catch(() => ({}));
  const model: string = body.model;
  const query: string = (body.query ?? "").trim();
  const effort: string = ALLOWED_EFFORT.has(body.effort) ? body.effort : "medium";

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

  const client = new OpenAI();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // Tell the client its run id up front so it can link to the stored row.
      send({ type: "run.created", run_id: runId });

      let seq = 0;
      try {
        // Typed loosely on purpose: `include` values and reasoning options move
        // faster than the SDK's type unions. These are valid for the live API.
        const params: any = {
          model,
          input: query,
          stream: true,
          tools: [{ type: "web_search" }],
          reasoning: { effort, summary: "detailed" },
          include: ["web_search_call.action.sources"],
        };
        const events: any = await client.responses.create(params);

        for await (const event of events as AsyncIterable<any>) {
          const s = typeof event.sequence_number === "number" ? event.sequence_number : seq++;

          // Forward to the browser first (live feel), then persist (awaited so
          // rows land in order and a slow insert can't be lost on disconnect).
          send(event);
          await pool.query(
            "INSERT INTO events (run_id, seq, type, payload) VALUES ($1,$2,$3,$4)",
            [runId, s, event.type, JSON.stringify(event)],
          );

          if (event.type === "response.completed" && event.response) {
            await pool.query(
              "UPDATE runs SET status='completed', final_response=$2, usage=$3 WHERE id=$1",
              [runId, JSON.stringify(event.response), JSON.stringify(event.response.usage ?? null)],
            );
          }
        }

        send({ type: "stream.done" });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        await pool
          .query("UPDATE runs SET status='failed', error=$2 WHERE id=$1", [runId, message])
          .catch(() => {});
        send({ type: "stream.error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
