'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { CheckCircle2, CircleDashed, RefreshCw } from 'lucide-react'
import { Button, Input } from '@/components/ui/control'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { mutate } from '@/lib/api/mutate'
import type { CairnConnection } from '@/lib/lab/types'
import { SettingsCard } from './settings-card'

/** Whatever the sync reports, said as a sentence rather than as JSON. */
const describeSync = (data: unknown): string => {
  if (!data || typeof data !== 'object') return 'Synced.'
  const counts = Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
  return counts.length ? `Synced — ${counts.join(', ')}.` : 'Synced.'
}

/**
 * The link to a Cairn instance, where todos pushed with `croft push` are
 * actually worked. Croft pulls each linked task's status back on "Sync now"
 * and logs it on the subject when the Cairn task closes.
 *
 * The API key is write-only: the server never sends it back, only whether one
 * is set. Leaving the field empty keeps the current key.
 */
export const CairnSection = ({ connection }: { connection: CairnConnection }) => {
  const router = useRouter()
  const [url, setUrl] = useState(connection.url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const dirty = url.trim() !== (connection.url ?? '') || apiKey.trim() !== ''

  const save = async () => {
    setSaving(true)
    setMessage(null)
    const result = await mutate<CairnConnection>('/api/v1/integrations/cairn', {
      method: 'PUT',
      body: { url: url.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
    })
    setSaving(false)
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error })
      return
    }
    setApiKey('')
    setMessage({ tone: 'ok', text: 'Connection saved.' })
    router.refresh()
  }

  const sync = async () => {
    setSyncing(true)
    setMessage(null)
    const result = await mutate('/api/v1/integrations/cairn/sync', { method: 'POST' })
    setSyncing(false)
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error })
      return
    }
    setMessage({ tone: 'ok', text: describeSync(result.data) })
    router.refresh()
  }

  const ready = Boolean(connection.url && connection.key_set)

  return (
    <SettingsCard
      title="Cairn connection"
      description="Where todos pushed with croft push are worked. Croft reads their status back, and logs on the subject when one closes."
      footer={
        <>
          <span className="text-fg-subtle flex items-center gap-1.5 text-[0.75rem]">
            {connection.last_synced_at ? (
              <>
                Last synced <RelativeTime iso={connection.last_synced_at} className="text-fg-muted" />
              </>
            ) : (
              'Never synced'
            )}
          </span>
          {message ? (
            <p className={message.tone === 'error' ? 'text-danger enter-rise text-[0.75rem]' : 'text-status-done enter-rise text-[0.75rem]'} role={message.tone === 'error' ? 'alert' : undefined}>
              {message.text}
            </p>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void sync()} disabled={!ready || syncing || dirty} className="ml-auto px-3" title={dirty ? 'Save the connection first' : undefined}>
            {syncing ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
            Sync now
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-[0.75rem] font-medium">Cairn URL</span>
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://cairn.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted flex items-center gap-2 text-[0.75rem] font-medium">
            API key
            {connection.key_set ? (
              <span className="text-status-done inline-flex items-center gap-1 font-normal">
                <CheckCircle2 size={12} aria-hidden /> a key is set
              </span>
            ) : (
              <span className="text-fg-subtle inline-flex items-center gap-1 font-normal">
                <CircleDashed size={12} aria-hidden /> no key yet
              </span>
            )}
          </span>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connection.key_set ? 'Leave empty to keep the current key' : 'A Cairn API key'}
            autoComplete="new-password"
            spellCheck={false}
          />
        </label>
        <div>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || saving || !url.trim()} className="px-3">
            {saving ? <Spinner /> : 'Save connection'}
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
