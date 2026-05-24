# Accuracy Audit

Date: 2026-05-24

Scope: current Thinking Inspector UI and server behavior as implemented in `app/page.tsx`, `app/markdown.tsx`, `app/api/runs/route.ts`, and `lib/events.ts`. This audit is limited to accuracy of claims in the UI against OpenAI's official API documentation. It does not evaluate model answer correctness.

Primary official sources used:

- OpenAI Web search guide: https://developers.openai.com/api/docs/guides/tools-web-search
- OpenAI Responses streaming API reference: https://developers.openai.com/api/reference/resources/responses/streaming
- OpenAI Responses create API reference: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI Reasoning models guide: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI Models page: https://developers.openai.com/api/docs/models

Note on uncertainty: where the docs define a field shape but not an operational guarantee, this report treats the stronger operational claim as unknown or potentially misleading.

## Input Row: Model

### What we show

The UI shows a `Model` select with: `gpt-5.5`, `gpt-5.4`, `gpt-5`, `gpt-5-mini`, and `o4-mini`. The server accepts exactly those strings and passes the selected value as the Responses API `model`.

### API source

The request source of truth is the `model` request parameter sent to `client.responses.create(...)`.

The official Models page currently foregrounds `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`. It says `gpt-5.5` is the flagship starting point and lists model IDs and capabilities for `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.

### Verdict: misleading

The label `Model` is accurate: the selected value is the model value sent to OpenAI.

The option set is potentially misleading:

- `gpt-5.5` and `gpt-5.4` are supported by the visible current docs.
- The docs page visible in this audit does not list `gpt-5-mini` or `o4-mini` in the primary model table. That does not prove the API rejects them, but the UI gives no indication that some options may be legacy, less current, or not documented in the current primary model page.
- The context says the app currently uses `gpt-5/gpt-5-mini`, but the actual current UI defaults to `gpt-5.5`.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/models

Quote: "`Model ID gpt-5.5`"

https://developers.openai.com/api/docs/models

Quote: "`Model ID gpt-5.4`"

Paraphrase: the same page recommends `gpt-5.5` as the default starting point and `gpt-5.4-mini` or `gpt-5.4-nano` for lower latency/cost. It does not visibly list `gpt-5-mini` or `o4-mini` in the captured primary table.

## Input Row: Reasoning Effort

### What we show

The UI shows `Reasoning Effort` with options `low`, `medium`, and `high`. The server passes `reasoning: { effort, summary: "detailed" }` to the Responses API.

### API source

The source of truth is the Responses API `reasoning.effort` request parameter and the selected model's supported effort values.

### Verdict: accurate but incomplete

The label is accurate: the value is sent as `reasoning.effort`.

The options are incomplete. The official reasoning guide says supported values are model-dependent and can include more than `low`, `medium`, and `high`. The current Models page lists `none`, `low`, `medium`, `high`, and `xhigh` for `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`. The UI does not offer `none` or `xhigh`, and it does not tell the user that supported values vary by model.

The UI also does not explain that effort affects latency/cost/token use and quality tradeoffs rather than deterministically changing the amount of visible reasoning.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/reasoning

Quote: "`reasoning.effort`"

https://developers.openai.com/api/docs/models

Quote: "`none low medium high xhigh`"

Paraphrase: the reasoning guide says supported values are model-dependent and that lower effort favors speed/lower token usage while higher effort favors more complete thinking.

## Input Row: Query

### What we show

The UI labels the user input as `Query` and uses placeholder text: `Ask something that needs current info...`. The form role is `search`. The server sends the trimmed value as the Responses API `input`.

### API source

The source of truth is the Responses API `input` field, not a web search query field. The model may decide whether to invoke the `web_search` tool because the server sets `tools: [{ type: "web_search" }]` and does not force tool use.

### Verdict: misleading

The field is not literally a web search query. It is the model input prompt. Calling it `Query` is understandable, but in a Thinking Inspector context it can imply that the user text is directly sent to web search. In Responses API web search, the model may search or may answer without searching, and if it searches it may generate its own search queries.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "model can choose to search"

Paraphrase: the guide explains that in Responses API, web search is configured in `tools`, and the model can decide whether to use it.

## Overall Status Badge

### What we show

The UI shows `Status: Idle`, `Running`, `Completed`, `Incomplete`, `Failed`, or `Cancelled`. During a live run, it sets `running` locally before receiving OpenAI events. Terminal states are set from `response.completed`, `response.incomplete`, `response.failed`, stream errors, or client abort handling. Replayed runs use the stored `runs.status`.

### API source

For OpenAI terminal events:

- `response.completed` means the model response is complete.
- `response.incomplete` means the response finished as incomplete.
- `response.failed` means the response failed.

The API response object also has a `status` field with `completed`, `failed`, `in_progress`, `cancelled`, `queued`, or `incomplete`.

### Verdict: mostly accurate

`Completed`, `Incomplete`, and `Failed` are accurate when driven by OpenAI terminal events.

`Running` is an app state, not necessarily a direct reflection of `response.in_progress`, because the UI sets it before OpenAI confirms `response.created` or `response.in_progress`.

`Cancelled` is currently an app/server state caused by client abort or disconnect. It is not shown from an OpenAI `response.cancelled` streaming event in this implementation. The Responses API status enum includes `cancelled`, but the UI's live cancellation can mean "we aborted the local stream and finalized our DB run as cancelled", not necessarily "OpenAI returned a completed Response object with status cancelled".

### Doc evidence with URL + quote

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "model response is complete"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "`completed`, `failed`, `in_progress`, `cancelled`, `queued`, or `incomplete`"

Paraphrase: the streaming reference defines separate events for completed, incomplete, and failed response outcomes.

## KPI: Actions

### What we show

Example: `Actions (6)` / `2 searches`. The numeric value is `fanouts.length`, where each entry is a `web_search_call` output item. The sublabel counts only actions where `action.type === "search"`.

### API source

The source of truth is `response.output_item.added` / `response.output_item.done` events whose item type is `web_search_call`, plus the `web_search_call.action.type` value.

OpenAI documents `web_search_call.action` as `search`, `open_page`, or `find_in_page`.

### Verdict: misleading

`Actions` is directionally accurate: the table is showing web search tool call actions. However, the number is not a count of all model actions; it is only a count of `web_search_call` output items. The model may also produce message and reasoning output items, and the app does not count those as actions.

`2 searches` is also potentially misleading because it counts search action objects, not the number of parallel query strings inside `action.queries`. A single `search` action can contain multiple `queries`, and users may reasonably read "2 searches" as "2 query strings were searched."

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "`web_search_call` output item"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "The search queries."

Paraphrase: the web search guide describes a response using web search as containing a web search call output item and a message output item. The create reference documents `queries` as an array on the search action.

## KPI: Sources

### What we show

Example: `Sources (28 retrieved [middle dot] 3 sources cited (10 references))`.

Implementation details:

- `sources.length` is the size of a deduplicated union of:
  - `web_search_call.action.sources` URLs from completed web search calls.
  - URL citation annotations received from `response.output_text.annotation.added`.
- `citedCount` is the size of a normalized URL set from `url_citation` annotations.
- `citationCount` increments for every `url_citation` annotation event, including repeated references to the same URL.

### API source

The sources source of truth is `web_search_call.action.sources`, included because the request sets `include: ["web_search_call.action.sources"]`.

The citation source of truth is `url_citation` annotations in message output text and `response.output_text.annotation.added` streaming events.

### Verdict: misleading

`3 sources cited (10 references)` is a reasonable UI distinction if interpreted as:

- 3 distinct normalized cited URLs.
- 10 citation annotation events.

However, the exact displayed `retrieved` count is not a pure API field. It is a local deduplicated union of retrieved source URLs and cited URLs. It may differ from the raw `action.sources` count because:

- The app normalizes URLs by lowercasing hostnames, stripping trailing slashes, and removing `utm_*` params.
- The app adds cited URLs into the same `sources` list even if they were not already present in `action.sources`.
- The docs say `sources` returns URLs; the app's `Source` type also has a title, but `action.sources` is documented as URL sources, not titled sources.

The word `retrieved` is supported by the web search guide in broad terms, but the UI count should be labeled as an app-normalized source count, not a raw API count.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "all URLs retrieved during a web search"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "Include the sources"

Paraphrase: the guide distinguishes source URLs from inline citations and says the number of sources is often greater than the number of citations.

## Actions Table: Search Rows and Bulleted Queries

### What we show

For `action.type === "search"`, the table label is `Search`. If the API action has multiple `queries`, the UI renders them as a bulleted list under `Query / URL`. If there is one query, it renders a single text value. The row status is one of `In progress`, `Searching`, or `Completed`.

### API source

The action data comes from `web_search_call.action`. For search actions:

- `type` is `search`.
- `queries` is an optional array.
- `query` exists but is deprecated.
- `sources` can appear when requested via `include`.

The row status comes from streaming lifecycle events (`response.web_search_call.in_progress`, `response.web_search_call.searching`, `response.web_search_call.completed`) and from `response.output_item.done`.

### Verdict: accurate with caveats

The `Search` label is accurate. The bulleted list is more accurate than joining with pipes because OpenAI documents `queries` as an array.

Caveats:

- The docs say search actions "usually (but not always)" include search queries. The UI can show a dash if no query detail arrives; that is honest but not explanatory.
- The list is a list of query strings OpenAI reports for that search action. The docs do not explicitly say the query strings ran in parallel. The app should be careful about adding language such as "parallel" unless it is based on observed behavior or a separate OpenAI guarantee.
- `Completed` per row means the web search call completed, not that the model has finished the full response and not that each retrieved page was factually used in the final answer.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "represents a web search"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "`query` [DEPRECATED]"

Paraphrase: the guide says the search action usually includes the search queries; the API reference defines `queries` as the search queries and `query` as deprecated.

## Actions Table: Open Rows

### What we show

For `action.type === "open_page"`, the table label is `Open`, and the `Query / URL` cell is a clickable URL. The row has a lifecycle status badge.

### API source

The source of truth is `web_search_call.action.type === "open_page"` and `action.url`.

### Verdict: accurate

The `Open` label accurately maps to OpenAI's `open_page` action. The URL cell accurately shows the URL opened by the model when present.

Caveat: `open_page` is supported in reasoning models, so its absence in some runs does not imply the model failed to inspect search results. The UI does not currently explain this, but the label itself is accurate.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "page being opened"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "URL opened by the model"

Paraphrase: the guide says `open_page` is supported in reasoning models.

## Actions Table: Find Rows

### What we show

For `action.type === "find_in_page"`, the table label is `Find`, and the detail is `"pattern" in URL` when both are present. The URL is clickable. The row has a lifecycle status badge.

### API source

The source of truth is `web_search_call.action.type === "find_in_page"`, `action.pattern`, and `action.url`.

### Verdict: accurate

The `Find` label accurately maps to OpenAI's `find_in_page` action. The app correctly treats `pattern` as text searched within the page.

Caveat: `Find` does not mean the answer cites that page. It means the web search tool call performed a find action within a page as reported by OpenAI.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "searching within a page"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "pattern within a loaded page"

Paraphrase: the API reference defines the `url` as the page searched for that pattern.

## Actions Table: Row Status

### What we show

Each action row has a status badge: `In progress`, `Searching`, or `Completed`. The app updates this from web search lifecycle events and sets `Completed` again when the corresponding `response.output_item.done` event arrives.

### API source

The source of truth is:

- `response.web_search_call.in_progress`
- `response.web_search_call.searching`
- `response.web_search_call.completed`
- `response.output_item.done` for an item with `type === "web_search_call"`

### Verdict: accurate but narrow

The row status is accurate as a web search tool call lifecycle indicator.

It would be misleading if users interpret row `Completed` as "this source was cited", "the final answer is complete", or "the model successfully verified the page contents." The docs only define it as completion of the web search call lifecycle.

### Doc evidence with URL + quote

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "web search call is completed"

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "output item is marked done"

Paraphrase: the streaming reference also defines separate `in_progress` and `searching` events for web search calls.

## Sources List

### What we show

The `Sources` panel title shows `Sources (N retrieved [middle dot] M cited)` when citations exist. The list displays each source as a link with a title if available and a domain below it.

Implementation details:

- Sources from `action.sources` usually have URL only per docs; the app maps `title` to the URL for these.
- Citation annotations can provide URL and title; if they duplicate a retrieved source, the app updates the URL/title with the citation metadata.
- Sources are deduplicated by a local normalized URL key.

### API source

The source URL list comes from `web_search_call.action.sources` and URL citation annotation events.

### Verdict: misleading

The list is useful, but the label `Sources` mixes two API concepts:

- Retrieved/consulted sources from `action.sources`.
- Cited sources from `url_citation` annotations.

Because the app merges both into one list, a source can appear because it was cited even if no `action.sources` event was captured for it. Conversely, a retrieved source can appear even if it is never cited in the final answer. The panel title partially disambiguates this with retrieved/cited counts, but the list does not mark individual rows as retrieved-only, cited-only, or both.

The docs support the notion that `sources` can be broader than citations. The UI should make that distinction visible at row level if this is stakeholder-facing.

### Doc evidence with URL + quote

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "The sources used in the search."

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "complete list of URLs"

Paraphrase: OpenAI's web search guide says sources are distinct from inline citations and often greater in number.

## Reasoning Panel

### What we show

The panel is titled `Reasoning`. It streams markdown-rendered reasoning text. A note says: "this is the model's reasoning summary, not its raw chain-of-thought (OpenAI does not expose the latter)."

Implementation details:

- The server requests `reasoning: { effort, summary: "detailed" }`.
- The UI consumes `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta`, and `response.reasoning_summary_text.done`.
- The UI also consumes `response.reasoning_text.delta` and `response.reasoning_text.done` into the same panel.

### API source

For current intended behavior, the source of truth is the reasoning summary stream. The reasoning guide says summaries are opt-in via the `summary` parameter and appear in reasoning output items.

### Verdict: mostly accurate, with one important edge-case

The explanatory note is accurate for reasoning summary events: the UI is not showing raw chain-of-thought; it is showing an OpenAI-provided reasoning summary.

The panel title `Reasoning` is slightly broad. `Reasoning Summary` would be more precise.

The important edge case: the UI also handles `response.reasoning_text.*` events and appends them to the same panel. The streaming API reference documents reasoning text events separately from reasoning summary text events. If those events are ever emitted for this request/model, the panel note "this is the model's reasoning summary" may become inaccurate for that content. I did not find an official doc statement that `response.reasoning_text.*` events are guaranteed not to occur when requesting summaries.

### Doc evidence with URL + quote

https://developers.openai.com/api/docs/guides/reasoning

Quote: "reasoning summary"

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "reasoning text is completed"

Paraphrase: the reasoning guide says raw reasoning tokens are not exposed and that summary output requires opting in. The streaming reference separately defines reasoning summary text and reasoning text events.

## Answer Panel

### What we show

The `Answer` panel renders streamed `response.output_text.delta` content and replaces it with final `response.output_text.done.text` when available. It renders markdown using `react-markdown` and GFM. Inline markdown links in the model text become clickable links.

### API source

The source of truth is Responses streaming text events:

- `response.output_text.delta`
- `response.output_text.done`

For citations, the source of truth is `response.output_text.annotation.added` events and final message annotations. The app uses annotation events only for the Sources/citation counts, not to place links at `start_index`/`end_index` in the rendered answer.

### Verdict: answer text accurate; citation rendering incomplete

The answer text is accurate to the streamed API text because the UI appends deltas and then replaces with the final text on `output_text.done`.

Markdown rendering is a local presentation choice. The API returns text; the docs do not say that Responses output text is guaranteed to be Markdown. Rendering Markdown is acceptable when the model emits Markdown, but the UI should not imply that markdown structure has special API meaning.

Citation rendering is incomplete. OpenAI requires inline citations for web results to be clearly visible and clickable. The model's output may include inline citations in the text, and annotations provide URL/title/location. The app makes markdown links clickable if the text contains markdown links, but it does not use annotation `start_index`/`end_index` to ensure citation spans are clickable. If the model emits non-markdown inline citation markers plus annotations, those markers may not become clickable in the answer panel.

The docs do not state that every markdown link in `output_text` corresponds to a `url_citation` annotation, nor that every `url_citation` annotation will appear as a Markdown link. Treat model-authored markdown links and `url_citation` annotations as related but distinct unless a specific event proves the relationship.

### Doc evidence with URL + quote

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "`response.output_text.delta`"

https://developers.openai.com/api/reference/resources/responses/methods/create

Quote: "first character"

https://developers.openai.com/api/docs/guides/tools-web-search

Quote: "inline citations"

Paraphrase: the streaming reference defines text delta and finalized text events. The create reference defines `url_citation.start_index` and `end_index` as character positions in the message. The web search guide requires inline citations to be visible and clickable.

## Raw Event Log

### What we show

The collapsible raw event log shows `raw.length` and each event type plus JSON payload.

### API source

For live runs, events are persisted before being forwarded to the browser. For replayed runs, events come from the DB.

### Verdict: accurate for captured/forwarded events

This is the most defensible audit surface in the UI because it exposes the actual stored event payloads the app saw. It is not a complete OpenAI trace beyond the streamed events received and persisted by this server.

### Doc evidence with URL + quote

https://developers.openai.com/api/reference/resources/responses/streaming

Quote: "server-sent events"

Paraphrase: the streaming reference says creating a Response with streaming enabled emits server-sent events while the Response is generated.

## Top Concerns

1. `Sources (N retrieved...)` is the highest-risk wording. The displayed number is not a raw API count; it is a local normalized union of `action.sources` and citation URLs. This can mislead a careful viewer who expects `retrieved` to mean exactly the `web_search_call.action.sources` array count.

2. The Sources list mixes retrieved/consulted and cited sources without row-level labeling. Stakeholders may infer every listed source was cited or every cited source came from the same retrieval set, but the UI does not prove either at row level.

3. The `Actions` KPI counts only `web_search_call` output items, not all model actions or all output items. The sublabel `2 searches` counts `search` action objects, not individual query strings.

4. The `Query` input label can imply the user text is the web search query. In Responses API, it is model input; the model may choose whether to search and may generate different search queries.

5. The Answer panel does not use `url_citation.start_index`/`end_index` to make citation spans clickable. It relies on Markdown links in the text plus a separate Sources panel. That may not satisfy the spirit of OpenAI's citation display requirement for all output shapes.

6. `Reasoning` should more precisely say `Reasoning Summary`. The note is accurate for summary events, but the code also consumes `reasoning_text` events into the same panel.

7. The model list appears stale or mixed. Current visible docs foreground `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`, while the UI includes `gpt-5-mini` and `o4-mini` and omits `gpt-5.4-mini`.

## Recommendations

1. Rename the Sources KPI wording from `retrieved` to `source URLs shown` or split it into raw API-backed metrics:
   - `Retrieved URLs`: count only `web_search_call.action.sources`.
   - `Cited URLs`: distinct normalized `url_citation.url`.
   - `References`: total `url_citation` annotation events.

2. Add per-row badges in the Sources list: `retrieved`, `cited`, or `retrieved + cited`. Keep separate raw URL values internally so normalization does not hide count differences without disclosure.

3. Rename `Actions` to `Web search actions` or `Web tool calls`. Rename the sublabel from `2 searches` to `2 search actions`, and optionally add `N query strings` when `action.queries` contains fan-out query arrays.

4. Rename the input label from `Query` to `Prompt` or `User input`. If keeping `Query`, add concise helper text outside the main UI or a tooltip: "The model may rewrite this into one or more web search queries."

5. Render citations from annotations in the Answer panel. Use `url_citation.start_index` and `end_index` to link or decorate the cited text span when possible, and keep Markdown links as presentation only. This would align the visible answer with the annotation source of truth.

6. Rename the `Reasoning` panel to `Reasoning Summary`. If `response.reasoning_text.*` events are intentionally supported, display them separately or change the note to distinguish summary content from reasoning text content.

7. Update the model list to match current documented model IDs or label legacy options. Consider adding `gpt-5.4-mini` and exposing `none`/`xhigh` reasoning values only for models that support them.

8. Add a small "What counts mean" disclosure near KPIs for stakeholder demos. It should define:
   - Actions = `web_search_call` output items.
   - Search actions = `web_search_call.action.type === "search"`.
   - Retrieved = URLs from `web_search_call.action.sources` if you keep that term.
   - Cited = `url_citation` annotation URLs.
   - References = `url_citation` annotation occurrences.
