# PLAN — Model Thinking Inspector (POC)

A webpage where you pick an OpenAI model, type a query, and watch the model's
"thinking" unfold: the **search fan-outs** (sub-queries it issues), the
**sources** it pulls from, and its **reasoning** streamed live — with the final
reasoning and answer shown when done. Every raw stream event plus the final
assembled response is persisted for later inspection.

---

## 1. Stack choice

**Next.js (App Router, TypeScript) + Postgres, all in Docker Compose.**

One framework gives us the static page *and* a server-side streaming proxy in
the same deploy — important because the OpenAI key must never reach the browser
and we need a server in the middle to (a) hold the SSE connection to OpenAI and
(b) tee every event to both the browser and the database. A Next.js Route
Handler (Node runtime) does exactly this with `ReadableStream`. Postgres with
`JSONB` is the natural fit for "store the raw event blobs verbatim but still
query them later." **Redis is not needed for this POC** (single server holds the
stream; no fan-out to multiple consumers) — I note below where it would earn its
place if we scaled.

---

## 2. High-level architecture

```
 Browser                    Next.js server (Node runtime)              OpenAI
 ┌──────────────┐  POST     ┌─────────────────────────────┐  Responses API
 │ React page   │ ────────► │ /api/runs                   │  (stream=true)
 │ - dropdown   │  {model,  │  1. INSERT run (status=run) │ ───────────────►
 │ - query box  │   query}  │  2. open OpenAI stream      │ ◄───────────────
 │ - live panels│ ◄──────── │  3. for each event:         │   SSE events
 │              │  SSE      │       a. persist event row  │
 └──────────────┘ (re-emit) │       b. re-emit to browser │
                            │  4. on done: UPDATE run     │
                            │     (status, final_response)│
                            └──────────────┬──────────────┘
                                           │
                                    ┌──────▼──────┐
                                    │  Postgres   │
                                    │ runs/events │
                                    └─────────────┘
```

**Flow:** The browser `POST`s `{model, query, effort}` to `/api/runs` and reads
the response body as a stream (fetch + `ReadableStream`, not `EventSource`, so we
can POST a body). For each event the server **persists the `events` row first,
then** re-emits it as SSE (`data: {...}\n\n`) — the DB is the source of truth, so
the browser never sees an event that isn't already stored. Terminal events
(`response.completed` / `incomplete` / `failed`) write the final status + assembled
`final_response` to the `runs` row. The client renders incrementally as events arrive.

**Decoupled pump + cancellation.** The OpenAI consumption runs as a detached
background task, *not* tied to the response stream's lifecycle, because Next.js
tears down the awaited request scope on client disconnect (which otherwise
orphaned runs at `running`). On disconnect/Stop, `req.signal` (and the stream's
`cancel()`) abort the OpenAI request — stopping token billing — and finalize the
run as **`cancelled`** (not `failed`); events received before the abort stay
persisted. Because this SDK's async iterator can hang rather than reject on abort,
we (a) finalize directly in the disconnect handler and (b) race each iterator step
against the abort so the pump terminates cleanly instead of leaking.

**Read path (inspection).** `GET /api/runs` lists recent runs and `GET
/api/runs/:id` returns the run row plus all `events` ordered by `seq`. The UI's
history rail lists past runs; selecting one **replays** it through the very same
event handler used for the live stream, fed from stored events instead of SSE.

---

## 3. Data model (Postgres)

Raw events are the source of truth; the parsed `final_response` is a
convenience snapshot. We deliberately avoid over-normalizing for a POC — the UI
can derive fan-outs / sources / reasoning from the raw event log or the final
object.

**`runs`**

| column           | type        | notes                                            |
|------------------|-------------|--------------------------------------------------|
| `id`             | uuid PK     | generated server-side                            |
| `created_at`     | timestamptz | default now()                                    |
| `model`          | text        | e.g. `gpt-5.5`                                    |
| `query`          | text        | user's prompt                                     |
| `effort`         | text        | reasoning effort: `low` \| `medium` \| `high`     |
| `status`         | text        | `running`\|`completed`\|`incomplete`\|`failed`\|`cancelled` |
| `final_response` | jsonb       | the assembled `response` object (raw, verbatim)  |
| `usage`          | jsonb       | token usage from the final response              |
| `error`          | text        | populated on failure                             |

**`events`** — every streamed event, verbatim.

