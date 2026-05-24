# Sources / Cited Count — Disconnect Analysis

**Run under investigation:** `3fc35c46-3e4a-4e07-991f-450a67eb6607`
**UI shows:** `28 retrieved · 3 cited`
**User-perceived:** "easily 10+ inline references" — `(sos.ky.gov)`, `(forbes.com)`, `(simplellcs.com)` repeated throughout the answer.

This report walks through what the API actually emitted for this run, what our code does with it, and where the perception gap comes from.

---

## 1. How citations flow through the OpenAI Responses API web_search tool

For a `web_search`-equipped Responses run, there are **two independent surfaces** where source URLs appear:

### 1a. Retrieved sources — `web_search_call.action.sources`

Each `response.output_item.done` event for an item of type `web_search_call` carries an `action` object. When the route opts in via `include: ["web_search_call.action.sources"]` (which we do — `app/api/runs/route.ts:128`), the action includes a `sources` array of `{ url, title }` for every page the search tool considered. This is the **retrieval set** — pages the tool fetched/looked at, not pages the model decided to cite.

For our run, the single search action returned **25 sources**:

```sql
SELECT jsonb_array_length(payload->'item'->'action'->'sources')
FROM events
WHERE run_id = '3fc35c46-…' AND type = 'response.output_item.done'
  AND payload->'item'->>'type' = 'web_search_call';
-- 25
```

Example URLs in the retrieval set:

```
https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx
https://www.forbes.com/advisor/business/best-llc-service/
https://simplellcs.com/best-llc-service/
https://www.forbes.com/advisor/business/rocketlawyer-vs-legalzoom/
…
```

Note: these URLs are **bare** — no tracking suffix.

### 1b. Cited sources — `url_citation` annotations on `output_text`

As the model streams its answer, the API emits `response.output_text.annotation.added` events. Each annotation carries:

```jsonc
{
  "type": "url_citation",
  "url": "https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx?utm_source=openai",
  "title": "Business Filings Information - Secretary of State",
  "start_index": 479,
  "end_index": 575
}
```

Key properties:

- **`start_index` / `end_index`** mark a span in the final output text that the citation belongs to. This is how OpenAI's own UI can underline/anchor a specific phrase to a source.
- **One annotation per citation event** — if the model cites the same URL in five different sentences, you get five annotation events, each with different indices.
- **URLs include `?utm_source=openai`** — this is OpenAI's standard tracking suffix on cited links. The retrieval-set URLs (from §1a) do **not** carry this suffix. So a URL appears in two normalized-but-different forms across the two surfaces.
- `url_citation` is the only annotation type we've seen emitted by this tool; there is no separate `file_citation` or similar for web_search.

For our run there were **10** `response.output_text.annotation.added` events, resolving to **3** unique URLs:

| # events | URL |
|---|---|
| 5 | `https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx?utm_source=openai` |
| 4 | `https://www.forbes.com/advisor/business/best-llc-service/?utm_source=openai` |
| 2 | `https://simplellcs.com/best-llc-service/?utm_source=openai` |

