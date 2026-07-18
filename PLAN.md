# Plan: Multi-turn conversation experiments

## Status and baseline

Planning only. No multi-turn conversation code, schema changes, API changes, or
MCP changes have been implemented yet.

The pre-feature baseline is commit `2c3b8c1`, tagged:

- `v0.1.0`
- `pre-conversation-experiments`

There is an unrelated, uncommitted `package.json` change that pins the local
pnpm version. It is not part of this feature.

## Goal

Allow Thinking Inspector (TI) to run an ordered sequence of prompts in one
model conversation:

1. Run turn 1 and capture its answer, searches, opened pages, and citations.
2. Send turn 2 as a follow-up with turn 1 in context.
3. Capture only turn 2's newly emitted searches, opened pages, citations,
   answer, reasoning summary, usage, and raw events.
4. Optionally run a cold, standalone version of turn 2 without prior context.
5. Compare the continued and cold results to study citation carryover,
   re-foraging, and possible source incumbency.

The first useful release should be available through MCP. A polished browser
interface can follow after the MCP experiment is validated.

## Why this matters

Real buyers often narrow a decision over several turns:

```text
broad discovery -> refine constraints -> compare finalists -> decide
```

Single-shot TI runs cannot show whether a source found or cited early in that
journey remains influential later. A conversation experiment should help
answer:

- Does a follow-up search again, or use prior context without visible
  re-foraging?
- Do citations from turn 1 survive into turn 2?
- Are prior sources more likely to appear in a continued turn than in a cold
  baseline?
- How do search effort, sources, citations, tokens, and answers differ between
  continued and cold conditions?

## Core design decisions

### 1. Keep one TI run per model response

Every conversation turn remains an ordinary `runs` row with its own `events`
rows. Do not put several turns into one run or concatenate their raw event
streams.

This preserves clean attribution:

- Turn 1 events describe only turn 1.
- Turn 2 events describe only turn 2.
- Existing run replay and derivation logic remains useful.
- Existing run-level exports and comparisons continue to work.

### 2. Use native Responses API continuation first

The native continuation arm will pass the completed parent response's OpenAI
response ID as `previous_response_id`.

Set `store: true` explicitly and record:

- The provider response ID produced by each turn.
- The previous provider response ID supplied to each continued turn.
- The continuation strategy used.
- The effective model, effort, tools, and relevant request settings.

The web-search tool configuration must still be supplied on every turn.

### 3. Make context strategy an explicit experimental variable

Planned strategies:

- `provider_state`: use `previous_response_id`. This is the MVP continuation
  strategy and most closely represents staying in the same provider thread.
- `cold`: send only the current prompt with no parent context.
- `transcript_only`: later phase; replay prior user prompts and visible
  assistant answers, excluding provider-managed tool context.

Do not combine native continuation and manually replayed history in one arm.
That would make the experiment difficult to interpret.

### 4. Keep conversation experiments separate from independent compares

Do not change the meaning of the existing `run_compare` MCP tool. It should
continue to mean independent prompts and repetitions.

Add a separate conversation-experiment workflow with ordered dependency
semantics and directional results.

### 5. Require honest baseline labeling

A natural follow-up may depend on prior context:

```text
Which of those is best under $500?
```

Running that exact text cold is often not a fair baseline. Each follow-up may
therefore provide a standalone cold-baseline prompt:

```text
Which payroll systems for a 25-person construction company are best under
$500 per month?
```

Supported baseline modes:

- `standalone`: user supplies a self-contained cold prompt; recommended.
- `literal`: run the exact follow-up text cold; allowed but clearly labeled.
- `none`: do not create a cold baseline.

TI should not automatically rewrite baseline prompts in the MVP because the
rewrite would introduce another model-dependent variable.

## MVP scope

The MCP-first MVP should support:

- Two to five ordered turns.
- One to six replicated conversations.
- One fixed model and reasoning effort per experiment.
- Native provider continuation.
- Optional cold baseline for every follow-up.
- Separate run and event history for every generated response.
- Background execution independent of an open browser stream.
- Per-turn answer, reasoning summary, usage, actions, sources, citations, and
  raw events.