| column       | type        | notes                                          |
|--------------|-------------|------------------------------------------------|
| `id`         | bigserial PK|                                                |
| `run_id`     | uuid FK     | → runs.id, indexed                             |
| `seq`        | int         | server-assigned order (OpenAI `sequence_number`)|
| `type`       | text        | event type, e.g. `response.output_text.delta`  |
| `payload`    | jsonb       | the full raw event                             |
| `created_at` | timestamptz | default now()                                  |

Index: `(run_id, seq)`. Replaying a run = `SELECT payload FROM events WHERE
run_id=$1 ORDER BY seq`.

**Stored raw vs. parsed:**
- *Raw:* every `events.payload` and `runs.final_response` — untouched JSON.
- *Parsed (derived at read time, not stored):* fan-out query list, source/citation
  list, reasoning summary text. If we later want them queryable, add optional
  tables (`web_searches`, `citations`, `reasoning_summaries`) populated from the
  raw log — not required for the POC.

---

## 4. UI sketch

Single page. Top: controls. Below: a four-region "thinking" dashboard that fills
in live, plus a collapsible raw log.

```
┌────────────────────────────────────────────────────────────────────┐
│  [Model ▾ gpt-5.5][Effort ▾ medium][ query…              ] [Run]     │
├──────────────────────────┬───────────────────────────────────────────┤
│  SEARCH FAN-OUTS         │  SOURCES                                  │
│  ┌────────────────────┐  │  • cuomo housing plan — nytimes.com  ↗    │
│  │ "nyc rent 2026"  ⟳ │  │  • 2026 rent guidelines — nyc.gov    ↗    │
│  │ "rent board vote" ✓│  │  • …                                      │
│  │ "RGB increase %"  ✓│  │  (deduped cited URLs, title + domain)     │
│  └────────────────────┘  │                                           │
├──────────────────────────┴───────────────────────────────────────────┤
│  REASONING  (streams live ▌ then shows final)                        │
│  Breaking the question into rent-board actions and recent votes…     │
├──────────────────────────────────────────────────────────────────────┤
│  ANSWER  (streams live)                                              │
│  The 2026 guidelines raised stabilized rents by …                    │
├──────────────────────────────────────────────────────────────────────┤
│  ▸ Raw event log (collapsed) — JSON, in arrival order                │
└──────────────────────────────────────────────────────────────────────┘
```

- **Command bar:** model dropdown, **reasoning-effort selector** (`low` /
  `medium` / `high`, passed through as `reasoning.effort`), query box, Run button.
- **Search fan-outs:** one card per `web_search_call`, showing the action it took
  and a status chip that advances `in_progress → searching ✓`. The action varies —
  we render all three variants found in `web_search_call.action`:
  - `search` → 🔍 the sub-query string (the classic fan-out)
  - `open_page` → 📄 a specific URL the model opened
  - `find_in_page` → 🔎 a pattern searched *within* an opened page
  The model often issues several of these; each is its own card.
- **Sources:** deduped list of cited URLs from text annotations (title + domain
  + outbound link). Grows as citations are emitted.
- **Reasoning:** streams token-by-token with a live cursor; once the matching
  `.done` fires, the cursor stops and the completed text stays. We append deltas
  from **both** `reasoning_summary_text.delta` and `reasoning_text.delta`, since
  some models/configs emit reasoning text directly rather than a summary. (See
  risk note: OpenAI exposes a *summary*, not raw chain-of-thought.)
- **Answer:** final assembled answer text, also streamed.
- **Raw log:** collapsible, for the "inspect everything" audience.

---

## 5. OpenAI Responses API events → UI mapping

Request: `responses.create({ model, input, stream: true, tools:
[{type:"web_search"}], reasoning: { effort, summary: "detailed" }, include:
["web_search_call.action.sources"] })`. `effort` comes from the UI selector;
`reasoning.summary` is required to get reasoning text; `include` surfaces the
search result sources.

