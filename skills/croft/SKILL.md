---
name: croft
description: "Lab board for exploring and proving ideas: new tech to evaluate, POCs, things to build before they become real work. Use BEFORE evaluating or prototyping anything to check what the lab already concluded; to file a subject, move it through stages, log findings, add todos, and record the conclusion. Triggers on 'should we use X', 'evaluate', 'try out', 'POC', 'spike on', 'what did we conclude about', 'lab', 'croft', 'subject'. Not for: committed work on a repo tracked in Cairn — push the todo to Cairn instead; nor for the agent tooling itself (Cairn's session summariser, hooks, setup, sync) — file that straight in Cairn."
---

# Croft

The lab board. A **subject** (`S-12`) is one thing being explored or proved: a technology to
evaluate, a POC, an idea to build before it becomes real work. It has a markdown write-up,
a work log, tags, an owner, a **lab project** (Trig, Croft…), **todos** (`T-41`), a **stage**,
and in the end a **conclusion**.

> Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).

## The lifecycle — every subject, every time

1. **Check.** `croft check "<subject>"` before evaluating, reading docs or prototyping. The
   lab may already have concluded ("rejected: no row-level security"). `croft subject show
   S-n` the hits that matter. `#0` means the subject is new.
2. **File it.** `croft subject add "pgvector for recall" --tag db,search --project Trig --body -`
   (markdown on stdin: the question, why it matters, what would settle it). It lands in the
   first planned stage unless `--stage`.
3. **Break it into todos.** `croft subject todo S-12 "benchmark 1M rows" --body -`. From an
   agent runtime it files `T-n` and **claims by default**. Otherwise `croft claim T-41`.
   **Exit 9 means another agent holds it: pick different work**, never force it.
4. **Log as you go.** On the subject: `croft subject note S-12 - --kind finding|attempt|decision`.
   On a todo: `croft note T-41 "…" --kind attempt`. **Dead ends are `--kind attempt`**:
   "tried HNSW at m=16, recall 0.71" is the note the next agent needs most.
5. **Checkpoint before you yield.** `croft checkpoint T-41 --summary "state + next step"`.
   Written but not landed → `croft update T-41 --status in-review`.
6. **Close todos with how.** `croft done T-41 --resolution "what was found" --kind <kind>`:
   `fixed` · **`verified`** (it was already true and you checked) · `answered` · `wont-fix`.
7. **Move the subject.** `croft subject stage S-12 "exploring"`. Entering a concluding stage
   (`done`, `rejected`, `rolled out`) **requires a conclusion**:
   `croft subject stage S-12 rejected --conclusion -`. A refusal saying `conclusion_required`
   means: pass `--conclusion`. The conclusion is the answer the next `check` finds.

**Sweeping the board: one claimed task per sweep.** Hold one todo for the triage and work
the rest without claiming them: note, stage, close what you can.

**When not to file.**
- **It is committed work on a real repo** — that is Cairn's. Push the todo (below).
- **It is the agent tooling itself** — Cairn's session summariser, hooks, setup, sync. Not a lab subject, even as an idea: file it straight in Cairn, in the tool's project.
- **A subject already covers it** — add a todo or a note to that one.
- **Reading a file answers it** — no subject needed.
- **A fact that expires** ("the beta API is down today") — a note, or nothing.
- **Narrating your bookkeeping** — the log is for the next person, not a progress bar.

A subject filed by mistake is deleted (`croft subject delete S-n --confirm S-n`). One that was explored and dropped is not: it keeps its record in a dropped stage with a conclusion, which is the answer the next agent needs.

---

## Refs

- `S-12` — a subject. Used only with `croft subject …`.
- `T-41` — a todo. It is an ordinary task: `show`, `claim`, `beat`, `note`, `log`,
  `checkpoint`, `release`, `update`, `done --resolution`, `cancel`, `deps`, `history`.

Single-letter keys on purpose: they never collide with Cairn refs (`CAIRN-331`).

## Subjects

