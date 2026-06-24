import OpenAI from "openai";
import { pool } from "@/lib/db";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh";

export type ExecuteRunOptions = {
  runId: string;
  model: string;
  query: string;
  effort: Effort;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void | Promise<void>;
  onControlEvent?: (event: unknown) => void | Promise<void>;
};

export type ExecuteRunResult = {
  status: "completed" | "incomplete" | "failed" | "cancelled";
  error?: string;
};

async function persist(runId: string, seq: number, type: string, payload: unknown) {
  await pool.query(
    "INSERT INTO events (run_id, seq, type, payload) VALUES ($1,$2,$3,$4)",
    [runId, seq, type, JSON.stringify(payload)],
  );
}

export async function finalizeRun(
  runId: string,
  status: string,
  response: any,
  errorMsg: string | null,
) {
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
}

export async function executeOpenAIRun(
  opts: ExecuteRunOptions,
): Promise<ExecuteRunResult> {
  const { runId, model, query, effort, signal, onEvent, onControlEvent } = opts;
  const abort = new AbortController();
  let finalized = false;
  let terminalResult: ExecuteRunResult | null = null;

  const finish = async (
    status: ExecuteRunResult["status"],
    response: any,
    errorMsg: string | null,
  ): Promise<ExecuteRunResult> => {
    if (!finalized) {
      finalized = true;
      try {
        await finalizeRun(runId, status, response, errorMsg);
      } catch (e) {
        console.error(`[run ${runId}] finalize(${status}) failed:`, e);
      }
    }
    terminalResult = errorMsg ? { status, error: errorMsg } : { status };
    return terminalResult;
  };

  const abortUpstream = () => abort.abort();
  if (signal) {
    if (signal.aborted) abortUpstream();
    else signal.addEventListener("abort", abortUpstream, { once: true });
  }

  try {
    const client = new OpenAI();
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model,
      input: query,
      stream: true,
      reasoning: { effort: effort as any, summary: "detailed" as any },
      tools: [{ type: "web_search" } as any],
      // @ts-expect-error - include literal not in this SDK version's union.
      include: ["web_search_call.action.sources"],
    };
    const events = await client.responses.create(params, { signal: abort.signal });

    const iterator = events[Symbol.asyncIterator]();
    const aborted = new Promise<{ done: true }>((resolve) => {
      if (abort.signal.aborted) resolve({ done: true });
      else abort.signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
    });

    let seq = 0;
    while (true) {
      const result: any = await Promise.race([iterator.next(), aborted]);
      if (result.done) break;
      const ev = result.value;
      const type = typeof ev?.type === "string" ? ev.type.trim() : "";
      if (!type) {
        console.warn("runs: untyped event", JSON.stringify(ev));
        continue;
      }
      const s = typeof ev.sequence_number === "number" ? ev.sequence_number : seq++;

      try {
        await persist(runId, s, type, ev);
      } catch (e: any) {
        const message = `persistence failed: ${e?.message ?? String(e)}`;
        const result = await finish("failed", null, message);
        await onControlEvent?.({ type: "stream.error", error: message });
        return result;
      }

      await onEvent?.(ev);

      if (type === "response.completed") {
        await finish("completed", ev.response, null);
      } else if (type === "response.incomplete") {
        await finish("incomplete", ev.response, null);
      } else if (type === "response.failed") {
        await finish(
          "failed",
          ev.response,
          ev.response?.error?.message ?? "response failed",
        );
      }
    }

    if (abort.signal.aborted) return finish("cancelled", null, null);
    return terminalResult ?? finish("failed", null, "stream ended without terminal event");
  } catch (err: any) {
    if (abort.signal.aborted) return finish("cancelled", null, null);
    const message = err?.message ?? String(err);
    const result = await finish("failed", null, message);
    await onControlEvent?.({ type: "stream.error", error: message });
    return result;
  } finally {
    if (signal) signal.removeEventListener("abort", abortUpstream);
  }
}
