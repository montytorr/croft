'use client'

import { createContext, useContext } from 'react'

/**
 * Every knowledge slug that exists, so a `[[reference]]` to one that does not
 * can be marked rather than linked into the void.
 *
 * The default is `null`, not `[]`, and the difference is the whole point.
 * `remarkKnowledgeRefs` marks any reference it cannot find in the list it is
 * given, so an empty list means "nothing exists" and paints every reference on
 * the page as broken. `null` means "nobody told me", and nothing is marked.
 *
 * That is also why CROFT-192 left the marking unwired: the only slug list to
 * hand was a page capped at 300 against a corpus of 377, and using it would
 * have declared 77 real entries missing. A partial list is worse here than no
 * list, so this carries the complete one or none at all.
 */
const KnowledgeSlugsContext = createContext<readonly string[] | null>(null)

export const KnowledgeSlugsProvider = ({
  slugs,
  children,
}: {
  slugs: readonly string[] | null
  children: React.ReactNode
}) => <KnowledgeSlugsContext.Provider value={slugs}>{children}</KnowledgeSlugsContext.Provider>

export const useKnowledgeSlugs = () => useContext(KnowledgeSlugsContext)
