import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreRequest } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionGuard } from './execution-guard.js'
import { createHostRuntime } from './host-runtime.js'
import { SessionLedger } from './session-ledger.js'
import { sessionIdForRun } from './session-bridge.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Host runtime composition', () => {
  it('continues serving requests when a disconnected response cannot be delivered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runwright-host-runtime-'))
    roots.push(root)
    const host = {
      sessionController: { create: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), follow: vi.fn() },
      sessionQuery: { observeSession: vi.fn() },
    }
    const requests: CoreRequest[] = [
      { id: 'cancel-1', method: 'runtime.cancel', params: { runtimeId: 'next-local', runId: 'run-1', sessionId: 's1' } },
      { id: 'cancel-2', method: 'runtime.cancel', params: { runtimeId: 'next-local', runId: 'run-1', sessionId: 's1' } },
    ]
    const connection = {
      events: (async function* () { yield* requests })(),
      publish: vi.fn(),
      respond: vi.fn().mockImplementationOnce(() => { throw new Error('CORE_DISCONNECTED') }),
    }
    const runtime = createHostRuntime(host, connection, new ExecutionGuard(), join(root, 'ledger.json'))

    await runtime.runRequests()

    expect(connection.respond).toHaveBeenCalledTimes(2)
    expect(connection.respond).toHaveBeenLastCalledWith({
      id: 'cancel-2',
      error: { code: 'CANCEL_UNKNOWN', message: 'Cancellation outcome unknown' },
    })
    runtime.dispose()
  })

  it('uses one installed guard for Core requests and publishes through the same connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runwright-host-runtime-'))
    roots.push(root)
    const sessionId = sessionIdForRun('run-1')
    const events: Array<{ seq: number; time: number; type: string; data: unknown }> = []
    const host = {
      sessionController: {
        create: async () => ({ sessionId }),
        prompt: async () => {
          events.push({ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } })
          return { accepted: true as const }
        },
        cancel: async () => {},
        follow: async function* () {
          yield {
            type: 'snapshot' as const,
            header: {},
            cursor: events.length - 1,
            records: events.map(event => ({ type: 'event' as const, event })),
            hasMore: false,
            projections: {},
          }
        },
      },
      sessionQuery: {
        observeSession: async () => ({
          header: { cwd: '/project' },
          events,
          cursor: events.length - 1,
          [Symbol.dispose]: () => {},
        }),
      },
    }
    const request: CoreRequest = {
      id: 'start-1',
      method: 'runtime.start',
      params: {
        runId: 'run-1',
        project: { id: 'p1', name: 'Project', rootPath: '/project', createdAt: '2026-10-27T00:00:00Z' },
        prompt: 'fixture requirement',
        policy: { allowedTools: [], requireApprovalFor: [] },
      },
    }
    const connection = {
      events: (async function* () { yield request })(),
      publish: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
    }
    const guard = new ExecutionGuard()
    const runtime = createHostRuntime(host, connection, guard, join(root, 'ledger.json'))

    await runtime.runRequests()
    await vi.waitFor(() => expect(connection.publish).toHaveBeenCalled())

    expect(connection.respond).toHaveBeenCalledWith({
      id: 'start-1',
      result: { runtimeId: 'next-local', runId: 'run-1', sessionId },
    })
    runtime.dispose()
    guard.dispose()
  })

  it('blocks persisted Runwright Sessions until Core restores their policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runwright-host-recovery-'))
    roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    const sessionId = sessionIdForRun('run-1')
    new SessionLedger(ledgerPath).recordPromptIntent('run-1', sessionId)
    const guard = new ExecutionGuard()
    const host = {
      sessionController: { create: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), follow: vi.fn() },
      sessionQuery: { observeSession: vi.fn() },
    }
    const connection = { events: (async function* () {})(), publish: vi.fn(), respond: vi.fn() }
    const runtime = createHostRuntime(host, connection, guard, ledgerPath)

    await expect(guard.evaluate({
      name: 'fs/write',
      arguments: { path: 'src/a.ts' },
      agent: { session: { id: sessionId, header: { cwd: root } } },
    }, vi.fn())).resolves.toEqual({ kind: 'deny', reason: 'RECOVERY_POLICY_REQUIRED' })
    runtime.dispose()
    guard.dispose()
  })
})
