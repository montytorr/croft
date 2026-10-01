'use client'

import { CircleAlert, FlaskConical, ListChecks, NotebookPen, Signpost } from 'lucide-react'
import { BrandMark, useBrand } from '@/components/brand'
import { CroftIllustration } from './croft-illustration'

/** What a subject carries, for someone signing in for the first time. */
const PILLARS = [
  { icon: FlaskConical, title: 'Subjects', body: 'A technology, a proof of concept, an idea worth building.' },
  { icon: NotebookPen, title: 'Write-ups', body: 'What it is, what we found, written to be read.' },
  { icon: ListChecks, title: 'Todos', body: 'The work each subject needs, claimed by people and agents.' },
  { icon: Signpost, title: 'Stages', body: 'Explored, developed, matured — or dropped, with a reason.' },
]

/**
 * The page around every way in: signing in, asking for a reset link, and
 * choosing a new password from one. One shell, so a link from an email lands
 * on a page that is recognisably the same Croft as the one it came from.
 */
export const AuthShell = ({ children }: { children: React.ReactNode }) => {
  const { name } = useBrand()

  return (
    <main className="bg-bg grid min-h-dvh lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* The story, on a screen wide enough to tell it. */}
      <section className="border-border bg-bg-elevated relative hidden flex-col justify-between overflow-hidden border-r p-12 lg:flex">
        <div className="relative flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
          <BrandMark size={26} className="rounded-[6px]" />
          <span>{name}</span>
        </div>

        <div className="relative flex max-w-[34rem] flex-col gap-8">
          <CroftIllustration className="w-[13rem]" />
          <div>
            {/* The grotesk for the claim, the reading serif for the second
                half: the two voices of the product in one line. */}
            <h2 className="font-display headline headline-xl text-fg text-[2.5rem] leading-[1.08]">
              The farm{' '}
              <span className="text-fg-muted font-serif font-normal italic tracking-normal">where your ideas grow.</span>
            </h2>
            <p className="text-fg-muted mt-4 max-w-[28rem] font-serif text-[1.0625rem] leading-relaxed">
              Where your team, people and agents, explores its subjects, develops them and brings
              them to maturity — and says why when one is dropped.
            </p>
          </div>
        </div>

        <ul className="relative grid max-w-[34rem] grid-cols-2 gap-x-8 gap-y-4">
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-2.5">
              <Icon size={15} className="text-fg-muted mt-0.5 shrink-0" aria-hidden />
              <span className="text-[0.75rem] leading-snug">
                <span className="text-fg font-medium">{title}</span>
                <span className="text-fg-subtle block">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="relative flex items-center justify-center px-6 py-12">
        <div className="relative w-full max-w-[21rem]">
          <div className="mb-10 flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight lg:hidden">
            <BrandMark size={26} className="rounded-[6px]" />
            <span>{name}</span>
          </div>
          {children}
        </div>
      </section>
    </main>
  )
}

/** The one error line every form on these pages uses. */
export const AuthError = ({ children }: { children: React.ReactNode }) => (
  <p className="text-danger bg-danger-subtle flex items-start gap-2 rounded-md px-3 py-2 text-xs" role="alert">
    <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
    {children}
  </p>
)
