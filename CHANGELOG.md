# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Croft is pre-1.0: the schema, API and CLI may still change in a minor release. Anything that would
break an existing install is called out under **Breaking** with what to do about it.

## [Unreleased]

## [0.3.1] — 2026-09-30

Thanks to @domnumb, whose report and pull requests #1–#3 started this release.

### Security

- **The agent-files job is pinned to the release `croft setup` installed.** It used to repair the
  CLI, the session hook and the skill from `main` every 15 minutes; it now syncs `v<VERSION>` of
  the installed release (#1), and moving to a newer release is re-running the installer.
  - A job installed before this names `…/montytorr/croft/main`; the sync reads that exact URL as
    the release installed here (the version of the installed CLI), so existing machines are
    pinned on their next run without re-running setup.
  - A remote source must end in a release tag, over https (loopback aside). Following a branch is
    `CROFT_RAW_BASE` on the installer, rendered with `--unpinned`.
  - Every file is fetched before any is written: a missing file or an outage writes nothing and
    exits 1.
  - From a remote source the job never rewrites its own two scripts; `install-cron.mjs --install`
    (which setup runs) refreshes them from the release it ships with.
  - `CROFT_REPO=<owner>/<name>` (install.sh, setup, install-cron) or `CROFT_RAW_REPO=<https base>`
    installs from and follows a fork or mirror.
  - `croft setup` says what the job overwrites, how often and from where before installing it,
    and how to skip (`--no-jobs`) or remove it.
- **Setup wires hooks only into the runtimes it paired keys for** (#2).
- **`croft context --brief` no longer sends the working directory**, which the server never used.
  `CROFT_SHARE_LOCATION=off` keeps the directory, git remote and hostname of every other request
  on the machine (#3).

### Changed

- A CLI older than the server's release is now told to re-run the installer rather than the
  agent-files job, which no longer moves between releases.

**Server operators:** the server's hourly job was rendered with the `main` URL, so it now pins to
the installed CLI's release between deploys. To keep following `main` there, reinstall it with
`CROFT_RAW_BASE=https://raw.githubusercontent.com/montytorr/croft/main`.

## [0.3.0] — 2026-09-30

### Added

- **The subject page uses the whole width.** A compact header band (ref, stage, project, title,
  owner, tags), then tabs: **Write-up · Todos · Notes · Log · Files**, with a slim properties
  rail. Beside the write-up on wide screens: its outline, the open todos and the latest notes.
- **Todos live in the page.** List or board (todo · doing · in review · done), drag a card to
  change its status, add a todo inline. A todo pushed to Cairn shows Cairn's status and link,
  and cannot be dragged: Cairn owns it.
- **Human notes.** A space on each subject for people's notes, in markdown, edited or removed by
  their author. Separate from the write-up and from the log.
- **Files on subjects and todos.** Images as thumbnails with a lightbox, PDF and video inline,
  and HTML previewed only in a fully sandboxed frame. Paste or drop an image into the write-up
  and it is uploaded and inserted. `croft subject attach|files|notes`.
- **Lab projects in the navigation**, with their subject counts.
- **`/todos` and `/board` show each todo's subject**, and filter by project and by subject;
  the board can lay its lanes out by subject.

### Changed

- **Denser and quieter everywhere.** The base size drops from 18px to 16px, and headers, rows and
  labels are tighter.

### Security

- **Files that could run script are served in a sandbox.** `/api/files` sends
  `Content-Security-Policy: sandbox` for HTML, SVG and anything that is not plain media, plus
  `nosniff`. SVG was served without it before, so an SVG opened on its own could run script
  on Croft's origin.

## [0.2.0] — 2026-09-30

### Added

- **Lab projects.** A subject can belong to one project from a short list an administrator
  curates in Settings (name, colour, and optionally a Cairn project key), like tags. The board
  filters by project (`?project=`, any-of lists and `none`), and cards, rows and the subject
  page show it. `croft projects` lists them; `croft subject add|edit|list --project`.
- **`croft push T-n` knows where to go.** With no `--to`, a todo is pushed to the Cairn key of
  its subject's project; an explicit `--to` still wins, and push says what is missing when
  there is no project or no key.
- **Create a tag where you need it.** An administrator can create a tag from a subject's tag
  picker, not only in Settings.

### Removed

- **The Projects menu inherited from Cairn.** Task-container projects are an internal detail
  now: todos keep their `T-n` refs and live under their subject. `croft project list` still
  shows the containers.

## [0.1.0] — 2026-09-30

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

[Unreleased]: https://github.com/montytorr/croft/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/montytorr/croft/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/montytorr/croft/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/croft/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/croft/releases/tag/v0.1.0
