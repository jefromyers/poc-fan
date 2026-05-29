// Framework-agnostic derivation of run state from the stored/streamed event log.
//
// This is the single source of truth for turning a StreamEvent[] into the
// reasoning / answer / actions / sources the app surfaces. It is imported by
// BOTH the client (app/page.tsx replay path) and the server (markdown export),
// so it must stay free of React and lucide-react — no UI imports here.

import type { OutputItem, StreamEvent, WebSearchAction } from "@/lib/events";

export type Fanout = {
  id: string;
  action?: WebSearchAction;
  status: "in_progress" | "searching" | "completed";
};

export type Source = { url: string; title: string };

// Icon-free description of a web_search_call action. The UI maps `kind` to a
// lucide icon (see iconFor in app/page.tsx); the markdown export ignores icons.
export type ActionKind = "search" | "open_page" | "find_in_page" | "other";
export type ActionDescription = {
  kind: ActionKind;
  label: string;
  detail?: string;
  details?: string[];
  href?: string;
};

export type DerivedRunState = {
  reasoning: string; // reasoningParts.join("\n\n")
  reasoningParts: string[];
  answer: string;
  fanouts: Fanout[];
  sources: Source[]; // deduped by normalizeUrl
  consultedUrls: Set<string>;
  citedUrls: Set<string>;
  citationCount: number;
};

export function normalizeUrl(raw: string): string {
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

export function searchQueries(action: WebSearchAction): string[] {
  if (Array.isArray(action.queries)) {
    const filtered = action.queries.filter((q): q is string => Boolean(q));
    if (filtered.length > 0) return filtered;
  }
  return action.query ? [action.query] : [];
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function describeAction(action?: WebSearchAction): ActionDescription {
  switch (action?.type) {
    case "search": {
      const queries = searchQueries(action);
      return {
        kind: "search",
        label: "Search",
        detail: queries[0],
        details: queries.length > 1 ? queries : undefined,
      };
    }
    case "open_page":
      return {
        kind: "open_page",
        label: "Open",
        detail: action.url,
        href: action.url,
      };
    case "find_in_page":
      return {
        kind: "find_in_page",
        label: "Find",
        detail:
          action.pattern && action.url
            ? `"${action.pattern}" in ${action.url}`
            : (action.pattern ?? action.url),
        href: action.url,
      };
    default:
      return {
        kind: "other",
        label: titleCase(action?.type ?? "action"),
        detail: action ? JSON.stringify(action) : undefined,
      };
  }
}

// Pure fold over the event log. A 1:1 port of handleEvent in app/page.tsx —
// keep the two in sync; this reducer is the canonical rule set.
export function deriveRunState(events: StreamEvent[]): DerivedRunState {
  const reasoningParts: string[] = [];
  let answer = "";
  const fanouts: Fanout[] = [];
  const sources: Source[] = [];
  const sourceIndex = new Map<string, number>(); // normalizeUrl -> sources idx
  const consultedUrls = new Set<string>();
  const citedUrls = new Set<string>();
  let citationCount = 0;

  // Reasoning is tracked as parts so distinct summary blocks stay separate and
  // so `.done` events can replace a part's accumulated deltas with canonical text.
  const appendReasoning = (delta: string) => {
    if (reasoningParts.length === 0) reasoningParts.push(delta);
    else reasoningParts[reasoningParts.length - 1] += delta;
  };
  const finalizeReasoning = (text: string) => {
    if (reasoningParts.length === 0) reasoningParts.push(text);
    else reasoningParts[reasoningParts.length - 1] = text;
  };

  const addSources = (
    incoming: Source[],
    { preferIncomingUrl = false }: { preferIncomingUrl?: boolean } = {},
  ) => {
    for (const s of incoming) {
      if (!s.url) continue;
      const key = normalizeUrl(s.url);
      const existing = sourceIndex.get(key);
      if (existing === undefined) {
        sourceIndex.set(key, sources.length);
        sources.push(s);
      } else if (preferIncomingUrl) {
        sources[existing] = {
          ...sources[existing],
          url: s.url,
          title: s.title || sources[existing].title,
        };
      }
    }
  };

  const addConsultedUrls = (incoming: Source[]) => {
    for (const s of incoming) {
      if (s.url) consultedUrls.add(normalizeUrl(s.url));
    }
  };

  const setFanoutStatus = (itemId: string, next: Fanout["status"]) => {
    const f = fanouts.find((x) => x.id === itemId);
    if (f) f.status = next;
  };

  const upsertFanout = (item: OutputItem, status: Fanout["status"]) => {
    const idx = fanouts.findIndex((f) => f.id === item.id);
    if (idx === -1) {
      fanouts.push({ id: item.id, action: item.action, status });
    } else {
      fanouts[idx] = {
        ...fanouts[idx],
        action: item.action ?? fanouts[idx].action,
        status,
      };
    }
  };

  for (const ev of events) {
    switch (ev.type) {
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
        reasoningParts.push("");
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
        answer += ev.delta;
        break;
      case "response.output_text.done":
        answer = ev.text;
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
          citedUrls.add(normalizeUrl(ev.annotation.url));
          citationCount += 1;
        }
        break;

      default:
        // Other events (control frames, terminal status) don't affect derived
        // content; run status is read from the runs row, not derived here.
        break;
    }
  }

  return {
    reasoning: reasoningParts.join("\n\n"),
    reasoningParts,
    answer,
    fanouts,
    sources,
    consultedUrls,
    citedUrls,
    citationCount,
  };
}
