// Hand-written shapes for the stream events the UI parses. Deliberately partial:
// it covers the event types we render (plus loose optional fields) so the parser
// is type-checked, while a boundary cast at JSON.parse keeps us tolerant of
// unrecognized / future event types (which fall through to the switch default).
// Same shapes apply whether events arrive live over SSE or are replayed from the
// stored `events` rows.

export type WebSearchAction = {
  type?: string; // "search" | "open_page" | "find_in_page" | future variants
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  sources?: { url: string; title?: string }[];
};

export type OutputItem = {
  id: string;
  type: string; // "web_search_call" | "message" | "reasoning" | ...
  action?: WebSearchAction; // present on web_search_call items
  status?: string;
};

export type UrlCitation = { type: string; url: string; title?: string };

export type StreamEvent =
  // Synthetic control frames emitted by our own route.
  | { type: "run.created"; run_id: string }
  | { type: "stream.done" }
  | { type: "stream.error"; error: string }
  // OpenAI Responses streaming events we handle.
  | { type: "response.created" }
  | { type: "response.in_progress" }
  | { type: "response.output_item.added"; item: OutputItem }
  | { type: "response.output_item.done"; item: OutputItem }
  | { type: "response.web_search_call.in_progress"; item_id: string }
  | { type: "response.web_search_call.searching"; item_id: string }
  | { type: "response.web_search_call.completed"; item_id: string }
  | { type: "response.reasoning_summary_part.added" }
  | { type: "response.reasoning_summary_text.delta"; delta: string }
  | { type: "response.reasoning_summary_text.done"; text: string }
  | { type: "response.reasoning_text.delta"; delta: string }
  | { type: "response.reasoning_text.done"; text: string }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.output_text.done"; text: string }
  | { type: "response.output_text.annotation.added"; annotation: UrlCitation }
  | { type: "response.completed"; response: unknown }
  | { type: "response.incomplete"; response: unknown }
  | { type: "response.failed"; response?: { error?: { message?: string } } };

// Terminal run states stored in runs.status and shown in the UI.
export type RunStatus =
  | "running"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";
