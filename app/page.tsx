"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Code2,
  Dot,
  Download,
  ExternalLink,
  FileText,
  GitCompare,
  Globe,
  History,
  RotateCcw,
  RotateCw,
  Trash2,
  ScanSearch,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type { OutputItem, RunStatus, StreamEvent } from "@/lib/events";
import {
  deriveRunState,
  describeAction,
  domain,
  normalizeUrl,
  type ActionKind,
  type Fanout,
  type Source,
} from "@/lib/derive";
import { DOCUMENTED_MODEL_FALLBACK } from "@/lib/model-options";
import { Markdown } from "./markdown";

const EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
const HISTORY_PAGE_SIZE = 20;

// Terminal statuses that didn't produce a finished answer — offer a retry.
const RETRYABLE: ReadonlySet<RunStatus> = new Set([
  "failed",
  "cancelled",
  "incomplete",
]);

type ViewStatus = "idle" | RunStatus;
type BadgeStatus = ViewStatus | Fanout["status"];

type RunSummary = {
  id: string;
  model: string;
  effort: string | null;
  status: RunStatus;
  created_at: string;
  query: string;
  query_preview: string;
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-blue focus-visible:ring-offset-2";

// Icon mapping for action kinds — the only UI-specific bit split out of the
// shared (icon-free) describeAction in lib/derive.ts.
const ACTION_ICONS: Record<ActionKind, LucideIcon> = {
  search: Search,
  open_page: FileText,
  find_in_page: ScanSearch,
  other: Dot,
};
function iconFor(kind: ActionKind): LucideIcon {
  return ACTION_ICONS[kind];
}

export default function Home() {
  const [models, setModels] = useState<string[]>(() => [...DOCUMENTED_MODEL_FALLBACK]);
  const [model, setModel] = useState<string>(DOCUMENTED_MODEL_FALLBACK[0]);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const [query, setQuery] = useState("");
  // The prompt of the run currently being shown (live or replayed). Kept apart
  // from the editable `query` so a loaded run always displays its own prompt.
  const [activePrompt, setActivePrompt] = useState<string | null>(null);

  const [status, setStatus] = useState<ViewStatus>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false); // a fetch stream is actively running

  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [consultedUrls, setConsultedUrls] = useState<Set<string>>(
    () => new Set(),
  );
  const [citedUrls, setCitedUrls] = useState<Set<string>>(() => new Set());
  const [citationCount, setCitationCount] = useState(0);
  const [reasoningParts, setReasoningParts] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [raw, setRaw] = useState<StreamEvent[]>([]);

  const [history, setHistory] = useState<RunSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeHistoryButtonRef = useRef<HTMLButtonElement | null>(null);

  const reasoning = reasoningParts.join("\n\n");
  const busy = status === "running";
  const searchCount = fanouts.filter((f) => f.action?.type === "search").length;
  const consultedCount = consultedUrls.size;
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

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      try {
        const r = await fetch("/api/models");
        if (!r.ok) return;
        const data = await r.json();
        const next = Array.isArray(data.models) ? data.models.filter(Boolean) : [];
        if (cancelled || next.length === 0) return;
        setModels(next);
        setModel((current) => (next.includes(current) ? current : next[0]));
      } catch {
        /* documented fallback remains available */
      }
    }
    loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  function closeMobileHistory() {
    setMobileHistoryOpen(false);
    window.setTimeout(() => historyButtonRef.current?.focus(), 0);
  }

  function reset() {
    setRunId(null);
    setActivePrompt(null);
    setError(null);
    setFanouts([]);
    setSources([]);
    setConsultedUrls(new Set());
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

  function addConsultedUrls(incoming: Source[]) {
    if (incoming.length === 0) return;
    setConsultedUrls((prev) => {
      const next = new Set(prev);
      for (const s of incoming) {
        if (s.url) next.add(normalizeUrl(s.url));
      }
      return next;
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
            const nextSources = srcs.map((s) => ({
              url: s.url,
              title: s.title ?? s.url,
            }));
            addConsultedUrls(nextSources);
            addSources(nextSources);
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

  // Load (or reload) the newest page, resetting pagination. Called on mount, by
  // the refresh button, and after a run finishes so latest statuses show.
  async function refreshHistory() {
    try {
      const r = await fetch(`/api/runs?limit=${HISTORY_PAGE_SIZE}`);
      if (!r.ok) return;
      const data = await r.json();
      setHistory(data.runs ?? []);
      setHistoryCursor(data.nextBefore ?? null);
      setHistoryHasMore(Boolean(data.hasMore));
    } catch {
      /* non-fatal */
    }
  }

  // Append the next older page via keyset cursor; dedupe by id for safety.
  async function loadMoreHistory() {
    if (!historyCursor || !historyHasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/runs?limit=${HISTORY_PAGE_SIZE}&before=${encodeURIComponent(historyCursor)}`,
      );
      if (!r.ok) return;
      const data = await r.json();
      const incoming: RunSummary[] = data.runs ?? [];
      setHistory((prev) => {
        const seen = new Set(prev.map((h) => h.id));
        return [...prev, ...incoming.filter((h) => !seen.has(h.id))];
      });
      setHistoryCursor(data.nextBefore ?? null);
      setHistoryHasMore(Boolean(data.hasMore));
    } catch {
      /* non-fatal */
    } finally {
      setLoadingMore(false);
    }
  }
  useEffect(() => {
    refreshHistory();
  }, []);

  function run() {
    return runWith({ query, model, effort });
  }

  // Re-run a previous prompt (e.g. a failed/cancelled one) as a fresh run,
  // replacing the old dead run so history keeps one card per prompt. Falls back
  // to the current form values for anything the summary doesn't carry.
  async function retry(h: RunSummary) {
    await deleteRun(h.id);
    return runWith({
      query: h.query,
      model: h.model,
      effort: (EFFORTS as readonly string[]).includes(h.effort ?? "")
        ? (h.effort as (typeof EFFORTS)[number])
        : effort,
    });
  }

  // Delete a run (row + events) from the DB and drop it from the UI. Used by the
  // history trashcan and by retry's replace step. Best-effort: a 404 (already
  // gone) is treated as success.
  async function deleteRun(id: string) {
    try {
      const r = await fetch(`/api/runs/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) return false;
    } catch {
      return false;
    }
    setHistory((prev) => prev.filter((h) => h.id !== id));
    setCompareIds((prev) => prev.filter((x) => x !== id));
    if (runId === id) {
      reset();
      setStatus("idle");
    }
    return true;
  }

  async function runWith(opts: {
    query: string;
    model: string;
    effort: (typeof EFFORTS)[number];
  }) {
    const q = opts.query.trim();
    if (!q || live) return;
    const { model: m, effort: e } = opts;

    // Reflect the run's params in the form so the UI matches what's running.
    setQuery(q);
    setModel(m);
    setEffort(e);

    reset();
    setActivePrompt(q);
    setStatus("running");
    setLive(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, query: q, effort: e }),
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
      // Restore the prompt (and the form fields) so the loaded run shows what
      // was asked and can be re-run. Guard model/effort against unknown values.
      setActivePrompt(run.query ?? "");
      setQuery(run.query ?? "");
      if (run.model) setModel(run.model);
      if (run.effort && (EFFORTS as readonly string[]).includes(run.effort))
        setEffort(run.effort as (typeof EFFORTS)[number]);
      // Derive the whole view in one shot via the shared reducer (the canonical
      // rule set, also used by the server markdown export) instead of replaying
      // events one-by-one through the live state setters.
      const payloads = (events as { payload: StreamEvent }[]).map(
        (e) => e.payload,
      );
      const d = deriveRunState(payloads);
      setRaw(payloads.slice(0, 5000));
      setReasoningParts(d.reasoningParts);
      setAnswer(d.answer);
      setFanouts(d.fanouts);
      setSources(d.sources);
      setConsultedUrls(d.consultedUrls);
      setCitedUrls(d.citedUrls);
      setCitationCount(d.citationCount);
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

  function toggleCompare(id: string) {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
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
          compareIds={compareIds}
          hasMore={historyHasMore}
          loadingMore={loadingMore}
          onToggleCompare={toggleCompare}
          onRefresh={refreshHistory}
          onReplay={replay}
          onRetry={retry}
          onDelete={deleteRun}
          onLoadMore={loadMoreHistory}
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
                  {models.map((m) => (
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
              {runId && !live && (
                <a
                  href={`/api/runs/${runId}/markdown`}
                  download
                  className={`ml-auto inline-flex h-9 items-center gap-2 rounded-btn border border-cl-border bg-white px-3 text-sm font-bold uppercase tracking-wider text-cl-blue hover:bg-cl-ice ${focusRing}`}
                >
                  <Download
                    className="h-4 w-4"
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                  Download Markdown
                </a>
              )}
            </div>

            {activePrompt && (
              <Panel title="Prompt" className="mb-4">
                <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-cl-slate">
                  {activePrompt}
                </p>
              </Panel>
            )}

            {error && <AlertBlock title="Run failed" message={error} />}

            <section className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard
                label="Actions"
                value={fanouts.length}
                sublabel={`${searchCount} ${searchCount === 1 ? "search" : "searches"}`}
              />
              <SourceMetrics
                consultedCount={consultedCount}
                citedCount={citedCount}
                referenceCount={citationCount}
              />
            </section>

            <details className="mb-4 rounded-card border border-cl-border bg-white px-4 py-3 text-sm text-cl-slate">
              <summary
                className={`cursor-pointer text-xs font-bold uppercase tracking-wider text-cl-blue ${focusRing}`}
              >
                What counts mean
              </summary>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="font-bold text-cl-blue">Actions</dt>
                  <dd>
                    <code>web_search_call</code> output items.
                  </dd>
                </div>
                <div>
                  <dt className="font-bold text-cl-blue">Search actions</dt>
                  <dd>
                    <code>web_search_call</code> items where{" "}
                    <code>action.type === &quot;search&quot;</code>.
                  </dd>
                </div>
                <div>
                  <dt className="font-bold text-cl-blue">Consulted URLs</dt>
                  <dd>
                    URLs from <code>web_search_call.action.sources</code>.
                  </dd>
                </div>
                <div>
                  <dt className="font-bold text-cl-blue">Cited URLs</dt>
                  <dd>
                    Unique URLs from <code>url_citation</code> annotations.
                  </dd>
                </div>
                <div>
                  <dt className="font-bold text-cl-blue">References</dt>
                  <dd>
                    Total <code>url_citation</code> annotation events.
                  </dd>
                </div>
              </dl>
            </details>

            <Panel
              title="Reasoning Summary"
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
              title={`Sources (${consultedCount} consulted${citedCount > 0 ? ` · ${citedCount} cited` : ""})`}
              className="mt-4"
            >
              {sources.length === 0 ? (
                <Empty>No sources consulted yet.</Empty>
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
                compareIds={compareIds}
                hasMore={historyHasMore}
                loadingMore={loadingMore}
                onToggleCompare={toggleCompare}
                onReplay={replayFromHistory}
                onRetry={retry}
                onDelete={deleteRun}
                onLoadMore={loadMoreHistory}
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
  compareIds,
  hasMore,
  loadingMore,
  onToggleCompare,
  onRefresh,
  onReplay,
  onRetry,
  onDelete,
  onLoadMore,
}: {
  history: RunSummary[];
  runId: string | null;
  live: boolean;
  compareIds: string[];
  hasMore: boolean;
  loadingMore: boolean;
  onToggleCompare: (id: string) => void;
  onRefresh: () => void;
  onReplay: (id: string) => void;
  onRetry: (h: RunSummary) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
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
        <div className="flex items-center gap-1">
          {history.length > 0 && (
            <a
              href="/api/runs/export"
              download
              aria-label="Export all runs as Markdown"
              title="Export all runs as Markdown"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-btn text-cl-slate hover:bg-cl-ice hover:text-cl-blue ${focusRing}`}
            >
              <Download
                className="h-4 w-4"
                aria-hidden="true"
                strokeWidth={1.75}
              />
            </a>
          )}
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh history"
            className={`inline-flex h-8 w-8 items-center justify-center rounded-btn text-cl-slate hover:bg-cl-ice hover:text-cl-blue ${focusRing}`}
          >
            <RotateCw
              className="h-4 w-4"
              aria-hidden="true"
              strokeWidth={1.75}
            />
          </button>
        </div>
      </div>
      <CompareBar compareIds={compareIds} />
      <HistoryList
        history={history}
        runId={runId}
        live={live}
        compareIds={compareIds}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onToggleCompare={onToggleCompare}
        onReplay={onReplay}
        onRetry={onRetry}
        onDelete={onDelete}
        onLoadMore={onLoadMore}
      />
    </nav>
  );
}

// Sticky call-to-action shown once 2+ runs are checked for comparison. Order of
// the ids is preserved so the comparison's A/B/C labels match selection order.
function CompareBar({ compareIds }: { compareIds: string[] }) {
  if (compareIds.length < 2) {
    return (
      <p className="mb-3 text-xs text-slate-500">
        Tick 2+ runs to compare which pages they share.
      </p>
    );
  }
  const ids = compareIds.join(",");
  return (
    <div className="mb-3 flex flex-col gap-2">
      <a
        href={`/api/runs/compare?ids=${ids}`}
        download
        className={`inline-flex w-full items-center justify-center gap-2 rounded-btn bg-cl-blue px-3 py-2 text-sm font-semibold text-white hover:bg-cl-navy ${focusRing}`}
      >
        <GitCompare className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        Compare {compareIds.length} runs
      </a>
      <a
        href={`/api/runs/compare/deep?ids=${ids}`}
        download
        title="Multi-resolution read-URL graph (CSV + JSON + Markdown, zipped)"
        className={`inline-flex w-full items-center justify-center gap-2 rounded-btn border border-cl-blue bg-white px-3 py-2 text-sm font-semibold text-cl-blue hover:bg-cl-ice ${focusRing}`}
      >
        <ScanSearch className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        Deep compare {compareIds.length} runs
      </a>
    </div>
  );
}

function HistoryList({
  history,
  runId,
  live,
  compareIds,
  hasMore,
  loadingMore,
  onToggleCompare,
  onReplay,
  onRetry,
  onDelete,
  onLoadMore,
}: {
  history: RunSummary[];
  runId: string | null;
  live: boolean;
  compareIds: string[];
  hasMore: boolean;
  loadingMore: boolean;
  onToggleCompare: (id: string) => void;
  onReplay: (id: string) => void;
  onRetry: (h: RunSummary) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
}) {
  if (history.length === 0)
    return <p className="text-sm italic text-slate-500">No runs yet.</p>;

  return (
    <>
      <ul className="space-y-2">
      {history.map((h) => {
        const selected = h.id === runId;
        const checked = compareIds.includes(h.id);
        const order = compareIds.indexOf(h.id);
        const fullPrompt = (h.query ?? "").trim();
        return (
          <li key={h.id} className="group relative">
            <button
              type="button"
              onClick={() => onReplay(h.id)}
              disabled={live}
              aria-current={selected ? "true" : undefined}
              className={`w-full rounded-card border border-cl-border bg-white p-3 pl-9 pr-10 text-left hover:bg-cl-ice disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${
                selected ? "border-l-4 border-l-cl-blue bg-cl-ice" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-cl-blue">{h.model}</span>
                <StatusBadge status={h.status} />
              </div>
              <div className="mt-2 truncate text-sm text-cl-slate">
                {h.query_preview || "(empty)"}
              </div>
              <div
                className={`mt-1 truncate text-xs text-slate-500 ${
                  RETRYABLE.has(h.status) ? "pr-24" : "pr-16"
                }`}
              >
                {new Date(h.created_at).toLocaleString()}
              </div>
            </button>
            {fullPrompt && (
              // Full-prompt popover: appears to the right of the card on hover or
              // keyboard focus (desktop rail only — md+). The transparent pl-2
              // bridges the gap so moving the cursor onto the panel doesn't dismiss
              // it, letting long prompts be scrolled.
              <div className="absolute left-full top-0 z-50 hidden pl-2 md:group-hover:block md:group-focus-within:block">
                <div
                  role="tooltip"
                  className="max-h-80 w-80 overflow-y-auto rounded-card border border-cl-border bg-white p-3 shadow-xl"
                >
                  <div className="mb-1 text-xs font-bold uppercase tracking-wider text-cl-blue">
                    Prompt
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-cl-slate">
                    {fullPrompt}
                  </p>
                </div>
              </div>
            )}
            <label
              className="absolute left-2 top-3 inline-flex cursor-pointer items-center"
              title="Select for comparison"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleCompare(h.id)}
                aria-label={`Select run for comparison${order >= 0 ? `, position ${order + 1}` : ""}`}
                className={`h-4 w-4 rounded border-cl-border text-cl-blue ${focusRing}`}
              />
              {order >= 0 && (
                <span className="ml-1 text-[10px] font-bold tabular-nums text-cl-blue">
                  {String.fromCharCode(65 + order)}
                </span>
              )}
            </label>
            {RETRYABLE.has(h.status) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry(h);
                }}
                disabled={live}
                aria-label="Retry this run"
                title="Retry"
                className={`absolute bottom-2 right-16 inline-flex h-7 w-7 items-center justify-center rounded-btn text-slate-400 hover:bg-white hover:text-cl-blue disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (
                  window.confirm("Delete this run? This can't be undone.")
                )
                  onDelete(h.id);
              }}
              disabled={live}
              aria-label="Delete this run"
              title="Delete"
              className={`absolute bottom-2 right-9 inline-flex h-7 w-7 items-center justify-center rounded-btn text-slate-400 hover:bg-white hover:text-cl-error disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
            </button>
            <a
              href={`/api/runs/${h.id}/markdown`}
              download
              onClick={(e) => e.stopPropagation()}
              aria-label="Download this run as Markdown"
              title="Download Markdown"
              className={`absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-btn text-slate-400 hover:bg-white hover:text-cl-blue ${focusRing}`}
            >
              <Download className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
            </a>
          </li>
        );
      })}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className={`mt-2 w-full rounded-btn border border-cl-border bg-white px-3 py-2 text-sm font-semibold text-cl-blue hover:bg-cl-ice disabled:opacity-50 ${focusRing}`}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </>
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

function SourceMetrics({
  consultedCount,
  citedCount,
  referenceCount,
}: {
  consultedCount: number;
  citedCount: number;
  referenceCount: number;
}) {
  return (
    <div className="min-w-[180px] flex-1 rounded-card border border-cl-border bg-white p-5">
      <div className="text-xs font-bold uppercase tracking-wider text-cl-blue">
        Sources
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SourceMetric label="Consulted URLs" value={consultedCount} />
        <SourceMetric label="Cited URLs" value={citedCount} />
        <SourceMetric label="References" value={referenceCount} />
      </dl>
    </div>
  );
}

function SourceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-cl-slate">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-bold tabular-nums text-cl-blue md:text-3xl">
        {value}
      </dd>
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
            const Icon = iconFor(action.kind);
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
