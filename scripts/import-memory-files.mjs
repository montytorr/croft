#!/usr/bin/env node
/**
 * Imports curated agent memory files into Croft knowledge.
 *
 * Claude Code writes memory as one markdown file per fact under
 * `~/.claude/projects/<dir>/memory/`, with frontmatter carrying a kebab-case
 * `name` and a one-line `description`, and `[[wiki-links]]` between them. That
 * shape is already what `knowledge` holds -- the slug, the title, the body and
 * the links all map across without reinterpretation.
 *
 * These are the good part of the memory that existed before Croft held any:
 * hand-written, corrected over months, and about things that are still true.
 * The machine-generated observation corpus is deliberately NOT imported here.
 *
 * Usage:
 *   node scripts/import-memory-files.mjs --dry-run
 *   node scripts/import-memory-files.mjs --map projects.json
 *   node scripts/import-memory-files.mjs --global          # all of it, unscoped
 *
 *   --root <dir>   where the per-project memory directories live
 *   --map <file>   JSON of { "<directory name>": "PROJECT_KEY" | null }, where
 *                  null means import that directory's memory globally
 *   --global       treat every unmapped directory as global rather than
 *                  refusing it
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
const GLOBAL = process.argv.includes('--global')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}
const ROOT = arg('--root') ?? join(homedir(), '.claude', 'projects')

/**
 * Directory name -> Croft project key, from `--map`.
 *
 * A directory mapped to null is imported globally: memory written in a home
 * directory is usually about the machine and the toolchain rather than one
 * codebase, which is exactly the supra-project case knowledge exists for.
 *
 * There is no built-in mapping, and there cannot be one: these directory names
 * are one machine's own layout. Without a map every directory is unmapped, and
 * an unmapped directory is refused rather than quietly filed global -- knowledge
 * in the wrong scope is read by every project that should not see it.
 */
const PROJECTS = (() => {
  const path = arg('--map')
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`--map ${path}: ${error.message}`)
    process.exit(1)
  }
})()

/**
 * Every directory that holds memory, whether it was mapped or not.
 *
 * Iterating the map alone is why this said nothing useful on a machine it was
 * not written for: each entry was absent, every one was skipped, and the run
 * reported zero imports with no hint that it had found no directories at all.
 */
if (!existsSync(ROOT)) {
  console.error(`no such directory: ${ROOT}\nPass --root <dir> if memory lives elsewhere.`)
  process.exit(1)
}

const unmapped = []
const candidates = readdirSync(ROOT)
  .filter((name) => {
    const dir = join(ROOT, name)
    return statSync(dir).isDirectory() && existsSync(join(dir, 'memory'))
  })
  .map((name) => {
    const mapped = Object.prototype.hasOwnProperty.call(PROJECTS, name)
    if (!mapped && !GLOBAL) unmapped.push(name)
    return [name, mapped ? PROJECTS[name] : null]
  })
  .filter(([name]) => GLOBAL || Object.prototype.hasOwnProperty.call(PROJECTS, name))

if (candidates.length === 0) {
  console.error(
    unmapped.length > 0
      ? `${unmapped.length} director${unmapped.length === 1 ? 'y holds' : 'ies hold'} memory and none is mapped:\n` +
          unmapped.map((n) => `  ${n}`).join('\n') +
          `\n\nWrite a --map file of { "<directory>": "KEY" | null }, or --global to import it all unscoped.`
      : `no memory directories under ${ROOT}`,
  )
  process.exit(1)
}

if (unmapped.length > 0) {
  console.log(`skipping ${unmapped.length} unmapped director${unmapped.length === 1 ? 'y' : 'ies'}:`)
  for (const name of unmapped) console.log(`  ${name}`)
  console.log('')
}

