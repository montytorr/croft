'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Archive, ArchiveRestore, Check, ChevronsUpDown, Plus, Tags } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import { RelativeTime } from '@/components/relative-time'
import { Button } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import type { LabProject, Stage, Subject, Tag } from '@/lib/lab/types'
import { nextPreset } from '@/lib/lab/ui-colours'
import { filterTags, tagToCreate } from '@/lib/lab/ui-tag-picker'
import { cn } from '@/lib/utils'
import { ProjectLabel } from './project-label'
import { StageGlyph } from './stage'
import { SubjectAccess } from './subject-access'
import { TagChip } from './tag-chip'
import { useStageMove } from './use-stage-move'

export const LABEL = 'pane-label'

const ROW =
  'row-hover group/edit relative -mx-2 flex min-h-[1.75rem] items-center gap-2 rounded-md px-2 ' +
  'has-[:focus-visible]:bg-surface-hover has-[:focus-visible]:shadow-[inset_2px_0_0_var(--accent)]'

const RowLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fg-subtle w-[4rem] shrink-0 text-[0.75rem]">{children}</span>
)

const Affordance = () => (
  <ChevronsUpDown
    size={11}
    aria-hidden
    className="text-fg-subtle ml-auto shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-100 group-has-[:focus-visible]/edit:opacity-100"
  />
)

/**
 * The subject's properties: stage, project, owner, tags — each changed in
 * place — then who can see it, and the archive action at the foot. Tags come from the curated list
 * an admin keeps, so the picker is a checklist with a filter; an
 * administrator can also add to the list from here, where the need shows up.
 */
