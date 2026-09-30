import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CROFT_ATTACHMENT_S3_BUCKET moves attachments from a directory to S3, for a
 * platform whose containers have no disk that survives them.
 */
const sent: { name: string; input: Record<string, unknown> }[] = []

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) => class { constructor(public input: Record<string, unknown>) { (this as unknown as { name: string }).name = name } }
  return {
    S3Client: class {
      send = async (cmd: { name: string; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.name, input: cmd.input })
        if (cmd.name === 'GetObject') return { Body: { transformToByteArray: async () => new TextEncoder().encode('hello') } }
        return {}
      }
    },
    PutObjectCommand: command('PutObject'),
    GetObjectCommand: command('GetObject'),
    DeleteObjectCommand: command('DeleteObject'),
  }
})

beforeEach(() => {
  sent.length = 0
  vi.resetModules()
  process.env.CROFT_ATTACHMENT_S3_BUCKET = 'croft-attachments'
})
afterEach(() => {
  delete process.env.CROFT_ATTACHMENT_S3_BUCKET
  delete process.env.CROFT_ATTACHMENT_S3_PREFIX
  delete process.env.CROFT_ATTACHMENT_BUCKET
})

describe('attachments in an S3 bucket', () => {
  it('writes under the storage path, and never over an existing object', async () => {
    const { writeAttachment } = await import('./attachments')
    await writeAttachment('p1/tasks/t1/abc-file.txt', Buffer.from('hello'))
    expect(sent).toEqual([{
      name: 'PutObject',
      input: expect.objectContaining({ Bucket: 'croft-attachments', Key: 'p1/tasks/t1/abc-file.txt', IfNoneMatch: '*' }),
    }])
  })

  it('reads the bytes back, and deletes', async () => {
    const { readAttachment, removeAttachments } = await import('./attachments')
    expect((await readAttachment('p1/tasks/t1/abc-file.txt')).toString()).toBe('hello')
    await removeAttachments(['p1/tasks/t1/abc-file.txt'])
    expect(sent.map((s) => s.name)).toEqual(['GetObject', 'DeleteObject'])
  })

  it('puts keys under a prefix when one is set', async () => {
    process.env.CROFT_ATTACHMENT_S3_PREFIX = '/croft/'
    const { writeAttachment } = await import('./attachments')
    await writeAttachment('p1/x.txt', Buffer.from('x'))
    expect(sent[0]?.input.Key).toBe('croft/p1/x.txt')
  })

  it('refuses a path that climbs out of the store, as the directory backend does', async () => {
    const { readAttachment } = await import('./attachments')
    await expect(readAttachment('../../etc/passwd')).rejects.toThrow('Invalid attachment path')
    await expect(readAttachment('/etc/passwd')).rejects.toThrow('Invalid attachment path')
    expect(sent).toEqual([])
  })

  /**
   * CROFT_ATTACHMENT_BUCKET=attachments sat in .env.example until the move off
   * Supabase, so older installs still have it. Read as "use S3", it broke every
   * attachment on those installs the day this backend shipped.
   */
  it('ignores the old CROFT_ATTACHMENT_BUCKET, which older installs still carry', async () => {
    delete process.env.CROFT_ATTACHMENT_S3_BUCKET
    process.env.CROFT_ATTACHMENT_BUCKET = 'attachments'
    const { writeAttachment } = await import('./attachments')
    // The directory backend: fails on the missing root here, but never calls S3.
    await writeAttachment('p1/x.txt', Buffer.from('x')).catch(() => {})
    expect(sent).toEqual([])
  })
})
