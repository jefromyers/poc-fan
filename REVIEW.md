# Self-review — Model Thinking Inspector POC

Reviewing my own diff as if it were someone else's PR. Severity-ordered; the six
prompt questions are answered in a table at the end and cross-referenced by [F#].

The POC works end-to-end (verified with real OpenAI calls) — these are the things
I'd push back on before calling it more than a POC.

---

## High

### F1 — The database is write-only; there is no "later inspection" path
Both the task and PLAN.md (§3) center on persisting runs *"for later inspection."*
I built the write side and never built the read side. There is no
`GET /api/runs/:id`, no run list, no replay UI — `runs` and `events` are only
reachable via `psql`. The single most prominent feature in the brief
(`route.ts` stores everything; nothing reads it back) is missing. The raw-log
panel (`app/page.tsx:381`) only shows the *current* in-memory run and is gone on
reload. **This is the biggest gap between the stated goal and what shipped.**

### F2 — Client disconnect / no cancel: healthy runs get marked failed, and there's no stop button
Three compounding problems around the long-lived stream:

- **Send-before-persist + no `cancel()`** (`route.ts:70-71`, no `cancel` in the
  `ReadableStream` at `:43`). I forward each event then persist it. If the browser
  disconnects, the next `controller.enqueue` throws, which lands in `catch`
  (`:85`) and runs `UPDATE runs SET status='failed'` (`:88`) — *overwriting a run
  that was succeeding* — and `final_response` is never written. This directly
  contradicts my own PLAN claim that *"a client disconnect never loses data — the
  run completes and is fully stored regardless."* It doesn't.
- **No `AbortController` to OpenAI** (`route.ts:63`). On disconnect the upstream
  Responses stream keeps running and billing to completion with nobody listening.
- **No way for the user to stop a run.** The Run button is disabled while busy
  (`app/page.tsx:281`) and there's no Stop control or client-side
  `AbortController`, so a slow/stuck stream leaves the UI inert until a reload.

---

## Medium

### F3 — One failed INSERT aborts the whole run in the UI
`route.ts:71` awaits each event insert *inside the main try*. A single transient
DB error (or an oversized `payload`) throws → `catch` marks the run failed and
emits `stream.error` (`:90`), so the browser flips to "failed" even though the
OpenAI stream was fine and dozens of events already rendered. During streaming,
persistence should be best-effort (log and continue) — the browser already has
the data, and one hiccup shouldn't kill a working run.

### F4 — `initDb()` caches a rejected promise forever
`lib/db.ts:39-40`: `return (ready ??= pool.query(SCHEMA)...)`. If the first call
rejects (DB not ready yet), `ready` holds a *rejected* promise; `??=` won't
reassign it because it isn't null/undefined, so every later request fails until
the process restarts. Compose gates `web` on a DB healthcheck so it's unlikely to
fire, but it's a latent footgun: a rejected init should reset `ready = null`.

### F5 — The `any` cast is right for one line, a cop-out for the rest
`route.ts:55,63,65` cast the params, the result, and every `event` to `any`. The
*justification* is real but narrow: only the `include` literal
`"web_search_call.action.sources"` is missing from the SDK's `ResponseIncludable`
union. The right-sized fix is to type `params` as the SDK's streaming params and
`@ts-expect-error`/cast just the `include` field. As written, I threw away type
safety on the part that needs it most — the event handler. `event: any` means a
field rename in `event.item.action.sources` (`page.tsx:129`) or
`event.annotation.url` (`page.tsx:157`) fails silently for a tool whose entire job
is parsing a specific event shape. Related: the **`open_page` / `find_in_page`
(`page.tsx:23-26`) and `reasoning_text.delta/.done` (`page.tsx:141,145`) handlers
are wired but never exercised at runtime** — both my test runs only produced
`search` actions and `reasoning_summary_text` deltas. They're plausible, not
verified.

### F6 — No run timeout anywhere
If the OpenAI stream hangs, the `for await` (`route.ts:65`) waits indefinitely,
the run row stays `status='running'`, and the client reader loop (`page.tsx:209`)
blocks with the UI disabled. No server deadline, no client timeout, no reaper for
orphaned `running` rows.

---

## Low

### F7 — Raw-log render is O(n²) and always computed
`page.tsx:386` rebuilds one big string from the entire `raw` array on *every*
event, even though it's inside a collapsed `<details>` (collapsed only hides it;
React still renders it). At the ~150 events/run I tested this is invisible; it
janks at thousands. Pair with the silent cap at `page.tsx:103` (`length > 2000`
stops appending to the UI with no indication and a frozen count) — premature
optimization that introduces a silent-truncation bug instead of preventing one.

