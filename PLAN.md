# Plan: Render streamed markdown in Reasoning + Answer cards

## 1. Streaming + partial markdown

- Token-by-token deltas mean the buffer is frequently mid-token: an unclosed `**`, a half-written ``` fence, a list item with no newline yet, a link `[text](http` with no closing paren.
- Re-parsing the whole buffer on every delta is fine — markdown parsers are fast on the answer sizes we produce (kilobytes), and React's reconciliation handles incremental DOM updates.
- The real issue is *visual flicker*: an unbalanced `**` flips the rest of the document to bold until the closing marker arrives. Two practical mitigations:
  - **Token healing / completion pass** before parsing: detect unclosed inline markers (`*`, `_`, `` ` ``, `**`, `__`), unclosed fenced blocks (odd count of ``` ```), unclosed link `[...](` and append the missing close. Streamdown does this; we can also do ~30 lines of pre-processing ourselves.
  - **Streaming-safe parser config**: disable HTML passthrough; trust nothing. Render the still-streaming *last block* as plain pre-wrapped text if heuristics detect it's a code fence in progress (optional polish).
- Replace the streaming caret outside the rendered markdown tree (already a sibling of `<pre>`), so it never lands inside a `<p>` or `<li>` and disrupts parsing.

## 2. Library choice

Recommend **`react-markdown` + `remark-gfm`** for these cards.

- `react-markdown` (~40kB gz with gfm): renders to React elements (not `dangerouslySetInnerHTML`), so XSS surface is minimal and we get full control via the `components` prop for styling. Mature, maintained, well-understood. Handles re-render on every delta acceptably.
- `remark-gfm` for tables, task lists, strikethrough, autolinks — the model emits these.
- Add a small local `healMarkdown(text)` helper for the unclosed-marker problem above; don't pull in a heavier streaming wrapper yet.
- Skip code-syntax highlighting in v1 (rehype-highlight / shiki adds 100–500kB). Plain monospace block first; revisit if real answers contain code.
- Why not alternatives:
  - **`marked` / `markdown-it`**: produce HTML strings → forces `dangerouslySetInnerHTML` and a sanitizer (DOMPurify, +20kB) and we lose the ergonomic `components` override.
  - **`streamdown`**: purpose-built for AI streaming and would solve (1) elegantly, but it's young, less battle-tested, and pulls more deps. Worth revisiting if our hand-rolled healing gets ugly.
- One-time cost: ~50kB gzipped added to the client bundle. Acceptable for this app.

## 3. Styling — fitting the Citation Labs system

Pass a `components` map to `react-markdown` so each element uses existing Tailwind tokens (`text-cl-blue`, `text-cl-slate`, `bg-cl-ice`, `border-cl-border`, `rounded-btn`, `rounded-card`):

- `h1/h2/h3` → uppercase, `tracking-wider`, `text-cl-blue`, decreasing sizes; mirror the panel-title treatment.
- `p` → `text-base leading-relaxed text-cl-slate max-w-[72ch]` (matches the current `<pre>`).
- `ul/ol` → `list-disc/list-decimal pl-6 space-y-1`; `li` inherits paragraph color.
- `a` → `text-cl-blue hover:underline` + `focusRing`; force `target="_blank" rel="noreferrer"` and append the existing `ExternalLink` glyph treatment used in the Sources list.
- `code` (inline) → `rounded-[3px] bg-cl-ice px-1 py-0.5 font-mono text-[0.9em] text-cl-navy`.
- `pre > code` (block) → `rounded-btn border border-cl-border bg-cl-bg-soft p-4 font-mono text-[12px] leading-relaxed overflow-x-auto` (matches the existing raw-event-log block at page.tsx:587).
- `blockquote` → `border-l-4 border-cl-blue bg-cl-ice/60 px-4 py-2 text-cl-slate` (reuses the existing "note" treatment at page.tsx:526).
- `table` → reuse the look of `FanoutTable` (page.tsx:785): blue header row, even-row tint `bg-cl-ice/50`, `border-cl-border`.
- `hr` → `border-cl-border`.
- Strip default browser margins; rely on `space-y-3` on the wrapper for vertical rhythm so cards stay tight.

Wrap the whole thing in a single `<Markdown>` component (new file `app/markdown.tsx`) so Reasoning and Answer share it.

## 4. Where the change lands

- **New**: `app/markdown.tsx` — exports `<Markdown text="..." streaming={busy} />`. Owns the `components` map and the `healMarkdown` helper.
- **Edit**: `app/page.tsx`
  - Reasoning panel: replace the `<pre>...</pre>` block at **page.tsx:519–522** with `<Markdown text={reasoning} streaming={busy} />`. Keep the `StreamingCaret` as a sibling so it sits after the rendered markdown, not inside it.
  - Answer panel: replace the `<pre>...</pre>` block at **page.tsx:534–537** the same way.
  - The empty-state branches (page.tsx:524, 539) and the note block (page.tsx:526–529) stay as-is.
  - Reasoning currently joins parts with `"\n\n"` at **page.tsx:118** — keep this; it produces a valid markdown paragraph break between summary parts.
- **Edit**: `package.json` — add `react-markdown` and `remark-gfm`.
- No server / SSE / DB changes. The stored payloads are already plain text.

## 5. Risks

- **XSS**: `react-markdown` defaults are safe (no raw HTML). Do *not* add `rehype-raw`. Links: force `rel="noreferrer"` and `target="_blank"` in the `a` component override; the default `urlTransform` already blocks `javascript:` URLs — keep it.
- **Layout shift during streaming**: when an unclosed `**` or fence is finally closed, blocks re-flow. Token healing (§1) absorbs most of it. Set a stable container `min-h` and keep the caret outside the markdown tree to avoid jitter.
- **Perf with long answers**: re-parsing on every token is O(n) per render. For typical answers (<20kB) this is fine. Mitigations if it bites: `useMemo` the parsed output keyed on text length bucket, or throttle re-renders with `requestAnimationFrame` coalescing in `handleEvent`. Not needed v1.
- **Auto-scroll**: not currently implemented; markdown re-flow could move content. Out of scope, but flag it.
- **Replay path**: `replay()` calls `handleEvent` synchronously in a loop (page.tsx:365). Each event triggers a setState → fine, but the markdown renders once at the end after React batches. No change needed.
- **Bundle size**: +~50kB gz. Acceptable; revisit if we add syntax highlighting.

## Out of scope (note for follow-ups)

- Code syntax highlighting (shiki / rehype-highlight).
- Click-to-copy on code blocks.
- Inline citation rendering (`[1]` → linked source) — the answer already includes annotation events; could be tied to the Sources list later.
- Auto-scroll-to-bottom as content streams.
