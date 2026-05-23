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

**Flow:** The browser `POST`s `{model, query}` to `/api/runs` and reads the
response body as a stream (fetch + `ReadableStream`, not `EventSource`, so we can
POST a body). The server opens the OpenAI Responses stream and, for each event,
does two things in lockstep: appends a row to `events` and writes the event into
the response stream to the browser (re-framed as SSE: `data: {...}\n\n`). When
`response.completed` arrives, the server assembles the final response object and
`UPDATE`s the `runs` row. The client renders incrementally as events arrive.

Persistence happens **server-side during the stream**, so a client disconnect
never loses data — the run completes and is fully stored regardless.

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
| `model`          | text        | e.g. `gpt-5`                                      |
| `query`          | text        | user's prompt                                     |
| `status`         | text        | `running` \| `completed` \| `failed`             |
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
│  [ Model ▾  gpt-5 ]   [ query…                              ] [Run]  │
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

- **Search fan-outs:** one card per `web_search_call`, showing its sub-query and
  a status chip that advances `in_progress → searching ✓`. This is the visible
  "fan-out": the model often issues several searches; each is its own card.
- **Sources:** deduped list of cited URLs from text annotations (title + domain
  + outbound link). Grows as citations are emitted.
- **Reasoning:** the reasoning **summary** streams token-by-token with a live
  cursor; once `...summary_text.done` fires, the cursor stops and the completed
  summary stays. (See risk note: OpenAI exposes a *summary*, not raw chain-of-thought.)
- **Answer:** final assembled answer text, also streamed.
- **Raw log:** collapsible, for the "inspect everything" audience.

---

## 5. OpenAI Responses API events → UI mapping

Request: `responses.stream({ model, input, tools: [{type:"web_search"}],
reasoning: { summary: "detailed" }, include: ["web_search_call.action.sources"] })`.
`reasoning.summary` is required to get reasoning text; `include` surfaces the
search result sources.

| Event type                                  | What we do                                              |
|---------------------------------------------|---------------------------------------------------------|
| `response.created` / `.in_progress`         | mark run started; show spinner                          |
| `response.output_item.added`                | a new item (reasoning / web_search_call / message) began|
| `response.web_search_call.in_progress`      | create a fan-out card                                   |
| `response.web_search_call.searching`        | card → "searching"; show the sub-query                  |
| `response.web_search_call.completed`        | card → done ✓                                            |
| `response.reasoning_summary_part.added`     | open a reasoning block                                  |
| `response.reasoning_summary_text.delta`     | append to live reasoning panel (token stream)           |
| `response.reasoning_summary_text.done`      | freeze final reasoning text                             |
| `response.output_text.delta`                | append to live Answer panel                             |
| `response.output_text.annotation.added`     | add/dedupe a cited URL in Sources                       |
| `response.output_text.done`                 | finalize answer text                                    |
| `response.completed`                        | assemble + persist `final_response`; status=completed   |
| `response.failed` / `error`                 | status=failed; surface error in UI                      |

*Every* event (including ones with no UI role, e.g. `content_part.*`) is still
written to `events` verbatim. All events carry a `sequence_number` we store as `seq`.

**Models offered in the dropdown** (reasoning-summary *and* web-search capable):
`gpt-5`, `gpt-5-mini`, `o4-mini`, `o3`. (Non-reasoning models like `gpt-4.1`
support web search but produce no reasoning panel, so we exclude them — or could
list them greyed with a note. Confirm exact availability against the account at
build time.)

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
  `fetch` + `ReadableStream`. Workable, but auto-reconnect is manual. For a POC,
  no reconnect — a dropped stream still persists server-side and can be replayed
  from `events`.
- **Long runs / timeouts:** deep-reasoning + multi-search runs can take a while;
  ensure the Node route handler and any proxy don't cut the stream short. Disable
  response buffering on the SSE route.
- **`include` flags & API drift:** exact `include` keys and event names should be
  re-verified against the current SDK at build time; event *types* are stable but
  new ones may appear — the verbatim `events` store means we never lose data even
  for events we don't yet render.
- **Where Redis would earn its place:** if we wanted multiple browser tabs to
  watch the same run, or to decouple the OpenAI stream from client connections,
  publish events to a Redis channel and have the SSE route subscribe. Out of
  scope for the POC.
- **Cost/abuse:** no auth in the POC; reasoning models with web search are not
  cheap. Fine for local/single-user; add a rate limit before any shared deploy.
```
