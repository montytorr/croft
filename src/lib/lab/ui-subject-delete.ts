import type { Subject } from './types'

/**
 * Who may delete a subject: its owner, whatever its visibility; and an
 * administrator, for a subject in the lab only. Everyone sees a lab subject,
 * so clearing one out of the shared lab is moderation. A private or members
 * subject is its owner's alone, administrators included, as for visibility.
 *
 * A plain module, not a client file: the server enforces it and the page
 * uses the same rule to decide whether to offer the action.
 */
export const canDeleteSubject = (
  subject: Pick<Subject, 'owner' | 'visibility'>,
  viewer: { userId: string; role: string },
) => (subject.owner !== null && subject.owner.id === viewer.userId) || (viewer.role === 'admin' && subject.visibility === 'lab')
