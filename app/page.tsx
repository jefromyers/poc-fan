"use client";

import { useEffect, useRef, useState } from "react";
import type { OutputItem, RunStatus, StreamEvent, WebSearchAction } from "@/lib/events";

const MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5", "gpt-5-mini", "o4-mini"];
const EFFORTS = ["low", "medium", "high"] as const;

type ViewStatus = "idle" | RunStatus;

type Fanout = {
  id: string;
  action?: WebSearchAction;
  status: "in_progress" | "searching" | "completed";
};
type Source = { url: string; title: string };
type RunSummary = {
  id: string;
  model: string;
  effort: string | null;
  status: RunStatus;
  created_at: string;
  query_preview: string;
};

function describeAction(action?: WebSearchAction): { icon: string; label: string; detail?: string } {
  switch (action?.type) {
    case "search":
      return { icon: "🔍", label: "search", detail: action.query };
    case "open_page":
      return { icon: "📄", label: "open page", detail: action.url };
    case "find_in_page":
      return { icon: "🔎", label: "find in page", detail: `“${action.pattern}” in ${action.url}` };
    default:
      return { icon: "•", label: action?.type ?? "action", detail: action ? JSON.stringify(action) : undefined };
  }
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function Home() {
  const [model, setModel] = useState(MODELS[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const [query, setQuery] = useState("");

  const [status, setStatus] = useState<ViewStatus>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false); // a fetch stream is actively running

  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [reasoningParts, setReasoningParts] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [raw, setRaw] = useState<StreamEvent[]>([]);

  const [history, setHistory] = useState<RunSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const reasoning = reasoningParts.join("\n\n");
  const busy = status === "running";

  function reset() {
    setRunId(null);
    setError(null);
    setFanouts([]);
    setSources([]);
    setReasoningParts([]);
    setAnswer("");
    setRaw([]);
  }

  function addSources(incoming: Source[]) {
    if (incoming.length === 0) return;
    setSources((prev) => {
      const seen = new Set(prev.map((s) => s.url));
      const merged = [...prev];
      for (const s of incoming) {
        if (s.url && !seen.has(s.url)) {
          seen.add(s.url);
          merged.push(s);
        }
      }
      return merged;
    });
  }

  function setFanoutStatus(itemId: string, next: Fanout["status"]) {
    setFanouts((prev) => prev.map((f) => (f.id === itemId ? { ...f, status: next } : f)));
  }

  function upsertFanout(item: OutputItem, status: Fanout["status"]) {
    setFanouts((prev) => {
      const idx = prev.findIndex((f) => f.id === item.id);
      if (idx === -1) return [...prev, { id: item.id, action: item.action, status }];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], action: item.action ?? copy[idx].action, status };
      return copy;
    });
  }

  // Reasoning is tracked as parts so distinct summary blocks stay separate and so
  // the `.done` events can replace a part's accumulated deltas with canonical text.
  function appendReasoning(delta: string) {
    setReasoningParts((p) => {
      if (p.length === 0) return [delta];
      const c = [...p];
      c[c.length - 1] += delta;
      return c;
    });
  }
  function finalizeReasoning(text: string) {
    setReasoningParts((p) => {
      if (p.length === 0) return [text];
      const c = [...p];
      c[c.length - 1] = text;
      return c;
    });
  }

  // One handler, fed by either the live SSE stream or replayed DB events.
  function handleEvent(ev: StreamEvent) {
    setRaw((prev) => (prev.length > 5000 ? prev : [...prev, ev]));

    switch (ev.type) {
      case "run.created":
        setRunId(ev.run_id);
        break;
      case "response.created":
      case "response.in_progress":
        break;

      case "response.output_item.added":
        if (ev.item.type === "web_search_call") upsertFanout(ev.item, "in_progress");
        break;
      case "response.web_search_call.in_progress":
        setFanoutStatus(ev.item_id, "in_progress");
        break;
      case "response.web_search_call.searching":
        setFanoutStatus(ev.item_id, "searching");
        break;
      case "response.web_search_call.completed":
        setFanoutStatus(ev.item_id, "completed");
        break;
      case "response.output_item.done":
        if (ev.item.type === "web_search_call") {
          upsertFanout(ev.item, "completed");
          const srcs = ev.item.action?.sources;
          if (Array.isArray(srcs)) {
            addSources(srcs.map((s) => ({ url: s.url, title: s.title ?? s.url })));
          }
        }
        break;

      case "response.reasoning_summary_part.added":
        setReasoningParts((p) => [...p, ""]);
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        appendReasoning(ev.delta);
        break;
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done":
        // Canonical final text — replace accumulated deltas (guards missed frames).
        finalizeReasoning(ev.text);
        break;

      case "response.output_text.delta":
        setAnswer((prev) => prev + ev.delta);
        break;
      case "response.output_text.done":
        setAnswer(() => ev.text);
        break;
      case "response.output_text.annotation.added":
        if (ev.annotation.type === "url_citation") {
          addSources([{ url: ev.annotation.url, title: ev.annotation.title ?? ev.annotation.url }]);
        }
        break;

      case "response.completed":
        setStatus("completed");
        break;
      case "response.incomplete":
        setStatus("incomplete");
        break;
      case "response.failed":
        setStatus("failed");
        setError(ev.response?.error?.message ?? "response failed");
        break;
      case "stream.error":
        setStatus("failed");
        setError(ev.error);
        break;
      case "stream.done":
        // No auto-promote: terminal events (completed/incomplete/failed) own status.
        break;
      default:
        // Forward-compat: unknown event types are still captured in the raw log.
        break;
    }
  }

  async function refreshHistory() {
    try {
      const r = await fetch("/api/runs");
      if (r.ok) setHistory((await r.json()).runs ?? []);
    } catch {
      /* non-fatal */
    }
  }
  useEffect(() => {
    refreshHistory();
  }, []);

  async function run() {
    if (!query.trim() || live) return;
    reset();
    setStatus("running");
    setLive(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, query, effort }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => res.statusText);
        setStatus("failed");
        setError(msg || `HTTP ${res.status}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line.slice(6)) as StreamEvent);
          } catch {
            /* skip malformed frame */
          }
        }
      }
    } catch (e: any) {
      if (ac.signal.aborted) {
        setStatus((s) => (s === "running" ? "cancelled" : s));
      } else {
        setStatus("failed");
        setError(e?.message ?? "stream error");
      }
    } finally {
      setLive(false);
      abortRef.current = null;
      refreshHistory();
    }
  }

  function stop() {
    // Aborts the client fetch; the server's cancel() then aborts OpenAI.
    abortRef.current?.abort();
  }

  // Replay a stored run through the same handleEvent path, fed from the DB.
  async function replay(id: string) {
    if (live) return;
    reset();
    setRunId(id);
    setStatus("running");
    try {
      const r = await fetch(`/api/runs/${id}`);
      if (!r.ok) {
        setStatus("failed");
        setError("run not found");
        return;
      }
      const { run, events } = await r.json();
      for (const e of events as { payload: StreamEvent }[]) {
        handleEvent(e.payload);
      }
      setStatus(run.status as RunStatus); // authoritative (covers cancelled/incomplete)
      if (run.error) setError(run.error);
    } catch (e: any) {
      setStatus("failed");
      setError(e?.message ?? "replay failed");
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* History rail */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/50 p-3 md:block">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">History</h2>
          <button onClick={refreshHistory} className="text-xs text-slate-500 hover:text-slate-300" title="Refresh">
            ↻
          </button>
        </div>
        <ul className="space-y-1">
          {history.length === 0 && <li className="text-xs italic text-slate-600">No runs yet.</li>}
          {history.map((h) => (
            <li key={h.id}>
              <button
                onClick={() => replay(h.id)}
                disabled={live}
                className={`w-full rounded p-2 text-left text-xs hover:bg-slate-800 disabled:opacity-40 ${
                  h.id === runId ? "bg-slate-800 ring-1 ring-slate-700" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-slate-300">{h.model}</span>
                  <StatusDot status={h.status} />
                </div>
                <div className="truncate text-slate-400">{h.query_preview || "(empty)"}</div>
                <div className="text-[10px] text-slate-600">{new Date(h.created_at).toLocaleString()}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="mx-auto max-w-5xl flex-1 p-6">
        <header className="mb-4">
          <h1 className="text-xl font-semibold">Model Thinking Inspector</h1>
          <p className="text-sm text-slate-400">
            Pick a model, ask something, and watch it search, read, and reason — live.
          </p>
        </header>

        {/* Command bar */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={live}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-2 text-sm"
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])}
            disabled={live}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-2 text-sm"
            title="reasoning.effort"
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                effort: {e}
              </option>
            ))}
          </select>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
            placeholder="Ask something that needs current info…"
            disabled={live}
            className="min-w-[16rem] flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          />

          {live ? (
            <button
              onClick={stop}
              className="rounded bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!query.trim()}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
            >
              Run
            </button>
          )}
        </div>

        {/* Status line */}
        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>
            status: <span className={statusColor(status)}>{status}</span>
          </span>
          {runId && <span className="font-mono">run {runId}</span>}
          {error && <span className="text-red-400">{error}</span>}
        </div>

        {/* Dashboard */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title={`Search fan-outs (${fanouts.length})`}>
            {fanouts.length === 0 ? (
              <Empty>
                {busy
                  ? "Waiting for the model to search…"
                  : "No searches — the model may answer from its own knowledge."}
              </Empty>
            ) : (
              <ul className="space-y-2">
                {fanouts.map((f) => {
                  const a = describeAction(f.action);
                  return (
                    <li key={f.id} className="rounded border border-slate-800 bg-slate-900/60 p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          <span className="mr-1">{a.icon}</span>
                          <span className="text-slate-400">{a.label}</span>
                          {a.detail && <span className="ml-1">{a.detail}</span>}
                        </span>
                        <StatusChip status={f.status} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title={`Sources (${sources.length})`}>
            {sources.length === 0 ? (
              <Empty>No sources cited yet.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {sources.map((s) => (
                  <li key={s.url} className="truncate">
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                      {s.title || s.url}
                    </a>{" "}
                    <span className="text-slate-500">— {domain(s.url)} ↗</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title="Reasoning" className="mt-4">
          {reasoning ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-200">
              {reasoning}
              {busy && <span className="animate-pulse">▌</span>}
            </pre>
          ) : (
            <Empty>{busy ? "Reasoning will stream here…" : "No reasoning."}</Empty>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            Note: this is the model&apos;s reasoning <em>summary</em>, not its raw chain-of-thought (OpenAI does not expose the latter).
          </p>
        </Panel>

        <Panel title="Answer" className="mt-4">
          {answer ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-100">
              {answer}
              {busy && <span className="animate-pulse">▌</span>}
            </pre>
          ) : (
            <Empty>{busy ? "The answer will stream here…" : "No answer."}</Empty>
          )}
        </Panel>

        <details className="mt-4 rounded-lg border border-slate-800 bg-slate-900 p-3">
          <summary className="cursor-pointer text-sm text-slate-300">Raw event log ({raw.length})</summary>
          <pre className="mt-2 max-h-96 overflow-auto text-[11px] leading-relaxed text-slate-400">
            {raw.map((ev, i) => `${i}\t${ev.type}\t${JSON.stringify(ev)}`).join("\n")}
          </pre>
        </details>
      </main>
    </div>
  );
}

function statusColor(status: ViewStatus): string {
  switch (status) {
    case "completed":
      return "text-emerald-400";
    case "failed":
      return "text-red-400";
    case "incomplete":
      return "text-orange-400";
    case "cancelled":
      return "text-slate-300";
    case "running":
      return "text-amber-400";
    default:
      return "text-slate-400";
  }
}

function StatusDot({ status }: { status: RunStatus }) {
  const color =
    status === "completed"
      ? "bg-emerald-500"
      : status === "failed"
      ? "bg-red-500"
      : status === "incomplete"
      ? "bg-orange-500"
      : status === "cancelled"
      ? "bg-slate-500"
      : "bg-amber-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />;
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900 p-3 ${className}`}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm italic text-slate-500">{children}</p>;
}

function StatusChip({ status }: { status: Fanout["status"] }) {
  const map: Record<Fanout["status"], string> = {
    in_progress: "bg-slate-700 text-slate-200",
    searching: "bg-amber-600/30 text-amber-300",
    completed: "bg-emerald-600/30 text-emerald-300",
  };
  const label = status === "completed" ? "done ✓" : status;
  return <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${map[status]}`}>{label}</span>;
}
