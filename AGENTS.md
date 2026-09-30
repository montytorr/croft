# Croft — agent guide

Croft is the lab board: where ideas get explored and proved before they become real work.
A **subject** (`S-12`) is one thing under test — a technology to evaluate, a POC, an idea
to build first. It has a markdown write-up, an append-only log, tags, a human owner, a
lab project, **todos** (`T-41`), a **stage**, and in the end a **conclusion**: the answer
the next agent finds when it asks the same question.

> Exploring or proving an idea → `croft check` first. Changing a repo for real → a Cairn
> task (`croft push`).

Read this whole file. It is short on purpose.

---

## 1. Check before you start. Always.

```bash
croft check "pgvector for recall"
```

An index of prior subjects, todos and log notes, open *and* concluded. `croft subject show
S-n` the one or two that matter. **Do not re-evaluate what the lab already concluded** —
"rejected: no row-level security" is a result. `#0` means the subject is new.

## 2. The lifecycle — every subject, every time

```bash
croft subject add "pgvector" --tag db --project Trig --body -    # 1. file it
croft subject todo S-12 "benchmark 1M rows" --body -             # 2. break it down
croft subject note S-12 - --kind finding                         # 3. log as you go
croft subject stage S-12 exploring                               # 4. move it
croft subject stage S-12 rejected --conclusion -                 # 5. conclude it
```

1. **File it** with a body in markdown: the question, why it matters, what would settle
   it. It lands in the first planned stage unless `--stage`. `croft projects` lists the
   lab projects; `--project none` on `subject edit` takes it out of one.
2. **Todos** are ordinary tasks in project `T`. From an agent runtime `subject todo` files
   and **claims** (`--no-start` only files).
3. **Log** on the subject for what concerns the idea, on the todo for the work itself.
4. **Stages** are curated by admins (`croft stages`). A stage change writes its own log
   entry; do not narrate it.
5. **Entering a completed or dropped stage requires a conclusion.** A refusal naming
   `conclusion_required` means: pass `--conclusion`.

Bodies, notes and conclusions are markdown — `##` headings, `-` lists, code and paths in
backticks. A wall of text is refused, naming what to fix. So is anything that looks like a
secret: write `$ENV_VAR` or a vault path.

## 3. Record what did not work

| Kind | When |
|---|---|
| `finding` | You learned something about the idea |
| `attempt` | You tried something — **especially if it failed** |
| `decision` | You chose, and why |
| `handoff` | Someone else picks it up from here |

"Tried HNSW at m=16, recall 0.71" is the note the next agent needs most. A recorded dead
end saves the next agent the trying, which is the expensive part.

## 4. Todos: claim, checkpoint, close

```bash
croft claim T-41        # exit 9 if another agent holds it: pick different work
croft beat T-41         # keep the claim alive during long work
croft checkpoint T-41 --summary "benchmark written, not yet run on 1M"
croft done T-41 --resolution "recall 0.93 at 40ms p95" --kind answered
```

- **Never force a claim.** Exit 9 is an answer, not an obstacle.
- **A claim is not ownership.** Every todo has a human assignee (by default the human
  behind your key); `--assignee` gives it to someone else. The claim is only who is
  running it now.
- **Checkpoint before you yield.** It survives a release and tells whoever picks the
  todo up where you got to. Written but not landed → `--status in-review`.
- **Close with how.** `done` and `cancel` refuse without `--resolution`. With no `--kind`
  it records `fixed`; `verified` is the honest one when it was already true and you checked,
  `answered` when the todo was a question.
- **Sweeping the board: one claimed todo per sweep.** Claim the triage todo; note, stage
  and close the rest without claiming them.
- A claim goes stale after 15 silent minutes and can be taken over; after two hours with
  no beat, note, checkpoint or edit, the maintenance sweep releases it.

## 5. Pairing with Cairn

Croft is for proving; Cairn is for committed work on a repository. When a todo becomes
real work on a repo tracked in Cairn, hand it over:

```bash
croft push T-41 --to ACME     # files ACME-n in Cairn, labelled croft:T-41, and links them
croft sync                    # pulls linked Cairn statuses back
```

Without `--to` it goes to the Cairn key of the subject's lab project, and refuses when
there is none.

**From then on Cairn owns the status** — claim, note and close it there, not here. When
the Cairn task closes, `sync` notes the subject once ("ACME-331 done: …"); then decide the
subject's stage, often `rolled out` with a conclusion. `cairn` must be on PATH (or
`CROFT_CAIRN_BIN`).

`croft push T-41 <sha>` is the other push: it records a git push as
evidence, like `croft commit` and `croft run`. None of them executes anything.

**When not to file:** committed repo work (Cairn's); anything a subject already covers (add
a todo or a note there); a question reading a file answers; a fact that expires; progress
narration.

## 6. Refs and vocabulary

- `S-12` — a subject, used only with `croft subject …`. `T-41` — a todo, used with the
  task verbs. Single letters on purpose: they never collide with Cairn refs (`ACME-42`).
  Use them in prose; they stay resolvable in a transcript long after the fact.
- **stage category** — `planned | active | completed | dropped` (the last two need a conclusion)
- **todo status** — `backlog | todo | doing | in-review | done | cancelled`
- **note kind** — `note | finding | decision | attempt | handoff`
- **resolution kind** — `fixed | verified | answered | wont-fix | duplicate | not-reproducible | superseded`

## 7. The briefing

`croft context --brief` prints the lab in five lines: subjects per stage, yours in flight,
the one rule. A SessionStart hook runs it. Where Cairn's briefing is installed it carries
Croft's block instead, so you read it once. `croft next` says what to pick up and why.

## 8. Output and exit codes

Lists are TSV: a `#count` line, a header, rows, with a `~tokens` column for what opening a
row costs. `--json` to parse, `--pretty` for a person. Never pull bodies in bulk; the index
is for choosing what to read.

- **1** — an error; the message says which.
- **2** — an unknown flag, or one the command never read. Nothing was filtered; fix it.
- **9** — another agent holds the todo. Pick different work.
- **10** — several Croft instances and none known here. Ask the user which, run the
  `croft route add <instance>` it prints, retry. Never pick one yourself.

## Setup

```bash
croft setup --url https://croft.example.com   # a person, once per machine
```

It pairs a key per runtime (`CROFT_API_KEY_CLAUDE_CODE`, `CROFT_API_KEY_CODEX`, …) because
the key *is* the identity: it is who wrote a thing.

Full verb reference: `croft --help`. Machine-readable API: `GET /api/v1/openapi.json`.
