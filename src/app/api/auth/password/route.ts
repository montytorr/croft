import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionUser } from '@/lib/auth/session'
import { setPasswordOn } from '@/lib/api/users'
import { transaction } from '@/lib/db/client'

const bodySchema = z.object({ password: z.string().min(12).max(1024) })

export const POST = async (request: Request) => {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Password must be at least 12 characters.' }, { status: 400 })
  await transaction((client) => setPasswordOn(client, user.id, parsed.data.password))
  return NextResponse.json({ ok: true })
}
