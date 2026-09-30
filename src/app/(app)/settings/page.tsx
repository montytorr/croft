import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { admin } from '@/lib/db/client'
import { currentUser } from '@/lib/data'
import { getBranding } from '@/lib/branding'
import { PasswordSection } from './password-section'
import { LabelsSection, type LabelRow } from './labels-section'
import { LabSection } from './lab-section'
import { CairnSection } from './cairn-section'
import { BrandingSection } from './branding-section'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { getCairnConnection, listStages, listTags } from '@/lib/lab/data'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

const SettingsPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const isAdmin = user.role === 'admin'
  const [{ data: labels }, branding, stages, tags, cairn] = await Promise.all([
    admin().rpc('list_labels', { p_owner: user.id }),
    getBranding(),
    listStages(),
    listTags(),
    // The connection is an administrator's business; nobody else is sent it.
    isAdmin ? getCairnConnection() : Promise.resolve(null),
  ])

  return (
    // The layout's <main> is overflow-hidden, so every page owns its own
    // scrolling. This one never did: it fitted the viewport until Entities was
    // added, and then simply clipped — no scrollbar, no overflow, the bottom of
    // the page just gone. The header bar is the one every other page has.
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg text-[0.8125rem] font-medium">Settings</span>
        <span className="text-fg-subtle hidden text-[0.8125rem] sm:block">·</span>
        <span className="text-fg-subtle hidden truncate text-[0.8125rem] sm:block">{user.email}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Centred at a form's measure. */}
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-5">
            <PasswordSection />
            <LabSection stages={stages} tags={tags} canEdit={isAdmin} />
            {cairn ? <CairnSection connection={cairn} /> : null}
            <LabelsSection labels={(labels ?? []) as LabelRow[]} />
            {isAdmin ? (
              <BrandingSection
                initial={{ name: branding.name, accent: branding.accent }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
