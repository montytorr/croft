import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  generatedKey: {
    key: 'croft_test_key',
    keyHash: 'test-hash',
    keyPrefix: 'croft_test',
  },
}))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
  transaction: mocks.transaction,
}))

vi.mock('./keys', () => ({
  generateApiKey: () => mocks.generatedKey,
}))

import { createUserKey, deactivateUser, resetUserPassword, updateUser } from './users'

const activeUser = {
  id: 'user-1',
  email: 'julien@example.test',
  displayName: 'Julien',
  role: 'admin',
  active: true,
  deletedAt: null,
  bannedUntil: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  keyCount: 0,
  activeKeyCount: 0,
  openTaskCount: 0,
}

const admin = { userId: 'admin-1', actorType: 'human' as const, actorId: 'Cal' }

const successor = {
  ...activeUser,
  id: '00000000-0000-4000-8000-000000000002',
  email: 'marie@example.test',
  displayName: 'Marie',
  role: 'member',
}

describe('user credential administration', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.transaction.mockReset()
    mocks.transaction.mockImplementation(async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) =>
      run({ query: mocks.query }),
    )
  })

  it('sets a password, revokes browser sessions and outstanding reset links, and leaves agent keys alone', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await resetUserPassword(activeUser.id, 'a sufficiently long password')

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements[1]).toContain('session_epoch = session_epoch + 1')
    expect(statements[1]).not.toContain('auth_epoch')
    expect(statements[2]).toContain('delete from app_sessions')
    expect(statements.join('\n')).not.toContain('update api_keys')
    expect(statements[3]).toContain('update password_reset_tokens set used_at = now()')
  })

  it('locks an active user while creating an agent key at the current authentication epoch', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'key-1',
          agent_name: 'clawclaw',
          name: 'ClawClaw',
          key_prefix: mocks.generatedKey.keyPrefix,
          created_at: '2026-01-01T00:00:00.000Z',
        }],
      })

    const result = await createUserKey(activeUser.id, { agentName: 'clawclaw', name: 'ClawClaw' })

    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('for update')
    expect(String(mocks.query.mock.calls[2]?.[0])).toContain('auth_epoch')
    expect(result).toMatchObject({ id: 'key-1', key: mocks.generatedKey.key })
  })

  it('does not return plaintext for a key that was not inserted', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(createUserKey(activeUser.id, { agentName: 'clawclaw', name: 'ClawClaw' }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses to demote the final active administrator', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })

    await expect(updateUser(activeUser.id, { role: 'member' }))
      .rejects.toMatchObject({ code: 'final_admin' })

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toHaveLength(3)
    expect(statements.join('\n')).not.toContain('set email =')
  })

  it('disables a user and revokes sessions and keys in the same transaction', async () => {
    const disabledUser = { ...activeUser, active: false, deletedAt: '2026-01-02T00:00:00.000Z' }
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
      .mockResolvedValueOnce({ rows: [activeUser] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [disabledUser] })

    await expect(deactivateUser(activeUser.id, { by: admin }))
      .resolves.toMatchObject({ active: false, reassignedTaskCount: 0 })

    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(statements[1]).toContain('for update')
    expect(statements[4]).toContain('auth_epoch = auth_epoch + 1')
    expect(statements[4]).toContain('session_epoch = session_epoch + 1')
    expect(statements[5]).toContain('delete from app_sessions')
    expect(statements[6]).toContain('update api_keys set revoked_at = now()')
    expect(statements[7]).toContain('update password_reset_tokens set used_at = now()')
  })

  describe('open tasks on deactivation (CROFT-310)', () => {
    const owner = { ...activeUser, role: 'member', openTaskCount: 3 }

    it('refuses to disable an assignee of open tasks without reassignTo, and says how many', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [owner] })

      const refusal = deactivateUser(owner.id, { by: admin })
      await expect(refusal).rejects.toMatchObject({ code: 'open_tasks', details: { openTaskCount: 3 } })
      await expect(refusal).rejects.toThrow(/3 open tasks.*reassignTo/)

      const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n')
      expect(statements).not.toContain('update app_users')
      expect(statements).not.toContain('update tasks')
    })

    it('keeps the final-administrator refusal ahead of the open-task one', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: activeUser.id }] })
        .mockResolvedValueOnce({ rows: [{ ...activeUser, openTaskCount: 2 }] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] })

      await expect(deactivateUser(activeUser.id, { by: admin, reassignTo: successor.id }))
        .rejects.toMatchObject({ code: 'final_admin' })
      expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('update tasks')
    })

    it('hands open tasks over and records one assignee_changed per task in the same transaction', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [owner] })
        .mockResolvedValueOnce({ rows: [successor] })
        .mockResolvedValueOnce({ rows: [], rowCount: 3 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ ...owner, active: false, deletedAt: '2026-01-02T00:00:00.000Z', openTaskCount: 0 }] })

      await expect(deactivateUser(owner.id, { by: admin, reassignTo: successor.id }))
        .resolves.toMatchObject({ active: false, openTaskCount: 0, reassignedTaskCount: 3 })

      expect(mocks.transaction).toHaveBeenCalledTimes(1)
      const [sql, params] = mocks.query.mock.calls[4] as [string, unknown[]]
      expect(sql).toContain('update tasks set assignee_user_id = $2')
      expect(sql).toContain("status not in ('done', 'cancelled')")
      expect(sql).toContain('insert into task_activity_events')
      expect(sql).toContain("'assignee_changed'")
      expect(params).toEqual([
        owner.id,
        successor.id,
        admin.userId,
        admin.actorType,
        admin.actorId,
        { from: owner.id, to: successor.id, from_name: 'Julien', to_name: 'Marie', reason: 'user_deactivated' },
      ])
      expect(String(mocks.query.mock.calls[5]?.[0])).toContain('auth_epoch = auth_epoch + 1')
    })

    it('refuses to hand the tasks to the user being disabled', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [owner] })

      await expect(deactivateUser(owner.id, { by: admin, reassignTo: owner.id }))
        .rejects.toMatchObject({ code: 'invalid_reassignee' })
      expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('update ')
    })

    it('refuses an inactive or unknown successor', async () => {
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [owner] })
        .mockResolvedValueOnce({ rows: [{ ...successor, active: false }] })

      await expect(deactivateUser(owner.id, { by: admin, reassignTo: successor.id }))
        .rejects.toThrow(/Marie is no longer active/)

      mocks.query.mockReset()
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [owner] })
        .mockResolvedValueOnce({ rows: [] })

      await expect(deactivateUser(owner.id, { by: admin, reassignTo: successor.id }))
        .rejects.toMatchObject({ code: 'invalid_reassignee' })
    })

    it('hands on the open tasks of a user disabled before the rule without disabling again', async () => {
      const orphaned = { ...owner, active: false, deletedAt: '2026-01-02T00:00:00.000Z' }
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [orphaned] })
        .mockResolvedValueOnce({ rows: [successor] })
        .mockResolvedValueOnce({ rows: [], rowCount: 3 })
        .mockResolvedValueOnce({ rows: [{ ...orphaned, openTaskCount: 0 }] })

      await expect(deactivateUser(owner.id, { by: admin, reassignTo: successor.id }))
        .resolves.toMatchObject({ openTaskCount: 0, reassignedTaskCount: 3 })

      const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n')
      expect(statements).not.toContain('update app_users')
      expect(statements).not.toContain('update api_keys')
    })

    it('leaves an already disabled user alone when no successor is named', async () => {
      const orphaned = { ...owner, active: false, deletedAt: '2026-01-02T00:00:00.000Z' }
      mocks.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: owner.id }] })
        .mockResolvedValueOnce({ rows: [orphaned] })

      await expect(deactivateUser(owner.id, { by: admin }))
        .resolves.toMatchObject({ deletedAt: orphaned.deletedAt, reassignedTaskCount: 0 })
      expect(mocks.query).toHaveBeenCalledTimes(3)
    })
  })
})
