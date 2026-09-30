'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { HEX, STOCK_MARK, paletteFor, type AccentTokens } from '@/lib/brand-colour'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'
import { BrandMark } from '@/components/brand'

export type BrandingValue = { name: string; accent: string | null }

const STOCK_ACCENT = '#8e3f73'

/** A handful of starting points; any hex works. */
const PRESETS = ['#8e3f73', '#01519b', '#0e7490', '#15803d', '#b45309', '#be123c', '#7c3aed', '#3f3f46']

const STOCK_TOKENS: Record<'light' | 'dark', AccentTokens> = {
  light: { accent: '#8e3f73', accentFg: '#ffffff', accentSubtle: '#f0e2ea', ring: '#8e3f73' },
  dark: { accent: '#d89bc4', accentFg: '#221c20', accentSubtle: '#3a2734', ring: '#d89bc4' },
}

/**
 * One theme of the preview, drawn with the tokens saving would produce —
 * computed here by the same function the server uses, so what is shown is
 * what everyone gets.
 */
const Preview = ({
  theme,
  tokens,
  mark,
  name,
}: {
  theme: 'light' | 'dark'
  tokens: AccentTokens
  mark: string
  name: string
}) => {
  const ground = theme === 'light' ? { bg: '#f6f2ea', fg: '#221c20', muted: '#5c5358', border: '#e2dace' } : { bg: '#161316', fg: '#f1ebe7', muted: '#b7acb1', border: '#2e272e' }
  return (
    <div
      className="flex flex-1 flex-col gap-3 rounded-md border p-3 transition-colors duration-[var(--dur-2)] ease-[var(--ease-out)]"
      style={{ background: ground.bg, color: ground.fg, borderColor: ground.border }}
    >
      <div className="flex items-center gap-2 text-[0.8125rem] font-semibold tracking-tight">
        <BrandMark size={20} colour={mark} className="rounded-[5px]" />
        <span className="truncate">{name}</span>
      </div>
      <div className="rounded-md px-2 py-1 text-[0.75rem]" style={{ background: tokens.accentSubtle }}>
        Lab
      </div>
      <p className="text-[0.75rem]" style={{ color: ground.muted }}>
        Nothing in progress. <span style={{ color: tokens.accent }}>See the backlog</span>
      </p>
      <span
        className="inline-flex h-7 w-fit items-center rounded-md px-3 text-[0.75rem] font-medium"
        style={{ background: tokens.accent, color: tokens.accentFg }}
      >
        New subject
      </span>
    </div>
  )
}

/**
 * What this instance is called and looks like, for everyone who uses it.
 * Admins only — the page does not render it for anyone else, and the API
 * refuses them regardless.
 */
export const BrandingSection = ({ initial }: { initial: BrandingValue }) => {
  const router = useRouter()
  const [name, setName] = useState(initial.name === 'Croft' ? '' : initial.name)
  const [accent, setAccent] = useState(initial.accent ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const valid = accent === '' || HEX.test(accent)
  const palette = useMemo(() => (accent && HEX.test(accent) ? paletteFor(accent) : null), [accent])
  const shownName = name.trim() || 'Croft'

  const save = async (reset = false) => {
    setBusy(true)
    setMessage(null)
    const result = await mutate('/api/v1/branding', {
      method: 'PUT',
      body: reset ? { name: null, accent: null } : { name: name.trim() || null, accent: accent || null },
    })
    setBusy(false)
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error })
      return
    }
    if (reset) {
      setName('')
      setAccent('')
    }
    setMessage({ tone: 'ok', text: 'Saved. Everyone sees it on their next page load.' })
    router.refresh()
  }

  return (
    <SettingsCard
      title="Branding"
      description={
        <>
          What this instance is called and its colour, for everyone who signs in: the sidebar, tab titles,
          the login page, the favicon and link previews. The mark stays the croft, drawn in the accent, so
          someone who uses more than one Croft can tell at a glance which one this is.
        </>
      }
      footer={
        <>
          {message ? (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'enter-rise min-w-0 flex-1 basis-60 rounded-md px-2.5 py-1.5 text-xs',
                message.tone === 'error' ? 'text-danger bg-danger-subtle' : 'text-fg-muted',
              )}
            >
              {message.text}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={busy || !valid}>
              {busy ? 'Saving…' : 'Save branding'}
            </Button>
            <Button variant="ghost" onClick={() => void save(true)} disabled={busy}>
              Reset to stock
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-fg-subtle text-[0.6875rem] font-medium">Name</span>
          <Input
            value={name}
            maxLength={60}
            placeholder="Croft"
            onChange={(e) => setName(e.target.value)}
            className="max-w-xs"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-fg-subtle text-[0.6875rem] font-medium">Accent</span>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAccent(preset === STOCK_ACCENT ? '' : preset)}
                aria-label={preset === STOCK_ACCENT ? 'Stock heather' : preset}
                title={preset === STOCK_ACCENT ? 'Stock heather' : preset}
                className={cn(
                  'inset-ring-black/12 size-6 rounded-full inset-ring',
                  'transition-[box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)]',
                  (accent || STOCK_ACCENT) === preset
                    ? 'ring-fg ring-offset-surface ring-2 ring-offset-2'
                    : 'hover:ring-border-strong hover:ring-offset-surface hover:ring-2 hover:ring-offset-2',
                )}
                style={{ background: preset }}
              />
            ))}
            <input
              type="color"
              value={valid && accent ? accent : STOCK_ACCENT}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Pick any colour"
              className="border-border size-6 cursor-pointer rounded-full border bg-transparent p-0"
            />
            <Input
              value={accent}
              onChange={(e) => setAccent(e.target.value.trim())}
              placeholder={STOCK_ACCENT}
              aria-invalid={!valid}
              className={cn('w-28 font-mono', !valid && 'border-danger')}
            />
          </div>
          <p className="text-fg-subtle text-[0.6875rem]">
            Each theme gets a variant of it that stays readable on its background, so the colour may come out
            a little lighter in dark mode.
          </p>
        </div>

        {/* The live preview, in a well of its own so it reads as a picture of
            the product rather than a piece of this page. */}
        <div className="border-border bg-bg-elevated flex flex-col gap-2 rounded-lg border p-2 sm:flex-row">
          <Preview theme="light" tokens={palette?.light ?? STOCK_TOKENS.light} mark={palette?.dark.accent ?? STOCK_MARK} name={shownName} />
          <Preview theme="dark" tokens={palette?.dark ?? STOCK_TOKENS.dark} mark={palette?.dark.accent ?? STOCK_MARK} name={shownName} />
        </div>
      </div>
    </SettingsCard>
  )
}
