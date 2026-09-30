# Decision: markdown stays the source of truth

**Status:** resolved. Option A adopted.
**Evidence:** `src/lib/editor/markdown.test.ts` — 45 tests, all passing.
**Updated:** GFM tables round-trip (ported from Cairn, CAIRN-326); bodies that would still lose content are
edited as markdown.

## The problem

Two requirements pull against each other:

1. A task body **is markdown**, stored in `tasks.description`, because agents read and
   write it over the API.
2. Humans edit it through **Tiptap**, which is WYSIWYG over a ProseMirror document.

So every human edit round-trips `markdown → ProseMirror → markdown`. Anything the editor
schema cannot represent is lost on that trip. The failure mode is quiet and bad: an agent
writes valid markdown, a human opens the task and saves it, and the body silently changes.

## Decision

**Markdown is the source of truth, and the editor schema is constrained to constructs
that map 1:1 onto GFM.** Anything outside it is dropped deliberately rather than mangled,
and the losses are enumerated below.

Rejected alternatives:

- *ProseMirror JSON as truth with a generated markdown mirror.* Lossless for humans, but
  agents write markdown that must convert inbound, so the lossy step only moves.
- *No WYSIWYG, split-pane raw markdown.* Zero risk, but rejected on product grounds.

## What the tests establish

Verified idempotent — a second round trip changes nothing:

headings · emphasis (italic/bold/inline code) · bullet lists · ordered lists · nested
lists · task lists with checkbox state · fenced code with language · blockquotes · links ·
**images** · horizontal rules · strikethrough · paragraphs · **GFM tables**

Tables are held to a stricter bar than stable: they come back **byte-for-byte**. Cases:
a simple table, all four column alignments, inline code and bold in cells, escaped pipes
in text and inside a code span, links and strikethrough in cells, an empty cell, a
header-only table, a table between paragraphs, and one inside a blockquote.

Plus an explicit case for a realistic agent-written body (headings, checkboxes, a fenced
block) confirming that open-and-save with no edits leaves it byte-stable.

## Documented losses — trade-offs, not bugs

| Construct | Behaviour | Why |
|---|---|---|
| Raw HTML, comments included | **Dropped** (escaped) | `html: false`. Not round-trippable; dropping beats corrupting. Edited as markdown instead. |
| Headings `####`–`######` | **Flattened** to paragraphs | The schema has levels 1–3. Edited as markdown instead. |
| Footnotes `[^1]` | **Broken** (brackets escaped) | markdown-it's default preset has no footnotes. Edited as markdown instead. |
| Table row with more cells than its header | Extra cells **dropped** | GFM ignores them too, so they never rendered. Edited as markdown instead. |
| Table delimiter row | Normalised to `\| --- \| :---: \|` | Alignment is kept; only dash counts change. |
| Table row short of cells | Padded with empty cells | Renders the same. |
| `*` list markers | Normalised to `-` | One canonical marker; content is unchanged. |
| Setext headings | Normalised to ATX (`# `) | Same. |

None of the losses reaches a saved body through the rich editor: `richEditLoss()` in
`src/lib/editor/markdown.ts` spots each one, and `MarkdownEditor` then edits that body as
its markdown in a textarea, with the reason shown under it. Tiptap never parses it. The
write-up editor opens such a body in its Markdown tab and keeps the Rich tab disabled.

For tables, `richEditLoss()` also runs the rule itself rather than only the named checks:
a body with a table goes to the rich editor only when every table renders to the same
HTML before and after the round trip. Without a DOM to run that in, it assumes a loss.

## Two findings worth recording

1. **`tiptap-markdown@0.9.0` declares `@tiptap/core: ^3.0.1`.** The main compatibility
   risk going in — that it was a v2-era package — turned out not to exist.
2. **Images need `@tiptap/extension-image` explicitly.** StarterKit does not include it,
   and without it a markdown image is dropped *entirely* on the round trip. That would
   have silently deleted screenshot references from agent-written bodies. This is the
   thing the spike was for; it would not have been caught by review.

## Tables

Tables were deferred here as "no real task needs one yet". Agents then wrote them, and a
human who fixed a typo in such a body saved it back as flattened text.

Now `@tiptap/extension-table` (v3, matching the rest of Tiptap) is in the schema, with its
own markdown serialiser in `markdown.ts` rather than tiptap-markdown's. The stock one:

- writes every delimiter as `---`, so **column alignment was lost**;
- leaves a `|` in a cell unescaped, so `a \| b` **split into two cells** on the next parse;
- writes the literal `[table]` for any table it will not call GFM (a header row turned
  off, a merged cell, two paragraphs in a cell) once html is off, and `[hardBreak]` for a
  shift-enter in a cell.

The replacement always writes a pipe table: the first row is the header, spans are laid
out as empty cells, a cell's line breaks and extra blocks become spaces, and every `|` in
a cell is escaped, code spans included, as GFM requires. Each cell is rendered by a fresh
serialiser state, because tiptap-markdown's state trims whitespace at recorded buffer
offsets, and rendering a cell into a borrowed buffer moved that trim onto the delimiter
row (`| --- |` came out as ` -- |`). Column resizing is off: widths are not markdown.

**Guards.** Never save a body that is unchanged, and never take a body through Tiptap
when `richEditLoss()` says the trip would lose part of it.
