'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useDraggable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { ColumnCount, DropList } from '@/components/board-columns'
import { cn } from '@/lib/utils'
import type { Stage, Subject, SubjectSummary } from '@/lib/lab/types'
import { StageGlyph, stageTone } from './stage'
import { SubjectCard } from './subject-card'
import { useStageMove } from './use-stage-move'

const LANE_WIDTH = 'w-[18.5rem]'

const Draggable = ({ subject }: { subject: SubjectSummary }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: subject.id })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1"
    >
      <SubjectCard subject={subject} dragging={isDragging} />
    </div>
  )
}

/**
 * One stage as a rig: a strip of ground running down the board, its crown
 * lit, a furrow dotted between it and the next (`.rig-lane`, `.rig-furrow`).
 * The stage's colour is the headland across its top.
 */
/** A lane is the one under the pointer; a keyboard drag, with no pointer, falls back to overlap. */
const laneUnderPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

const Lane = ({ stage, subjects }: { stage: Stage; subjects: SubjectSummary[] }) => (
  <section
    className={cn('rig-lane rig-furrow relative flex h-full shrink-0 snap-start flex-col', LANE_WIDTH)}
    aria-label={stage.name}
  >
    <span
      aria-hidden
      className="absolute inset-x-5 top-0 h-[3px] rounded-b-full"
      style={{ backgroundColor: stageTone(stage) }}
    />
    <header className="flex h-11 shrink-0 items-center gap-2 px-3.5 pt-1">
      <StageGlyph stage={stage} size={14} />
      <span className="text-fg truncate text-ui font-medium">{stage.name}</span>
      <ColumnCount count={subjects.length} />
    </header>
    <DropList dropId={stage.id} count={subjects.length} className="min-h-0 flex-1 gap-2 overscroll-contain px-2 pb-3">
      {subjects.map((subject) => (
        <Draggable key={subject.id} subject={subject} />
      ))}
    </DropList>
  </section>
)

/**
 * The lab as a field: one lane per stage, in the order admins set. Dragging a
 * card to another lane moves the subject there; a lane that concludes (a
 * completed or dropped stage) asks for the conclusion first when there is
 * none yet, rather than firing a move the server would refuse.
 */
export const LabBoard = ({ subjects: initial, stages }: { subjects: SubjectSummary[]; stages: Stage[] }) => {
  const router = useRouter()
  const [subjects, setSubjects] = useState(initial)
  // Reconciled during render, so a move made by an agent (or settled by the
  // server) lands without a remount.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setSubjects(initial)
  }
  const [dragging, setDragging] = useState<SubjectSummary | null>(null)

  const onMoved = useCallback(
    (moved: Subject, stage: Stage) => {
      setSubjects((current) =>
        current.map((s) => (s.id === moved.id ? { ...s, stage, conclusion: moved.conclusion ?? s.conclusion } : s)),
      )
      router.refresh()
    },
    [router],
  )
  const { move, dialog } = useStageMove(onMoved)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return
    const subject = subjects.find((s) => s.id === active.id)
    const stage = stages.find((s) => s.id === over.id)
    if (!subject || !stage || subject.stage.id === stage.id) return

    const previous = subjects
    // Optimistic only where the move can land at once; a concluding lane
    // waits for the dialog, and the card stays put until it is answered.
    const asks = (stage.category === 'completed' || stage.category === 'dropped') && !subject.conclusion?.trim()
    if (!asks) setSubjects((current) => current.map((s) => (s.id === subject.id ? { ...s, stage } : s)))
    const outcome = await move(subject, stage)
    if (outcome !== 'moved') setSubjects(previous)
  }

  return (
    <>
      <DndContext
        id="lab-board"
        sensors={sensors}
        collisionDetection={laneUnderPointer}
        onDragStart={({ active }: DragStartEvent) => setDragging(subjects.find((s) => s.id === active.id) ?? null)}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="h-full snap-x scroll-px-4 overflow-auto md:snap-none">
          <div className="flex h-full w-max gap-[0.875rem] px-4 pt-4 pb-4 md:px-6">
            {stages.map((stage) => (
              <Lane key={stage.id} stage={stage} subjects={subjects.filter((s) => s.stage.id === stage.id)} />
            ))}
          </div>
        </div>
        <DragOverlay>
          {dragging ? (
            <SubjectCard subject={dragging} className="w-[17.5rem] rotate-[1.5deg] cursor-grabbing shadow-lg" />
          ) : null}
        </DragOverlay>
      </DndContext>
      {dialog}
    </>
  )
}