- Directional transition analysis.
- Structured JSON results.
- Partial results when one branch fails.

## Out of scope for the first implementation

- Polished browser conversation builder and timeline.
- Long-lived user chat threads across weeks or months.
- Automatic prompt rewriting.
- Claude or other provider support.
- Claims that TI can prove the provider's hidden internal reuse mechanism.
- Automatic context compaction for very long threads.
- Editing or replacing completed historical turns.

## Proposed MCP surface

### `run_conversation_experiment`

Submit an ordered experiment.

Inputs:

- `label`
- `model`
- `effort`
- `replicates`
- `context_mode`, initially `provider_state`
- `baseline_mode`
- `turns`
  - `prompt`
  - optional `cold_baseline_prompt` for follow-up turns

Returns:

- `experiment_id`
- initial status
- turn count
- replicate count
- expected run count
- model and effort
- submission timestamp

### `get_conversation_experiment_status`

Returns:

- aggregate experiment status
- completed, running, queued, skipped, and failed attempt counts
- per-replicate progress
- partial-failure information
- cancellation state

### `get_conversation_experiment_results`

Returns selectable result sections:

- `summary`
- `turns`
- `outputs`
- `query_fanout`
- `sources`
- `transitions`
- `warm_vs_cold`
- `usage`
- optional raw URL rows or raw events

Results should be nested by:

```text
experiment -> replicate -> turn -> condition -> attempt
```

Each result must include experiment, replicate, turn, run, parent-run, and
provider-response identifiers.

## Proposed persistence model

Retain the existing `runs` and `events` tables as the evidence layer.

Add a real migration mechanism before evolving the schema. The current
`CREATE TABLE IF NOT EXISTS` bootstrap does not alter existing deployments.

### `conversation_experiments`

Suggested fields:

- `id`
- `created_at`, `updated_at`
- `label`
- `status`
- `model`
- `effort`
- `context_mode`
- `baseline_mode`
- `replicate_count`
- `turn_count`
- `expected_run_count`
- `analysis_version`
- `cancel_requested_at`
- `error`

### `conversation_turn_specs`

Suggested fields:

- `experiment_id`
- `turn_index`
- `prompt`
- `cold_baseline_prompt`

The pair `(experiment_id, turn_index)` must be unique.

### `conversation_attempts`

Suggested fields:

- `id`
- `experiment_id`
- `replicate_index`
- `turn_index`
- `condition`: `continued`, `cold`, or later `transcript_only`
- `attempt_number`
- `run_id`
- `parent_attempt_id`
- `parent_run_id`
- `provider_response_id`
- `previous_provider_response_id`
- `status`
- `started_at`, `completed_at`
- exact request/configuration snapshot
- terminal error information

Attempts are immutable. Retrying creates another attempt or an explicit branch.

### `runs`

Consider adding first-class fields for:

- `provider_response_id`
- optional request metadata/version

The provider ID already exists inside the stored final response, but a
first-class field is easier to validate, query, index, and audit.

## Execution model

### Dependency rules

- At most one continued turn may be in flight per replicated conversation.
- Continued turn N can start only after continued turn N-1 completes and its
  provider response ID is safely persisted.
- Different replicated conversations may execute concurrently.
- Cold baselines are independent and may execute concurrently within the
  global limit.

### Suggested scheduler flow

```text
for each replicate, concurrently up to the configured limit:
    run continued turn 1 with no parent
    persist its terminal response and provider response ID

    for each remaining turn:
        run continued turn with the prior provider response ID
        run its cold baseline independently when configured
        persist both as separate TI runs
```

Warm and cold counterparts should be scheduled close together to reduce
live-web timing drift.

### Statuses

Conversation attempts need:

- `queued`
- `running`
- `completed`
- `incomplete`
- `failed`
- `cancelled`
- `skipped`