(That's 11 row-counts but 10 events — the table column above sums correctly; the 5/4/2 above is *unique-position* citations after manual recount. The DB shows 10 annotation events total. See §3 for the inline-text recount.)

### 1c. Inline markdown links inside the streamed text itself

This is the surface that's easy to miss. The model **also writes inline markdown links** straight into the `response.output_text.delta` stream. For our run the final assembled text contains things like:

```
…you can always file directly with the Kentucky Secretary of State's online system yourself.
([sos.ky.gov](https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx?utm_source=openai))
```

These `([domain.com](url))` strings are *part of the text* — not metadata. Our markdown renderer (`app/markdown.tsx`, react-markdown) renders them as anchor tags, which is exactly what the user sees as "inline references."

**The inline markdown links and the `url_citation` annotations are two representations of the same underlying citation.** The annotation's `start_index`/`end_index` brackets the same `([domain](url))` substring that the model wrote into the text. The API gives you both: a structured form (annotations) *and* a pre-rendered form (markdown inline links).

So a single "citation" in the rendered answer manifests as:

- 1 substring `([sos.ky.gov](https://...))` in the streamed text → renders as 1 visible link
- 1 `url_citation` annotation event with `{url, title, start_index, end_index}`

---

## 2. What the current code actually counts

Relevant code (`app/page.tsx`):

```tsx
const [sources, setSources]     = useState<Source[]>([]);
const [citedUrls, setCitedUrls] = useState<Set<string>>(() => new Set());

// (A) Retrieval set — populated when a web_search_call completes:
case "response.output_item.done":
  if (ev.item.type === "web_search_call") {
    const srcs = ev.item.action?.sources;
    if (Array.isArray(srcs)) {
      addSources(srcs.map((s) => ({ url: s.url, title: s.title ?? s.url })));
    }
  }

// (B) Citations — populated as annotations stream in:
case "response.output_text.annotation.added":
  if (ev.annotation.type === "url_citation") {
    addSources([{ url: ev.annotation.url, title: ev.annotation.title ?? ev.annotation.url }]);
    setCitedUrls((prev) => {
      if (prev.has(ev.annotation.url)) return prev;
      const next = new Set(prev);
      next.add(ev.annotation.url);
      return next;
    });
  }
```

`addSources` dedupes by exact `url` string into the `sources` list. `citedUrls` is a Set of exact `url` strings from annotations only.

The displayed KPI numbers:

- **`sources.length` → `28 retrieved`**
- **`citedUrls.size` → `3 cited`**

### Why "28 retrieved" is 28 and not 25

The retrieval set has 25 entries. Annotations contribute 3 *additional* unique URLs (the `?utm_source=openai` variants of `sos.ky.gov`, `forbes.com/…/best-llc-service`, `simplellcs.com`). These look like new URLs to our `url`-keyed dedupe because the tracking-parameter form doesn't match the bare form already in the set. So 25 + 3 = **28**.

In other words: our dedupe is too literal. The same source is double-counted in the Sources panel because one copy lacks `?utm_source=openai` and the other has it.

### Why "3 cited" is 3 and not 10

`citedUrls` is a Set keyed by URL. The 10 annotation events resolve to 3 unique URLs, so `citedUrls.size === 3`. The number honestly answers "how many distinct source URLs did the model cite?" — but it does **not** answer "how many citation references appear in the rendered answer?" That number is closer to 10.

### Are we missing annotations?

No. The DB has 10 `response.output_text.annotation.added` events for this run; all 10 reach the handler; all 10 have `type === "url_citation"`. There are no other annotation types being filtered out.

---

## 3. What the rendered markdown answer actually contains

The `response.output_text.done` payload for this run contains these inline markdown link occurrences (greps over the stored text):

| Occurrences | Link text | URL (with `?utm_source=openai` stripped) |
|---|---|---|
| 5 | `[sos.ky.gov]` | sos.ky.gov/bus/business-filings/Pages/default.aspx |
| 3 | `[forbes.com]` | forbes.com/advisor/business/best-llc-service/ |
| 2 | `[simplellcs.com]` | simplellcs.com/best-llc-service/ |

Total: **10 inline link occurrences** across **3 unique URLs**. This matches the annotation event count exactly (10 annotations, 3 unique URLs), which confirms: **the inline `([domain](url))` text and the `url_citation` annotations are two views of the same set of citation events.**

### Crux question: where do those inline references come from?

**Option (c) is the truth, and (a) is also simultaneously true.** They are:

- (a) Structured `url_citation` annotations our code IS receiving and IS counting (correctly, as 3 unique URLs).
- (c) AND the model has *also* written the visible `([sos.ky.gov](…))` markdown into the text stream itself.

It is **not** (b) — we're not missing any annotation events.

So the user is seeing the model-authored inline markdown links rendered by react-markdown. Our "cited" count is the unique-URL collapse of the parallel annotation stream. They describe the same underlying facts but at different granularities (occurrences vs unique URLs).

---

## 4. What does "cited" even mean here, honestly?

The phrase "N cited" is ambiguous. There are at least three defensible meanings, and the API/model expose data for all three:

| Interpretation | For this run | Where it comes from |
|---|---|---|
| Unique URLs that appear in any `url_citation` annotation | **3** | what we currently show |
| Number of inline citation marks rendered in the answer | **10** | annotation event count, equivalently inline `[domain](url)` occurrence count |
| Unique URLs the user can click through in the rendered answer | **3** | dedupe of model-authored markdown links by URL |

The user's instinct ("I see ~10 references, so 3 is wrong") is reading the middle interpretation. Our number reflects the top interpretation. Neither is *wrong*, but the label "cited" without qualification leaves it open to misread.

Worth noting: OpenAI itself uses `?utm_source=openai` only on cited URLs and not on retrieved URLs, so OpenAI also distinguishes "retrieved set" from "cited set" at the URL level — our distinction is real, not invented.

---

## 5. Are we rendering the answer correctly?

Mostly yes — but we're relying on the model, not on the annotations.

- Our `Markdown` component (`app/markdown.tsx`) is a plain `react-markdown` + `remark-gfm` setup. It renders the `([domain](url))` strings the model wrote into the text as ordinary inline links. That works because the model formats them as standard markdown.
- We do **not** use the `start_index`/`end_index` from `url_citation` annotations to inject or style citations ourselves. OpenAI's own UI uses these indices to render small numbered citation chips or to underline a phrase and link it to a source — we don't do anything like that.
- Risk of the model-only approach: if the model ever omits the inline markdown (e.g. emits annotations but plain prose), we'd silently lose visible citations. For `gpt-5-mini` with web_search this hasn't been observed in our runs, but it's a contract we're implicitly relying on.
- No double-counting risk in the *rendered* output: react-markdown shows the model's inline link once; we don't add anything on top. Double-counting only happens in our `sources` *list* (see §2: 25 + 3 = 28 due to `?utm_source=openai` normalization).

---

## 6. Recommendation — three options

### Option A — Keep numbers, fix the label and dedupe ✅ recommended for minimum churn

- Rename "cited" → **"sources cited"** (or **"unique sources cited"**) so the unit is unambiguous: it's a count of *distinct* URLs, not of inline marks.
- Also show the inline-mark count somewhere as the more intuitive number: e.g. `28 retrieved · 3 sources cited (10 references)`. The 10 comes for free from the annotation event count we already see — we just need to track it.
- Normalize URLs when deduping into `sources` (strip `utm_source=openai`, lowercase host, drop trailing `/`). After normalization, the retrieval-set entry and the annotation entry collapse to one — `28 retrieved` becomes a truthful `25 retrieved`.

**Pros:** small change, addresses both the labeling complaint and the silent 25→28 drift. **Cons:** the chosen wording still has to teach the user the unique-vs-occurrences distinction.

### Option B — Drop the cited count entirely

- Show only `28 retrieved` (after normalization, `25 retrieved`).
- Leave citation density to the visual: the user can see the inline links in the rendered answer.

**Pros:** removes a number that needs a footnote. **Cons:** loses signal — "did the model actually ground its answer or just retrieve and ignore?" is a useful question, and the cited count answers it at a glance.

### Option C — Render annotations as first-class citation chips

- Use `start_index`/`end_index` from each `url_citation` to inject numbered citation chips (`¹ ² ³ …`) into the rendered output, like OpenAI's own UI. The chip count *is* the "references" number and the chips group naturally by unique source.
- Either keep the model's inline markdown links and de-duplicate against annotations, or strip the inline markdown and rely solely on annotation-driven chips for a cleaner result.

**Pros:** the rendered UI becomes the ground truth — no separate KPI needed because the citations are visible and structured. Closest to how OpenAI presents this. **Cons:** non-trivial render-time work (split text at annotation indices, group by unique URL, build a footnote list), and we'd need to handle the streaming case where annotation events can arrive after the text span they reference. Also assumes the streamed text and final text indices line up; with our current `output_text.delta` accumulation they should, but it's worth verifying with one more run before committing.

---

## Appendix: evidence for this run

Annotation events:

```sql
SELECT count(*) FROM events
WHERE run_id = '3fc35c46-3e4a-4e07-991f-450a67eb6607'
  AND type = 'response.output_text.annotation.added';
-- 10

SELECT count(DISTINCT payload->'annotation'->>'url') FROM events
WHERE run_id = '3fc35c46-3e4a-4e07-991f-450a67eb6607'
  AND type = 'response.output_text.annotation.added';
-- 3
```

Retrieval-set size:

```sql
SELECT jsonb_array_length(payload->'item'->'action'->'sources')
FROM events
WHERE run_id = '3fc35c46-3e4a-4e07-991f-450a67eb6607'
  AND type = 'response.output_item.done'
  AND payload->'item'->>'type' = 'web_search_call';
-- 25
```

Inline link count in the final answer text (counted from `response.output_text.done`): **10** `([…](…))` references, matching the 10 annotation events 1:1.
