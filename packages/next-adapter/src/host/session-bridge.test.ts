import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartRunInput } from '@runwright/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionBridge, SessionBridgeError, requestIdForRun, sessionIdForRun } from './session-bridge.js'
import { SessionLedger } from './session-ledger.js'

interface FakeEvent {
  type: string
  data: unknown
}

interface FakeSession {
  cwd: string
  events: FakeEvent[]
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'runwright-session-bridge-'))
  roots.push(root)
  return join(root, 'ledger.json')
}

function input(runId = 'run-1'): StartRunInput {
  return {
    runId,
    project: { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-27T00:00:00Z' },
    prompt: 'implement the requirement',
    policy: { allowedTools: [], requireApprovalFor: [] },
  }
}

class FakeNext {
  readonly sessions = new Map<string, FakeSession>()
  readonly createCalls: Array<{ sessionId: string; cwd: string }> = []
  readonly promptCalls: Array<Record<string, unknown>> = []
  readonly cancelCalls: string[] = []
  activeObservations = 0
  disposedObservations = 0
  createError: Error | undefined
  promptGate: Promise<void> | undefined

  readonly sessionController = {
    create: async (request: { sessionId: string; cwd: string }) => {
      this.createCalls.push(request)
      if (!this.sessions.has(request.sessionId)) {
        this.sessions.set(request.sessionId, { cwd: request.cwd, events: [] })
      }
      if (this.createError) throw this.createError
      return { sessionId: request.sessionId }
    },
    prompt: async (request: Record<string, unknown>) => {
      this.promptCalls.push(request)
      await this.promptGate
      const session = this.sessions.get(request.sessionId as string)
      if (!session) throw new Error('missing fake session')
      session.events.push({
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: `message-${this.promptCalls.length}`, source: { kind: 'user', rpcId: request.requestId } }],
        },
      })
      return { accepted: true as const }
    },
    cancel: (request: { sessionId: string }) => {
      this.cancelCalls.push(request.sessionId)
    },
  }

  readonly sessionQuery = {
    observeSession: async (sessionId: string) => {
      const session = this.sessions.get(sessionId)
      if (!session) {
        throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      }
      this.activeObservations += 1
      let disposed = false
      return {
        header: { cwd: session.cwd },
        events: structuredClone(session.events),
        cursor: session.events.length - 1,
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          this.activeObservations -= 1
          this.disposedObservations += 1
        },
      }
    },
  }
}

function bridge(next: FakeNext, ledger: SessionLedger): SessionBridge {
  return new SessionBridge(next, { ledger, runtimeId: 'next-local' })
}