If a continued parent fails, is cancelled, or is incomplete:

- Downstream continued turns become `skipped`.
- Cold baselines may still run.
- The experiment returns partial results.
- TI must never silently restart the warm chain as cold.

### Browser and process lifecycle

Conversation experiments must not be coupled to one browser SSE connection.
Closing the page should detach from the experiment rather than implicitly
cancel it.

An in-process scheduler is acceptable for the first proof of concept if its
restart limitation is explicit. Before treating the feature as production
reliable, add durable claiming, leases/heartbeats, timeout handling, restart
recovery, and cooperative cancellation.

## Per-turn evidence

Preserve these source categories separately:

- Search queries issued.
- Consulted URLs: URLs surfaced in reported search results.
- Opened URLs: URLs explicitly opened or searched within.
- Cited URLs: URLs referenced by answer annotations.
- Citation occurrences.
- Page-level and domain-level forms.

Do not label all surfaced URLs as pages the model read. A surfaced result,
explicit open, and citation are different forms of evidence.

## Directional analysis

For each transition, compare the current turn with all relevant prior-turn
evidence.

### Source classifications

- `retained_and_refound`: present previously, surfaced or opened again, and
  cited in the current turn.
- `candidate_carried`: present previously and cited now without a visible
  current-turn re-search or open.
- `novel`: first appears in the current turn.
- `prior_not_retained`: present previously but absent from current citations.

`candidate_carried` is behavioral evidence, not proof of the provider's hidden
internal tool-memory mechanism.

### Headline warm-versus-cold metric

Use the same prior denominator for both conditions:

```text
warm prior-citation survival =
    prior citations appearing in warm follow-up / prior citations

cold prior-citation survival =
    prior citations appearing in cold follow-up / prior citations

observed incumbency lift =
    warm survival - cold survival
```

Always return the underlying counts and denominator. Return `N/A`, not zero,
when a denominator is empty.

### Additional useful measures

- Follow-up citation carryover share.
- Prior-footprint share of follow-up citations.
- Fresh citation share.
- Fresh-forage share.
- Repeated versus new search queries.
- Repeated versus new pages and domains.
- Warm/cold citation Jaccard overlap.
- Search/action count delta.
- Input, output, reasoning, cached, and total token delta.
- Latency delta.

Aggregate replicated results as paired per-replicate observations. Do not
report only one pooled URL set.

## Reliability and integrity rules

- Persist the parent provider response ID before scheduling a child.
- Never continue from a failed, cancelled, incomplete, or unrecorded parent
  unless an explicit policy later allows it.
- A retry creates a new immutable attempt.
- Do not delete a parent independently while descendants exist.
- Define transactional whole-experiment deletion or use soft deletion.
- Prevent two workers from claiming the same turn.
- Add timeouts for streams that never emit a terminal event.
- Store exact model, effort, tool configuration, strategy, and timestamps.
- Preserve raw partial evidence when persistence or a later turn fails.
- Limit turns and total planned API calls.
- Record that prior context tokens are billed again on continued requests.
- Never silently switch continuation strategies after an expired provider
  response.

## Implementation phases

### Phase 0: live API behavior spike

Estimate: 0.5 to 1 day.

Run a controlled two-turn experiment using:

- Native `previous_response_id`.
- Transcript-only context.
- Cold follow-up.
- Optionally full prior output-item replay.

Verify:

- Turn 2's stream contains only newly emitted turn 2 events.
- The prior provider response ID is accepted and recorded.
- Prior citations can appear with and without visible new search actions.
- Tool-context behavior matches the documented continuation semantics closely
  enough for the experiment.
- Failure, expiration, and storage behavior are understood.
- Token and cost accounting are captured.

Do not commit the production architecture until this spike confirms event
attribution.

### Phase 1: migrations and one-turn executor generalization

Estimate: 1 to 2 days.

- Add proper idempotent migrations.
- Add conversation experiment and lineage tables.
- Generalize the executor to accept a continuation strategy.
- Return and persist the provider response ID.
- Keep the executor responsible for exactly one response/turn.
- Add provider/request dependency injection for tests.