```bash
croft subject list [--stage exploring] [--tag db] [--project Trig|none] [--mine] [--all]
croft subject show S-12 [--full]          # digest: write-up, conclusion, todos, recent log
croft subject add "<title>" [--stage S] [--tag a,b] [--project P] [--owner me] [--body -]
                  [--visibility lab|members|private] [--member <who>]...
croft subject edit S-12 [--title "T"] [--body -] [--project P|none]
croft subject share S-12 +mael -sam [--visibility members|private]
croft subject publish S-12 --confirm S-12   # private/members -> lab, ONE-WAY
croft subject delete S-12 --confirm S-12    # for good, with its todos and files (owner; admin in the lab)
croft subject stage S-12 "<stage>" [--conclusion -|"text"]
croft subject note S-12 "<text>"|- [--kind finding|decision|attempt|note|handoff]
croft subject tag S-12 +vector -later     # add and remove tags
croft subject todo S-12 "<title>" [--body -]
croft subject notes S-12  |  croft subject attach S-12 <file>  |  croft subject files S-12   # people's notes; files (an image embeds as ![name](url))
```

`list` prints: ref, stage, visibility, todos open/done, tags, project, `~tokens`, title.
`--all` includes archived.

**Visibility**: a subject is `lab` (everyone sees it) unless filed `private` (its owner only)
or `members` (its owner and the people shared with). Publishing to the lab is one-way — do
it only when the owner means it. Do not push a private or members subject's todo to Cairn:
`croft push` refuses without `--force`, because Cairn shows it to everyone. A stage change writes a
`stage` note by itself ("to explore → exploring"); do not narrate it.

**Bodies and notes are markdown**: `##` headings, `-` lists, code and paths in backticks.
A wall of text is refused, naming what to fix. Secrets are refused everywhere — write
`$ENV_VAR` or a vault path instead.

## Stages, tags and projects

```bash
croft stages    # the pipeline, in order, with each stage's category
croft tags      # the curated tags
croft projects  # the lab projects, each with the Cairn key its todos go to
```

Admins curate all three in the web app. A subject is in at most one lab project. The seed pipeline:

| stage | category |
| --- | --- |
| to explore · to implement | planned |
| exploring · implementing · internal testing · ready for rollout | active |
| done · rolled out | completed (needs a conclusion) |
| rejected | dropped (needs a conclusion) |

`rejected` with a clear reason is a result, not a failure: it is what stops the next
person re-evaluating the same thing.

## From the lab to real work: push and sync

When a todo becomes committed work on a repo tracked in Cairn, hand it over:

```bash
croft push T-41                 # to the Cairn key of its subject's lab project
croft push T-41 --to CAIRN      # or name the Cairn project key; --to always wins
```

With no `--to` and no key on the subject's project, it refuses and says what is missing.
A todo whose subject is not yet in the lab (private or members) is refused too: publish the
subject first, or `--force` when its owner has said it can go.

This runs `cairn add` with the todo's title and description (plus "From Croft T-41 (subject
S-12)"), labels the Cairn task `croft:T-41`, and links the two. **From then on Cairn owns the
status**: work it there (claim, notes, done), not in Croft. `cairn` must be on PATH
(`CROFT_CAIRN_BIN` overrides).

```bash
croft sync      # pull linked Cairn statuses back
```

`sync` updates each pushed todo's Cairn status, and when the Cairn task closes it notes the
subject ("CAIRN-331 done: <resolution>") once. Then decide the subject's stage — often
`rolled out` with a conclusion.

`croft push T-41 <sha> [--branch B]` (with a sha) is the other `push`: it records a git push
on the todo as evidence, like `croft commit` and `croft run`. None of those executes anything.

## Briefing

```bash
croft context --brief   # a few lines: stage counts, your active subjects, the rule
```

A SessionStart hook prints this. When Cairn's briefing is installed it carries Croft's block
instead, so you see it once.

## Output and exit codes

TSV by default: a `#count` line, a header, rows, with a `~tokens` column for what opening a
row costs. `--json` to parse, `--pretty` for a person. `croft --help` is the reference.
Never pull bodies in bulk; the index is for choosing what to read.

- **Exit 2** — an unknown flag, or one the command never read. Nothing was filtered; fix the flag.
- **Exit 9** — another agent holds the todo. Pick different work.
- **Exit 10** — several Croft instances and none known here. Ask the user which, run the
  `croft route add <instance>` it prints, retry. Never pick one yourself.

Requires `croft` on PATH and a key per runtime (`~/.croft/env`; a person pairs them with
`croft setup --url <instance>`): the key is who wrote a thing.