const parse = (raw) => {
  if (!raw.startsWith('---')) return { front: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { front: {}, body: raw }

  const front = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (m) front[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  // `type:` lives under a nested metadata block; the flat scan above catches it.
  return { front, body: raw.slice(end + 4).trim() }
}

/** MEMORY.md carries the human-written title for each file. Nothing else does. */
const titlesFrom = (dir) => {
  const path = join(dir, 'MEMORY.md')
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^-\s*\[([^\]]+)\]\(([^)]+\.md)\)/)
    if (m) out[m[2]] = m[1].replace(/\.md$/, '')
  }
  return out
}

const croft = (args, body) => {
  if (DRY) return 'dry-run'
  return execFileSync('croft', args, { input: body ?? '', encoding: 'utf8' })
}

let imported = 0
let skipped = 0
const collisions = []
const requalified = []

for (const [dir, project] of candidates) {
  const memoryDir = join(ROOT, dir, 'memory')

  const titles = titlesFrom(memoryDir)
  const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')

  for (const file of files) {
    const raw = readFileSync(join(memoryDir, file), 'utf8')
    const { front, body } = parse(raw)
    if (!body.trim()) {
      skipped += 1
      continue
    }

    // The slug CHECK in 013 allows lowercase words separated by single
    // hyphens. Frontmatter names are mostly already that shape, but 148 of
    // these files use underscores (`project_aircall_widget_...`) and were
    // being rejected outright rather than collided -- which looked identical
    // in the summary and was not.
    const slug = (front.name || file.replace(/\.md$/, ''))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    // MEMORY.md is supposed to carry a human title per file, but in several
    // projects its link text is just the filename -- which produced 110 rows
    // titled `project_recap_encoding_recurrence`. A title that is only the
    // slug in disguise tells a reader nothing the slug did not.
    const indexed = titles[file]
    const looksLikeFilename = !indexed || /_/.test(indexed) || /^[a-z0-9-]+$/.test(indexed)
    const title =
      (looksLikeFilename ? front.description?.slice(0, 200) : indexed) ||
      indexed ||
      slug.replace(/-/g, ' ')

    const labels = [front.type, project ? null : 'global'].filter(Boolean)

    const args = ['learn', title, '--slug', slug, '--body', '-']
    if (project) args.push('--project', project)
    if (labels.length) args.push('--label', labels.join(','))

    // The description is the one-line summary and the body is the fact; keeping
    // both means the index line reads well without opening the row.
    const full = front.description ? `${front.description}\n\n${body}` : body

    try {
      croft(args, full)
      imported += 1
    } catch (error) {
      const message = String(error.stderr ?? error.message)
      if (!message.includes('already exists')) {
        console.error(`  ! ${slug}: ${message.trim().split('\n')[0]}`)
        skipped += 1
        continue
      }

      // A taken slug means one of two very different things, and guessing
      // wrong is expensive in both directions. If the row already there has
      // this exact body it is this same file, imported by an earlier pass --
      // re-slugging it produced 125 duplicate rows. If the body differs it is
      // a different project's fact of the same name (every codebase has a
      // `feedback-verify-branch-before-commit`), and dropping it loses content.
      let existing = null
      try {
        existing = JSON.parse(
          execFileSync('croft', ['know', slug, '--json'], { encoding: 'utf8' }),
        )
      } catch {
        existing = null
      }

      if (existing && existing.body?.trim() === full.trim()) {
        skipped += 1
        continue
      }

      if (!project) {
        collisions.push(slug)
        skipped += 1
        continue
      }

      const qualified = `${project.toLowerCase()}-${slug}`
      try {
        croft([...args.slice(0, 2), '--slug', qualified, ...args.slice(4)], full)
        imported += 1
        requalified.push(qualified)
      } catch {
        collisions.push(slug)
        skipped += 1
      }
    }
  }
  console.log(`${dir} -> ${project ?? 'global'}: ${files.length} files`)
}

console.log(`\nimported ${imported}, skipped ${skipped}`)
if (requalified.length) console.log(`re-slugged to avoid a collision: ${requalified.length}`)
if (collisions.length) {
  console.log(`slug collisions (already present): ${collisions.length}`)
  console.log(collisions.slice(0, 10).join('\n'))
}