### Phase 2: ordered scheduler and MCP MVP

Estimate: 2 to 4 days.

- Add strict per-conversation dependency scheduling.
- Allow concurrency across independent replicates and cold controls.
- Add queued, skipped, partial, and cancellation semantics.
- Implement the three MCP tools.
- Return structured per-turn evidence.
- Keep existing `run_compare` behavior unchanged.

### Phase 3: directional metrics and exports

Estimate: 2 to 3 days.

- Add a pure conversation-transition analyzer.
- Add page- and domain-level classifications.
- Add warm-versus-cold metrics.
- Add fixture-driven tests.
- Add versioned JSON, Markdown, and CSV exports as needed.

### Phase 4: browser experience

Estimate: 4 to 7 days.

- Add `Single run | Conversation experiment` mode.
- Add an ordered turn builder.
- Add standalone cold-baseline fields.
- Group experiment history separately from flat run history.
- Add a turn timeline and selected-turn detail.
- Show continued and cold results side by side.
- Add source-lineage and transition views.

### Phase 5: production hardening

Estimate: 3 to 6 days.

- Durable PostgreSQL-backed work claiming and leases.
- Heartbeats, timeouts, restart recovery, and idempotency.
- Cooperative experiment cancellation.
- Immutable retry/fork UI and API behavior.
- Transactional deletion or soft-delete policy.
- Context/cost limits and operational observability.

## Testing plan

### Unit tests

- Request construction for every context strategy.
- Dependency scheduling and concurrency limits.
- Status transitions.
- Parent/child lineage.
- Retry attempt numbering.
- Source classification.
- Zero-denominator metrics.
- Page- and domain-level normalization.

### Database and API integration tests

- Successful two- and three-turn chains.
- Parent failure and downstream skips.
- Cold completion after warm failure.
- Missing terminal event.
- Event-persistence failure.
- Finalization failure.
- Cancellation and timeout.
- Duplicate worker claim.
- Process restart and lease reclaim once durable execution exists.
- Delete and retry policies.

### MCP and export tests

- Submit an experiment.
- Poll status.
- Retrieve partial and completed results.
- Confirm continued turns have the expected parent.
- Confirm cold turns have no parent.
- Confirm event logs are isolated by turn.
- Verify stable, versioned JSON shapes.
- Verify Markdown and CSV calculations against fixtures.

### Live validation

- Repeated warm/cold pairs using the same model, effort, tools, and instructions.
- Schedule pairs close together.
- Inspect raw streams.
- Check citation annotations and web-search actions.
- Verify token growth over turns.
- Test the configured maximum turn and replicate limits.

## MVP acceptance criteria

- An ordered two-turn experiment can be submitted through MCP.
- The continued follow-up uses exactly its recorded parent provider response.
- The cold follow-up has no parent context.
- Every generated response has its own TI run and event log.
- Turn 2's event log contains only turn 2 events.
- Model, effort, tools, prompts, strategy, and provider IDs are auditable.
- Per-turn searches, consulted URLs, opens, citations, output, usage, and raw
  events are retrievable.
- Parent failure produces skipped downstream warm turns.
- Cold branches and completed partial evidence remain available.
- Carryover and warm/cold metrics are fixture-tested.
- Existing single runs and independent compares remain backward compatible.
- The MCP result language does not claim causal proof of hidden tool-memory
  reuse.

## Effort estimate

- Technical proof of concept: approximately 3 to 4 engineering days including
  the behavior spike.
- Useful MCP/backend research feature: approximately 1 to 1.5 engineering
  weeks.
- Polished and production-reliable browser feature: approximately 2 to 3
  engineering weeks total.

## Recommended immediate next step

Review and lock this plan, then run Phase 0 as an isolated behavior spike.
Do not begin schema or UI implementation until the spike verifies that native
continuation preserves the desired context while TI continues to receive a
clean, current-turn event stream.