describe('SessionBridge', () => {
  it('creates one deterministic Session and prompt across repeated starts and ledger reopen', async () => {
    const path = await ledgerPath()
    const next = new FakeNext()
    const request = input()
    const first = await bridge(next, new SessionLedger(path)).start(request)
    const second = await bridge(next, new SessionLedger(path)).start(request)

    expect(second).toEqual(first)
    expect(first.sessionId).toBe(sessionIdForRun(request.runId))
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(next.createCalls).toHaveLength(1)
    expect(next.promptCalls).toHaveLength(1)
    expect(next.promptCalls[0]).toMatchObject({
      requestId: requestIdForRun(request.runId),
      sessionId: first.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: request.prompt }],
    })
    expect(next.disposedObservations).toBeGreaterThan(0)
    expect(next.activeObservations).toBe(0)
  })

  it('shares concurrent start work for one run and isolates different runs', async () => {
    const next = new FakeNext()
    const session = bridge(next, new SessionLedger(await ledgerPath()))
    let release!: () => void
    next.promptGate = new Promise<void>(resolve => { release = resolve })
    const first = session.start(input('run-a'))
    const duplicate = session.start(input('run-a'))
    const other = session.start(input('run-b'))
    release()
    const [a, repeated, b] = await Promise.all([first, duplicate, other])

    expect(repeated).toEqual(a)
    expect(b.sessionId).not.toBe(a.sessionId)
    expect(next.createCalls).toHaveLength(2)
    expect(next.promptCalls).toHaveLength(2)
    expect(next.promptCalls.filter(call => call.sessionId === a.sessionId)).toHaveLength(1)
  })

  it('safely retries a crash after create but before prompt intent', async () => {
    const next = new FakeNext()
    next.createError = new Error('simulated crash after create')
    const path = await ledgerPath()
    const request = input()
    await expect(bridge(next, new SessionLedger(path)).start(request)).rejects.toThrow('simulated crash')
    next.createError = undefined

    const ref = await bridge(next, new SessionLedger(path)).start(request)
    expect(next.createCalls).toHaveLength(1)
    expect(next.promptCalls).toHaveLength(1)
    expect(ref.sessionId).toBe(sessionIdForRun(request.runId))
  })

  it('recovers a prompt accepted before the ledger write without resubmitting', async () => {
    class CrashLedger extends SessionLedger {
      private fail = true
      override markAccepted(runId: string, cursor: number): void {
        if (this.fail) {
          this.fail = false
          throw new Error('simulated crash after prompt')
        }
        super.markAccepted(runId, cursor)
      }
    }

    const next = new FakeNext()
    const path = await ledgerPath()
    const request = input()
    await expect(bridge(next, new CrashLedger(path)).start(request)).rejects.toThrow('simulated crash after prompt')
    const ref = await bridge(next, new SessionLedger(path)).start(request)

    expect(ref.sessionId).toBe(sessionIdForRun(request.runId))
    expect(next.createCalls).toHaveLength(1)
    expect(next.promptCalls).toHaveLength(1)
  })

  it('recognizes a claimed prompt through user/message without resubmitting', async () => {
    const next = new FakeNext()
    const request = input()
    const sessionId = sessionIdForRun(request.runId)
    next.sessions.set(sessionId, { cwd: request.project.rootPath, events: [] })
    const ledger = new SessionLedger(await ledgerPath())
    ledger.recordPromptIntent(request.runId, sessionId)
    next.sessions.get(sessionId)!.events.push({
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: requestIdForRun(request.runId) } },
    })

    const ref = await bridge(next, ledger).start(request)
    expect(ref.sessionId).toBe(sessionId)
    expect(next.createCalls).toHaveLength(0)
    expect(next.promptCalls).toHaveLength(0)
  })

  it('rejects recovered evidence bound to a different project directory', async () => {
    const next = new FakeNext()
    const request = input()
    const sessionId = sessionIdForRun(request.runId)
    next.sessions.set(sessionId, {
      cwd: '/another-project',
      events: [{
        type: 'user/message',
        data: { source: { kind: 'user', rpcId: requestIdForRun(request.runId) } },
      }],
    })

    await expect(bridge(next, new SessionLedger(await ledgerPath())).start(request))
      .rejects.toMatchObject({ code: 'SESSION_CWD_MISMATCH' })
    expect(next.createCalls).toHaveLength(0)
    expect(next.promptCalls).toHaveLength(0)
  })

  it('fails closed when prompt intent has no durable rpcId evidence', async () => {
    const next = new FakeNext()
    const request = input()
    const sessionId = sessionIdForRun(request.runId)
    next.sessions.set(sessionId, { cwd: request.project.rootPath, events: [] })
    const ledger = new SessionLedger(await ledgerPath())
    ledger.recordPromptIntent(request.runId, sessionId)

    const attempt = bridge(next, ledger).start(request)
    await expect(attempt).rejects.toEqual(expect.objectContaining<Partial<SessionBridgeError>>({
      name: 'SessionBridgeError',
      code: 'SESSION_START_UNKNOWN',
    }))
    await expect(bridge(next, ledger).start(request)).rejects.toMatchObject({ code: 'SESSION_START_UNKNOWN' })
    expect(next.createCalls).toHaveLength(0)
    expect(next.promptCalls).toHaveLength(0)
    expect(next.activeObservations).toBe(0)
  })

  it('attaches and snapshots the original Session without create or prompt', async () => {
    const next = new FakeNext()
    const request = input()
    const path = await ledgerPath()
    const started = await bridge(next, new SessionLedger(path)).start(request)
    const session = bridge(next, new SessionLedger(path))
    const attached = await session.attach({ runId: request.runId, sessionId: started.sessionId })
    const snapshot = await session.snapshot(attached)

    expect(attached).toEqual(started)
    expect(snapshot.cursor).toBe(0)
    expect(snapshot.events).toHaveLength(1)
    expect(next.createCalls).toHaveLength(1)
    expect(next.promptCalls).toHaveLength(1)
    await expect(session.attach({ runId: request.runId, sessionId: 'another-session' }))
      .rejects.toMatchObject({ code: 'SESSION_ID_MISMATCH' })
    expect(next.activeObservations).toBe(0)
  })

  it('cancels only the identified Session', async () => {
    const next = new FakeNext()
    const request = input()
    const ref = await bridge(next, new SessionLedger(await ledgerPath())).start(request)
    await bridge(next, new SessionLedger(await ledgerPath())).cancel(ref)
    expect(next.cancelCalls).toEqual([ref.sessionId])
  })
})
