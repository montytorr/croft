'use client'

import { useCallback, useState } from 'react'
import { useNotify } from '@/components/toast'
import { mutate } from '@/lib/api/mutate'
import { isConcluding, type Stage, type Subject, type SubjectSummary } from '@/lib/lab/types'
import { ConclusionDialog } from './conclusion-dialog'

type Movable = Pick<SubjectSummary, 'id' | 'ref' | 'title' | 'conclusion'>

export type MoveOutcome = 'moved' | 'failed' | 'needs-conclusion'

/**
 * Moving a subject to a stage, from anywhere — a dragged card, a list row, the
 * subject's own sidebar.
 *
 * A completed or dropped stage needs a conclusion. When the subject has none,
 * the conclusion dialog opens instead of a PATCH the API would refuse; and if
 * the server refuses anyway (`conclusion_required` — someone cleared it in
 * between), the dialog opens then rather than a toast saying so. `onMoved`
 * fires after every move that landed, whichever way it got there.
 */
export const useStageMove = (onMoved: (subject: Subject, stage: Stage) => void) => {
  const notify = useNotify()
  const [asking, setAsking] = useState<{ subject: Movable; stage: Stage } | null>(null)

  const send = useCallback(
    async (subject: Movable, stage: Stage, conclusion?: string): Promise<MoveOutcome> => {
      const result = await mutate<Subject>(`/api/v1/subjects/${subject.ref}`, {
        method: 'PATCH',
        body: { stage: stage.id, ...(conclusion ? { conclusion } : {}) },
      })
      if (!result.ok) {
        if (result.code === 'conclusion_required') {
          setAsking({ subject, stage })
          return 'needs-conclusion'
        }
        notify(result.error)
        return 'failed'
      }
      onMoved(result.data, stage)
      return 'moved'
    },
    [notify, onMoved],
  )

  const move = useCallback(
    async (subject: Movable, stage: Stage): Promise<MoveOutcome> => {
      if (isConcluding(stage.category) && !subject.conclusion?.trim()) {
        setAsking({ subject, stage })
        return 'needs-conclusion'
      }
      return send(subject, stage)
    },
    [send],
  )

  const cancel = useCallback(() => setAsking(null), [])

  const dialog = asking ? (
    <ConclusionDialog
      subjectTitle={asking.subject.title}
      stage={asking.stage}
      onCancel={cancel}
      onConfirm={async (conclusion) => {
        const outcome = await send(asking.subject, asking.stage, conclusion)
        if (outcome === 'moved') setAsking(null)
        return outcome === 'moved'
      }}
    />
  ) : null

  return { move, dialog }
}