| Event type                                  | What we do                                              |
|---------------------------------------------|---------------------------------------------------------|
| `response.created` / `.in_progress`         | mark run started; show spinner                          |
| `response.output_item.added`                | new item began; if `web_search_call`, create a fan-out card with its `action` |
| `response.web_search_call.in_progress`      | card → "in progress" (keyed by `item_id`)               |
| `response.web_search_call.searching`        | card → "searching"                                      |
| `response.web_search_call.completed`        | card → done ✓                                            |
| `response.output_item.done`                 | if `web_search_call`, finalize card `action` + harvest `action.sources` |
| `response.reasoning_summary_part.added`     | start a new reasoning block (separator)                 |
| `response.reasoning_summary_text.delta`     | append to live reasoning panel (token stream)           |
| `response.reasoning_text.delta` / `.done`   | append/freeze reasoning text (direct-text models)       |
| `response.reasoning_summary_text.done`      | freeze final reasoning text                             |
| `response.output_text.delta`                | append to live Answer panel                             |
| `response.output_text.annotation.added`     | add/dedupe a cited URL in Sources                       |
| `response.output_text.done`                 | finalize answer text                                    |
| `response.completed`                        | assemble + persist `final_response`; status=completed   |
| `response.failed` / `error`                 | status=failed; surface error in UI                      |

The `action` (search query, opened URL, in-page pattern) rides on the *item*
(`output_item.added` / `.done`), not on the `web_search_call.*` progress events —
those only carry `item_id`, which we use to advance the right card's status.

**Forward-compatibility:** *every* event is written to `events` verbatim,
including types with no UI role (`content_part.*`) and **types we don't recognize
at all** — OpenAI adds event types over time, and the raw store must never drop
one. The UI ignores unrecognized types gracefully (they still appear in the raw
log). All events carry a `sequence_number` we store as `seq`.

**Models offered in the dropdown** (reasoning + web-search capable), default
**`gpt-5.5`**: `gpt-5.5`, `gpt-5.4`, `gpt-5`, `gpt-5-mini`, `o4-mini`. Exact model
IDs should be verified against the live OpenAI model list at build time; the list
is a single constant, trivial to adjust.

---

## 6. Docker setup

`docker-compose.yml` — two services:

| service | image / build        | ports        | notes                                  |
|---------|----------------------|--------------|----------------------------------------|
| `web`   | build `./` (Next.js) | `3000:3000`  | depends_on `db`; runs migrate then start|
| `db`    | `postgres:16`        | `5432:5432`  | named volume `pgdata`                  |

**Env vars** (`.env`, git-ignored; `.env.example` committed):

```
OPENAI_API_KEY=sk-...           # server only, never exposed to client
DATABASE_URL=postgres://app:app@db:5432/app
OPENAI_DEFAULT_MODEL=gpt-5
```

Schema applied via a migration step on `web` startup (e.g. a small SQL file or
Drizzle/Prisma migrate). `redis:7` is left commented in the compose file as the
documented extension point (§7).

---

## 7. Open questions / risks

- **"Reasoning" is a summary, not the real chain-of-thought.** OpenAI does not
  expose raw CoT for these models — `reasoning.summary` gives a model-generated
  summary. The UI/label must be honest about this so the audience isn't misled.
  This is the single most important caveat for a tool whose whole pitch is
  "see how it reasoned."
- **Fan-out queries depend on the model deciding to search.** A query the model
  answers from parametric knowledge yields zero `web_search_call` items. We
  should show an empty-state ("model chose not to search") rather than a blank panel.
- **Streaming via POST:** `EventSource` can't POST, so the client uses
  `fetch` + `ReadableStream`. No live auto-reconnect, but a finished run can be
  re-opened from the history rail (replayed from `events`). A run interrupted by
  disconnect is finalized `cancelled` with the events received so far — it does
  *not* resume to completion (true resume would need a queue/worker; see Redis).
- **Long runs / timeouts:** deep-reasoning + multi-search runs can take a while;
  ensure the Node route handler and any proxy don't cut the stream short. Disable
  response buffering on the SSE route.
- **SDK lags the live API:** this `openai` version types the web-search tool as
  `web_search_preview` and omits the `web_search_call.action.sources` include
  literal, yet the live API accepts `web_search` and the include (both verified at
  runtime). Two localized type escapes cover the gap; re-verify against the SDK at
  build time. The verbatim `events` store means we never drop events we don't render.
- **Where Redis would earn its place:** if we wanted multiple browser tabs to
  watch the same run, or to decouple the OpenAI stream from client connections,
  publish events to a Redis channel and have the SSE route subscribe. Out of
  scope for the POC.
- **Cost/abuse:** no auth in the POC; reasoning models with web search are not
  cheap. Fine for local/single-user; add a rate limit before any shared deploy.
```