### F8 — `reasoningDone` / `answerDone` are refs gating rendered output
`page.tsx:55-56,360,374`. Mutating a ref doesn't trigger a re-render, so the
streaming cursor only disappears because *some other* state change re-renders
right after. It works incidentally (there's always a later `setStatus`/answer
delta), but render-affecting values shouldn't live in refs.

### F9 — Raw upstream error text is reflected to the client
`route.ts:86,90` send the raw OpenAI error message to the browser and store it. In
my dummy-key test this echoed a fragment of the (fake) key. Fine for a local,
no-auth POC, but anything shared shouldn't mirror upstream error strings verbatim.

### F10 — Smaller smells
- Effort default `"medium"` is duplicated in client (`page.tsx:42`) and server
  (`route.ts:25`) — can drift.
- `seq` fallback counter (`route.ts:51,66`) is effectively dead — OpenAI always
  sends `sequence_number`; if it ever didn't, `seq++` from 0 could collide with a
  real `0`.
- `Dockerfile` uses `npm install` with no committed `package-lock.json` →
  non-reproducible builds; combined with `openai: "^4"`, a later build could pull
  a different SDK that the broad `any` cast would hide.
- No healthcheck on the `web` service; Postgres `5432` is published to the host
  unnecessarily (`docker-compose.yml`).
- `Connection: keep-alive` (`route.ts:101`) is a hop-by-hop header that fetch/Next
  ignore; harmless noise.
- Plain Enter doesn't submit (only ⌘/Ctrl+Enter, `page.tsx:272`) with no hint;
  streaming panels don't auto-scroll, so "watch it think" pushes the page down
  rather than following the text.

---

## Answers to the six questions

| # | Question | Verdict |
|---|----------|---------|
| 1 | Weakest part / first to break | **[F2]** the disconnect/cancel path — it both loses data and contradicts the PLAN. After that, **[F3]** (one DB hiccup kills a run). |
| 2 | Plan vs. reality | **[F1]** "later inspection" was never built (write-only DB). **[F2]** "disconnect never loses data" is false. `open_page`/`find_in_page`/`reasoning_text` are wired but **unverified** **[F5]**. |
| 3 | The `any` cast | Right call for the one `include` line; **over-broad cop-out** everywhere else, especially `event: any` in the parser **[F5]**. |
| 4 | Does it feel like "watch it think"? Bugs? | Yes at tested volumes (live reasoning + answer cursors stream). Bugs: ref-gated cursor **[F8]**, O(n²) always-on raw log **[F7]**, no auto-scroll **[F10]**. |
| 5 | DB-write failure modes | Disconnect → run marked failed, no `final_response` **[F2]**; one insert error aborts the run **[F3]**; hung stream → stuck `running` + dead UI **[F6]**; poisoned `initDb` **[F4]**. |
| 6 | Over- vs under-built | **Over:** 2000-event cap **[F7]**, dead `seq` fallback, duplicated defaults **[F10]**. **Under:** the entire read/inspection path **[F1]**, stop button + abort **[F2]**, persist resilience **[F3]**, run timeout **[F6]**. |

## If I fixed three things
1. **[F1]** Add `GET /api/runs` (list) + `GET /api/runs/:id` (replay from `events`)
   and a minimal history view — it's the headline feature and it's absent.
2. **[F2]** Wire a `cancel()` + `AbortController`, make persistence
   best-effort, and only mark `failed` on a genuine OpenAI error — plus a Stop button.
3. **[F5]** Type the request as the SDK params with a narrow cast on `include`,
   and give the stream events a real `OpenAIEvent` union so the parser is checked.
