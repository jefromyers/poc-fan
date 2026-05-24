"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Code2,
  Dot,
  ExternalLink,
  FileText,
  Globe,
  History,
  RotateCw,
  ScanSearch,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  OutputItem,
  RunStatus,
  StreamEvent,
  WebSearchAction,
} from "@/lib/events";
import { Markdown } from "./markdown";

const MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5", "gpt-5-mini", "o4-mini"];
const EFFORTS = ["low", "medium", "high"] as const;

type ViewStatus = "idle" | RunStatus;
type BadgeStatus = ViewStatus | Fanout["status"];

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

type ActionDescription = {
  icon: LucideIcon;
  label: string;
  detail?: string;
  details?: string[];
  href?: string;
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-blue focus-visible:ring-offset-2";

function describeAction(action?: WebSearchAction): ActionDescription {
  switch (action?.type) {
    case "search": {
      const queries = searchQueries(action);
      return {
        icon: Search,
        label: "Search",
        detail: queries[0],
        details: queries.length > 1 ? queries : undefined,
      };
    }
    case "open_page":
      return {
        icon: FileText,
        label: "Open",
        detail: action.url,
        href: action.url,
      };
    case "find_in_page":
      return {
        icon: ScanSearch,
        label: "Find",
        detail:
          action.pattern && action.url
            ? `"${action.pattern}" in ${action.url}`
            : (action.pattern ?? action.url),
        href: action.url,
      };
    default:
      return {
        icon: Dot,
        label: titleCase(action?.type ?? "action"),
        detail: action ? JSON.stringify(action) : undefined,
      };
  }
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/"))
      u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

function searchQueries(action: WebSearchAction): string[] {
  if (Array.isArray(action.queries)) {
    const filtered = action.queries.filter((q): q is string => Boolean(q));
    if (filtered.length > 0) return filtered;
  }
  return action.query ? [action.query] : [];
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  const [citedUrls, setCitedUrls] = useState<Set<string>>(() => new Set());
  const [citationCount, setCitationCount] = useState(0);
  const [reasoningParts, setReasoningParts] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [raw, setRaw] = useState<StreamEvent[]>([]);

  const [history, setHistory] = useState<RunSummary[]>([]);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeHistoryButtonRef = useRef<HTMLButtonElement | null>(null);

  const reasoning = reasoningParts.join("\n\n");
  const busy = status === "running";
  const searchCount = fanouts.filter((f) => f.action?.type === "search").length;
  const citedCount = citedUrls.size;

  useEffect(() => {
    if (!mobileHistoryOpen) return;

    closeHistoryButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMobileHistory();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileHistoryOpen]);

  function closeMobileHistory() {
    setMobileHistoryOpen(false);
    window.setTimeout(() => historyButtonRef.current?.focus(), 0);
  }

  function reset() {
    setRunId(null);
    setError(null);
    setFanouts([]);
    setSources([]);
    setCitedUrls(new Set());
    setCitationCount(0);
    setReasoningParts([]);
    setAnswer("");
    setRaw([]);
  }

  function addSources(incoming: Source[], { preferIncomingUrl = false } = {}) {
    if (incoming.length === 0) return;
    setSources((prev) => {
      const byKey = new Map<string, number>();
      const merged = prev.map((s, i) => {
        byKey.set(normalizeUrl(s.url), i);
        return s;
      });
      for (const s of incoming) {
        if (!s.url) continue;
        const key = normalizeUrl(s.url);
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, merged.length);
          merged.push(s);
        } else if (preferIncomingUrl) {
          merged[existing] = {
            ...merged[existing],
            url: s.url,
            title: s.title || merged[existing].title,
          };
        }
      }
      return merged;
    });
  }

  function setFanoutStatus(itemId: string, next: Fanout["status"]) {
    setFanouts((prev) =>
      prev.map((f) => (f.id === itemId ? { ...f, status: next } : f)),
    );
  }

  function upsertFanout(item: OutputItem, status: Fanout["status"]) {
    setFanouts((prev) => {
      const idx = prev.findIndex((f) => f.id === item.id);
      if (idx === -1)
        return [...prev, { id: item.id, action: item.action, status }];
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        action: item.action ?? copy[idx].action,
        status,
      };
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
        if (ev.item.type === "web_search_call")
          upsertFanout(ev.item, "in_progress");
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
            addSources(
              srcs.map((s) => ({ url: s.url, title: s.title ?? s.url })),
            );
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
        // Canonical final text - replace accumulated deltas (guards missed frames).
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
          addSources(
            [
              {
                url: ev.annotation.url,
                title: ev.annotation.title ?? ev.annotation.url,
              },
            ],
            { preferIncomingUrl: true },
          );
          const key = normalizeUrl(ev.annotation.url);
          setCitedUrls((prev) => {
            if (prev.has(key)) return prev;
            const next = new Set(prev);
            next.add(key);
            return next;
          });
          setCitationCount((n) => n + 1);
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

  function replayFromHistory(id: string) {
    setMobileHistoryOpen(false);
    replay(id);
  }

  return (
    <div className="min-h-screen bg-cl-bg text-cl-slate">
      <header className="border-b border-cl-border bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-cl-blue text-xs font-extrabold tracking-wide text-white">
            CL
          </div>
          <div className="min-w-0">
            <div className="text-sm font-extrabold uppercase tracking-wider text-cl-blue">
              Citation Labs
            </div>
            <div className="text-xs font-medium text-cl-slate">
              Whatchu doin mr robot
            </div>
          </div>
          <button
            ref={historyButtonRef}
            type="button"
            onClick={() => setMobileHistoryOpen(true)}
            aria-label="Open history"
            className={`ml-auto inline-flex h-9 items-center gap-2 rounded-btn border border-cl-border bg-white px-3 text-sm font-bold uppercase tracking-wider text-cl-blue hover:bg-cl-ice md:hidden ${focusRing}`}
          >
            <History
              className="h-4 w-4"
              aria-hidden="true"
              strokeWidth={1.75}
            />
            History
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl">
        <HistoryRail
          history={history}
          runId={runId}
          live={live}
          onRefresh={refreshHistory}
          onReplay={replay}
        />

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-5xl">
            <section className="mb-6">
              <h1 className="text-3xl font-extrabold uppercase tracking-tight text-cl-blue md:text-4xl">
                What are these robots thinking...
              </h1>
              <p className="mt-2 max-w-3xl text-base leading-relaxed text-cl-slate">
                Pick a model, ask something, and watch it search, read, and
                reason live.
              </p>
            </section>

            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                run();
              }}
              className="mb-4 flex flex-wrap items-end gap-3 rounded-card border border-cl-border bg-white p-4"
            >
              <Field label="Model" htmlFor="model">
                <select
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={live}
                  className={`h-10 rounded-btn border border-cl-border bg-white px-3 text-sm text-cl-slate disabled:bg-slate-50 disabled:text-slate-400 ${inputFocus}`}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Reasoning Effort" htmlFor="effort">
                <select
                  id="effort"
                  value={effort}
                  onChange={(e) =>
                    setEffort(e.target.value as (typeof EFFORTS)[number])
                  }
                  disabled={live}
                  className={`h-10 rounded-btn border border-cl-border bg-white px-3 text-sm text-cl-slate disabled:bg-slate-50 disabled:text-slate-400 ${inputFocus}`}
                >
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Query"
                htmlFor="query"
                className="min-w-[16rem] flex-1"
              >
                <input
                  id="query"
                  type="text"
                  required
                  aria-describedby="query-help"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ask something that needs current info..."
                  disabled={live}
                  className={`h-10 w-full rounded-btn border border-cl-border bg-white px-3 text-sm text-cl-slate placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-400 ${inputFocus}`}
                />
                <span id="query-help" className="sr-only">
                  Press Enter to run.
                </span>
              </Field>

              {live ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Stop run"
                  className={`h-10 w-full rounded-btn border border-cl-error bg-white px-6 text-sm font-bold uppercase tracking-wider text-cl-error transition hover:bg-red-50 sm:w-auto ${focusRing}`}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!query.trim()}
                  aria-busy={live}
                  className={`h-10 w-full rounded-btn bg-cl-yellow px-6 text-sm font-bold uppercase tracking-wider text-cl-navy transition hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto ${focusRing}`}
                >
                  Run
                </button>
              )}
            </form>

            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex flex-wrap items-center gap-4 text-sm text-cl-slate"
            >
              <span className="inline-flex items-center gap-2">
                <span className="font-bold uppercase tracking-wider text-cl-blue">
                  Status:
                </span>
                <StatusBadge status={status} />
              </span>
              {runId && (
                <span className="select-all font-mono text-xs text-cl-slate">
                  run {runId}
                </span>
              )}
            </div>

            {error && <AlertBlock title="Run failed" message={error} />}

            <section className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard
                label="Actions"
                value={fanouts.length}
                sublabel={`${searchCount} ${searchCount === 1 ? "search" : "searches"}`}
              />
              <KpiCard
                label="Sources"
                value={sources.length}
                sublabel={
                  citedCount > 0
                    ? `retrieved · ${citedCount} sources cited (${citationCount} ${citationCount === 1 ? "reference" : "references"})`
                    : "retrieved"
                }
              />
            </section>

            <Panel
              title="Reasoning"
              className="mt-4"
              meta={busy ? "Streaming..." : undefined}
            >
              {reasoning ? (
                <Markdown
                  text={reasoning}
                  streaming={busy}
                  trailing={busy ? <StreamingCaret /> : null}
                />
              ) : (
                <Empty>
                  {busy ? "Reasoning will stream here..." : "No reasoning."}
                </Empty>
              )}
              <div className="mt-4 border-l-4 border-cl-blue bg-cl-ice/60 px-4 py-3 text-xs leading-relaxed text-cl-slate">
                Note: this is the model&apos;s reasoning <em>summary</em>, not
                its raw chain-of-thought (OpenAI does not expose the latter).
              </div>
            </Panel>

            <Panel
              title="Answer"
              className="mt-4"
              meta={busy ? "Streaming..." : undefined}
            >
              {answer ? (
                <Markdown
                  text={answer}
                  streaming={busy}
                  trailing={busy ? <StreamingCaret /> : null}
                />
              ) : (
                <Empty>
                  {busy ? "The answer will stream here..." : "No answer."}
                </Empty>
              )}
            </Panel>

            <Panel title={`Actions (${fanouts.length})`} className="mt-4">
              {fanouts.length === 0 ? (
                <Empty>
                  {busy
                    ? "Waiting for the model to act..."
                    : "No actions - the model may answer from its own knowledge."}
                </Empty>
              ) : (
                <FanoutTable fanouts={fanouts} />
              )}
            </Panel>

            <Panel
              title={`Sources (${sources.length} retrieved${citedCount > 0 ? ` · ${citedCount} cited` : ""})`}
              className="mt-4"
            >
              {sources.length === 0 ? (
                <Empty>No sources retrieved yet.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {sources.map((s) => (
                    <li key={s.url} className="flex min-w-0 items-start gap-2">
                      <Globe
                        className="mt-0.5 h-4 w-4 shrink-0 text-cl-blue"
                        aria-hidden="true"
                        strokeWidth={1.75}
                      />
                      <div className="min-w-0">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className={`inline-flex max-w-full items-center gap-1 font-medium text-cl-blue hover:underline ${focusRing}`}
                        >
                          <span className="truncate">{s.title || s.url}</span>
                          <ExternalLink
                            className="h-3.5 w-3.5 shrink-0"
                            aria-hidden="true"
                            strokeWidth={1.75}
                          />
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                        <div className="truncate text-xs text-slate-500">
                          {domain(s.url)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <details className="mt-4 rounded-card border border-cl-border bg-white">
              <summary
                className={`flex cursor-pointer items-center gap-2 px-5 py-3 text-sm font-bold uppercase tracking-wider text-cl-blue ${focusRing}`}
              >
                <Code2
                  className="h-4 w-4"
                  aria-hidden="true"
                  strokeWidth={1.75}
                />
                Raw event log ({raw.length})
              </summary>
              <pre className="max-h-96 overflow-auto border-t border-cl-border bg-cl-bg-soft p-4 font-mono text-[11px] leading-relaxed text-cl-slate">
                {raw
                  .map((ev, i) => `${i}\t${ev.type}\t${JSON.stringify(ev)}`)
                  .join("\n")}
              </pre>
            </details>
          </div>
        </main>
      </div>

      {mobileHistoryOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close history"
            className="absolute inset-0 cursor-default bg-slate-900/40"
            onClick={closeMobileHistory}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Run history"
            className="relative h-full w-[min(20rem,calc(100vw-2rem))] overflow-y-auto bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-cl-border p-4">
              <h2 className="text-sm font-bold uppercase tracking-wider text-cl-blue">
                History
              </h2>
              <button
                ref={closeHistoryButtonRef}
                type="button"
                aria-label="Close history"
                onClick={closeMobileHistory}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-btn border border-cl-border text-cl-blue hover:bg-cl-ice ${focusRing}`}
              >
                <X className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
              </button>
            </div>
            <div className="p-4">
              <HistoryList
                history={history}
                runId={runId}
                live={live}
                onReplay={replayFromHistory}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

const inputFocus =
  "focus:border-cl-blue focus:outline-none focus:ring-2 focus:ring-cl-blue/20";

function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="text-xs font-bold uppercase tracking-wider text-cl-blue"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function HistoryRail({
  history,
  runId,
  live,
  onRefresh,
  onReplay,
}: {
  history: RunSummary[];
  runId: string | null;
  live: boolean;
  onRefresh: () => void;
  onReplay: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Run history"
      className="hidden w-64 shrink-0 border-r border-cl-border bg-white p-4 md:block"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-cl-blue">
          History
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh history"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-btn text-cl-slate hover:bg-cl-ice hover:text-cl-blue ${focusRing}`}
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        </button>
      </div>
      <HistoryList
        history={history}
        runId={runId}
        live={live}
        onReplay={onReplay}
      />
    </nav>
  );
}

function HistoryList({
  history,
  runId,
  live,
  onReplay,
}: {
  history: RunSummary[];
  runId: string | null;
  live: boolean;
  onReplay: (id: string) => void;
}) {
  if (history.length === 0)
    return <p className="text-sm italic text-slate-500">No runs yet.</p>;

  return (
    <ul className="space-y-2">
      {history.map((h) => {
        const selected = h.id === runId;
        return (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onReplay(h.id)}
              disabled={live}
              aria-current={selected ? "true" : undefined}
              className={`w-full rounded-card border border-cl-border bg-white p-3 text-left hover:bg-cl-ice disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${
                selected ? "border-l-4 border-l-cl-blue bg-cl-ice pl-2" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-cl-blue">{h.model}</span>
                <StatusBadge status={h.status} />
              </div>
              <div
                className="mt-2 truncate text-sm text-cl-slate"
                title={h.query_preview || "(empty)"}
              >
                {h.query_preview || "(empty)"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {new Date(h.created_at).toLocaleString()}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({ status }: { status: BadgeStatus }) {
  const map: Record<BadgeStatus, { label: string; className: string }> = {
    idle: { label: "Idle", className: "bg-slate-100 text-slate-600" },
    running: { label: "Running", className: "bg-cl-yellow text-cl-navy" },
    completed: {
      label: "Completed",
      className: "bg-cl-success text-slate-900",
    },
    failed: { label: "Failed", className: "bg-cl-error text-slate-900" },
    cancelled: { label: "Cancelled", className: "bg-slate-200 text-slate-700" },
    incomplete: {
      label: "Incomplete",
      className: "bg-cl-warning text-slate-900",
    },
    in_progress: { label: "In progress", className: "bg-cl-ice text-cl-blue" },
    searching: { label: "Searching", className: "bg-cl-yellow text-cl-navy" },
  };
  const item = map[status];

  return (
    <span
      className={`inline-flex shrink-0 rounded-[3px] px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${item.className}`}
    >
      {item.label}
    </span>
  );
}

function KpiCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: number;
  sublabel: string;
}) {
  return (
    <div className="min-w-[180px] flex-1 rounded-card border border-cl-border bg-white p-5">
      <div className="text-xs font-bold uppercase tracking-wider text-cl-blue">
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums text-cl-blue md:text-4xl xl:text-5xl">
        {value}
      </div>
      <div className="mt-1 text-sm font-medium text-cl-slate">{sublabel}</div>
    </div>
  );
}

function Panel({
  title,
  children,
  className = "",
  meta,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  meta?: string;
}) {
  return (
    <section
      className={`rounded-card border border-cl-border bg-white ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-cl-border px-5 py-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-cl-blue">
          {title}
        </h2>
        {meta && (
          <span className="rounded-[3px] bg-cl-ice px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-cl-blue">
            {meta}
          </span>
        )}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm italic text-slate-500">{children}</p>;
}

function FanoutTable({ fanouts }: { fanouts: Fanout[] }) {
  return (
    <div className="overflow-x-auto rounded-card border border-cl-border">
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Actions</caption>
        <thead className="bg-cl-blue text-xs uppercase tracking-wider text-white">
          <tr className="h-11">
            <th scope="col" className="w-28 px-3 py-3 text-left font-bold">
              Action
            </th>
            <th scope="col" className="px-3 py-3 text-left font-bold">
              Query / URL
            </th>
            <th scope="col" className="w-36 px-3 py-3 text-left font-bold">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {fanouts.map((f) => {
            const action = describeAction(f.action);
            const Icon = action.icon;
            const detail = action.detail ?? "";
            return (
              <tr key={f.id} className="h-9 even:bg-cl-ice/50">
                <td className="whitespace-nowrap px-3 py-2 font-medium text-cl-slate">
                  <span className="inline-flex items-center gap-2">
                    <Icon
                      className="h-4 w-4 text-cl-blue"
                      aria-hidden="true"
                      strokeWidth={1.75}
                    />
                    {action.label}
                  </span>
                </td>
                <td className="px-3 py-2 align-top">
                  {action.details && action.details.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 leading-relaxed text-cl-slate marker:text-cl-blue">
                      {action.details.map((q, i) => (
                        <li key={i} className="whitespace-normal break-words">
                          {q}
                        </li>
                      ))}
                    </ul>
                  ) : action.href ? (
                    <a
                      href={action.href}
                      target="_blank"
                      rel="noreferrer"
                      title={detail}
                      className={`block whitespace-normal break-words font-medium leading-relaxed text-cl-blue hover:underline ${focusRing}`}
                    >
                      {detail}
                      <span className="sr-only">(opens in new tab)</span>
                    </a>
                  ) : (
                    <span
                      className="block whitespace-normal break-words leading-relaxed text-cl-slate"
                      title={detail}
                    >
                      {detail || "-"}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <StatusBadge status={f.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[1em] w-[2px] animate-pulse bg-cl-blue align-[-0.15em]"
    />
  );
}

function AlertBlock({ title, message }: { title: string; message: string }) {
  return (
    <div
      role="alert"
      className="mb-4 flex gap-3 rounded-card border border-l-4 border-cl-border border-l-cl-error bg-cl-ice/40 px-4 py-3"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 shrink-0 text-cl-error"
        aria-hidden="true"
        strokeWidth={1.75}
      />
      <div>
        <div className="font-bold text-slate-900">{title}</div>
        <div className="text-sm leading-relaxed text-cl-slate">{message}</div>
      </div>
    </div>
  );
}