export const SubjectProperties = ({
  subject,
  stages,
  tags,
  projects,
  canCreateTags,
}: {
  subject: Subject
  stages: Stage[]
  tags: Tag[]
  projects: LabProject[]
  /** An administrator: typing a tag that does not exist offers to create it. */
  canCreateTags?: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const { people, currentUserId } = usePeople()
  const [pickingTags, setPickingTags] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const onMoved = useCallback(() => router.refresh(), [router])
  const { move, dialog } = useStageMove(onMoved)

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true)
    const result = await request(`/api/v1/subjects/${subject.ref}`, { method: 'PATCH', body })
    setBusy(false)
    if (result.ok) router.refresh()
    return result.ok
  }

  const tagNames = subject.tags.map((t) => t.name)
  const toggleTag = (name: string) =>
    void patch({ tags: tagNames.includes(name) ? tagNames.filter((n) => n !== name) : [...tagNames, name] })

  const shownTags = filterTags(tags, tagQuery)
  const creatable = canCreateTags ? tagToCreate(tags, tagQuery) : null

  // Onto the curated list, then onto this subject: the reason it was typed.
  const createTag = async (name: string) => {
    setBusy(true)
    const created = await request<Tag>('/api/v1/tags', {
      method: 'POST',
      body: { name, color: nextPreset(tags.length) },
    })
    setBusy(false)
    if (!created.ok) return
    setTagQuery('')
    await patch({ tags: [...tagNames, created.data.name] })
  }

  const onTagQueryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (tagQuery) setTagQuery('')
      else setPickingTags(false)
      return
    }
    if (e.key !== 'Enter' || busy) return
    e.preventDefault()
    const exact = tags.find((t) => t.name.toLowerCase() === tagQuery.trim().toLowerCase())
    if (exact) {
      toggleTag(exact.name)
      setTagQuery('')
    } else if (creatable) void createTag(creatable)
    else if (shownTags.length === 1) {
      toggleTag(shownTags[0]!.name)
      setTagQuery('')
    }
  }

  const archived = Boolean(subject.archived_at)
  const ownerKnown = subject.owner && people.some((p) => p.id === subject.owner?.id)

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-px">
        <h2 className={cn(LABEL, 'mb-2')}>Properties</h2>

        <div className={ROW}>
          <RowLabel>Stage</RowLabel>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <StageGlyph stage={subject.stage} size={14} />
            <span className="text-fg truncate text-[0.8125rem]">{subject.stage.name}</span>
          </span>
          <Affordance />
          <select
            value={subject.stage.id}
            aria-label="Stage"
            onChange={(e) => {
              const stage = stages.find((s) => s.id === e.target.value)
              if (stage) void move(subject, stage)
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {projects.length > 0 || subject.project ? (
          <div className={ROW}>
            <RowLabel>Project</RowLabel>
            <span className="flex min-w-0 flex-1 items-center">
              {subject.project ? (
                <ProjectLabel project={subject.project} />
              ) : (
                <span className="text-fg-subtle text-[0.8125rem]">None</span>
              )}
            </span>
            <Affordance />
            <select
              value={subject.project?.id ?? ''}
              aria-label="Project"
              disabled={busy}
              onChange={(e) => void patch({ project: e.target.value || null })}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="">None</option>
              {subject.project && !projects.some((p) => p.id === subject.project?.id) ? (
                <option value={subject.project.id}>{subject.project.name}</option>
              ) : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className={ROW}>
          <RowLabel>Owner</RowLabel>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {subject.owner ? (
              <>
                <Avatar name={subject.owner.name} size={18} />
                <span className="text-fg truncate text-[0.8125rem]">
                  {subject.owner.name}
                  {subject.owner.id === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
                </span>
              </>
            ) : (
              <span className="text-fg-subtle text-[0.8125rem]">Nobody</span>
            )}
          </span>
          <Affordance />
          <select
            value={subject.owner?.id ?? ''}
            aria-label="Owner"
            disabled={busy}
            onChange={(e) => void patch({ owner: e.target.value || null })}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            <option value="">Nobody</option>
            {subject.owner && !ownerKnown ? (
              <option value={subject.owner.id}>{subject.owner.name} (inactive)</option>
            ) : null}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === currentUserId ? `${p.name} (you)` : p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="-mx-2 flex items-start gap-2 px-2 py-1.5">
          <RowLabel>Tags</RowLabel>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {subject.tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} onRemove={busy ? undefined : () => toggleTag(tag.name)} />
            ))}
            {tags.length > 0 || canCreateTags ? (
              <button
                type="button"
                aria-expanded={pickingTags}
                onClick={() => {
                  setPickingTags((v) => !v)
                  setTagQuery('')
                }}
                className="text-fg-subtle hover:text-fg hover:border-border-strong border-border flex h-[1.25rem] items-center gap-1 rounded-full border border-dashed px-2 text-[0.6875rem] transition-colors"
              >
                <Tags size={10} aria-hidden />
                {pickingTags ? 'Done' : subject.tags.length ? 'Edit' : 'Add tags'}
              </button>
            ) : subject.tags.length === 0 ? (
              <span className="text-fg-subtle text-[0.75rem]">No tags defined yet</span>
            ) : null}
          </div>
        </div>
        {pickingTags ? (
          <div className="border-border bg-surface enter-rise mt-1 flex flex-col rounded-lg border p-1">
            <input
              autoFocus
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              onKeyDown={onTagQueryKey}
              maxLength={40}
              placeholder={canCreateTags ? 'Find or create a tag…' : 'Find a tag…'}
              aria-label={canCreateTags ? 'Find or create a tag' : 'Find a tag'}
              className="text-fg placeholder:text-fg-subtle h-[1.875rem] w-full rounded-md bg-transparent px-2 text-[0.8125rem] outline-none"
            />
            <ul className="border-border flex flex-col border-t pt-1" role="group" aria-label="Tags">
              {shownTags.map((tag) => {
                const on = tagNames.includes(tag.name)
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      disabled={busy}
                      onClick={() => toggleTag(tag.name)}
                      className="hover:bg-surface-hover flex h-[1.875rem] w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] transition-colors"
                    >
                      <span
                        className={cn(
                          'grid size-[0.875rem] shrink-0 place-items-center rounded-[4px] border',
                          on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
                        )}
                      >
                        {on ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
                      </span>
                      <span className="size-[0.4375rem] shrink-0 rounded-full" style={{ backgroundColor: tag.color || 'var(--fg-subtle)' }} />
                      <span className="text-fg truncate">{tag.name}</span>
                    </button>
                  </li>
                )
              })}
              {creatable ? (
                <li>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void createTag(creatable)}
                    className="hover:bg-surface-hover text-fg-muted hover:text-fg flex h-[1.875rem] w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] transition-colors"
                  >
                    <Plus size={13} aria-hidden className="shrink-0" />
                    <span className="truncate">
                      Create tag <span className="text-fg font-medium">“{creatable}”</span>
                    </span>
                  </button>
                </li>
              ) : null}
              {shownTags.length === 0 && !creatable ? (
                <li className="text-fg-subtle px-2 py-1.5 text-[0.75rem]">
                  {tagQuery.trim()
                    ? 'No tag by that name. An administrator keeps the list.'
                    : canCreateTags
                      ? 'No tags yet. Type one to create it.'
                      : 'No tags yet.'}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </section>

      <SubjectAccess subject={subject} />

      <section className="text-fg-subtle flex flex-col gap-1 text-[0.75rem]">
        <p>
          Opened <RelativeTime iso={subject.created_at} /> by <span className="text-fg-muted">{subject.actor_id}</span>
        </p>
        <p>
          Updated <RelativeTime iso={subject.updated_at} />
        </p>
      </section>

      <section>
        {archived ? (
          <div className="flex flex-col gap-2">
            <p className="text-fg-muted text-[0.75rem]">This subject is archived. It is out of the lab, not deleted.</p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void patch({ archived: false })} className="self-start px-3">
              <ArchiveRestore size={13} aria-hidden /> Restore to the lab
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Archive “${subject.title}”? It leaves the lab but keeps its write-up, todos and log.`)) return
              if (await patch({ archived: true })) router.push('/')
            }}
            className="-ml-2 px-2 font-normal"
          >
            <Archive size={13} aria-hidden /> Archive subject
          </Button>
        )}
      </section>

      {dialog}
    </div>
  )
}
