# Changelog

## 0.1.0 (unreleased)

Forked from Cairn v0.12.1 (1ef3556).

### The lab

- **Subjects** (`S-n`): a long-form markdown write-up, an append-only log, curated tags, an owner, and a conclusion.
- **Stages**, curated by an admin: each sits in one of four fixed categories (planned, active, completed, dropped). Entering a completed or dropped stage asks for a conclusion.
- **Todos** (`T-n`) are tasks: claims, typed notes, checkpoints, resolutions.
- **Views:** a list and a board; a subject page with a full-width editor and live preview; admin settings for stages, tags and the Cairn connection.

### With Cairn

- **Push:** `croft push T-n --to KEY` files a todo as a Cairn task labelled `croft:T-n`. Cairn owns its status from then on.
- **Sync:** `croft sync` pulls the outcome back. The subject's log gets it once, and the todo closes.
- **Briefing:** one opener. Croft's installer yields to a Cairn briefing that carries Croft's block, and only to one that does.
- **Key storage:** the stored Cairn API key is sealed with AES-256-GCM (`CROFT_SECRET_KEY`).

### Editor

- **Tables** survive a rich edit exactly as written.
- **Loss guard:** a body the rich editor would still damage (raw HTML, h4–h6 headings, footnotes, over-wide rows) opens as markdown instead.

### Removed from the fork

- Cairn's memory: knowledge, sessions, vitals, recall, entities and the graph, in the UI, CLI, API and schema (migration 072).
- The session recorder and the learn nudge. Cairn records sessions; Croft doesn't need to.

### Look

- A field notebook: paper and peat grounds, a heather accent, Schibsted Grotesk and Newsreader, and runrig strips for a mark.
