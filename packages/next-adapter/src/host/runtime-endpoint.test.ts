import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeEvent, RuntimeRunRef, StartRunInput } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshSessionEvent } from './event-translator.js'
import { ExecutionGuard } from './execution-guard.js'
import type { PreToolDecision } from './execution-guard.js'
import { Reconciler } from './reconciler.js'
import type { SessionFollowFrame, SessionFollowRequest } from './reconciler.js'
import { RuntimeEndpoint } from './runtime-endpoint.js'
import { SessionBridge, sessionIdForRun } from './session-bridge.js'
import { SessionLedger } from './session-ledger.js'

interface FakeSession {
  cwd: string
  events: DshSessionEvent[]
}

class FakeNext {
  readonly sessions = new Map<string, FakeSession>()
  readonly followRequests: SessionFollowRequest[] = []
  readonly promptCalls: unknown[] = []
  cancelError: Error | undefined
  beforePrompt: (() => void | Promise<void>) | undefined
  beforeObserve: (() => void | Promise<void>) | undefined

  readonly sessionController = {
    create: async (request: { sessionId: string; cwd: string }) => {
      this.sessions.set(request.sessionId, { cwd: request.cwd, events: [] })
      return { sessionId: request.sessionId }
    },
    prompt: async (request: { sessionId: string; requestId: string }) => {
      this.promptCalls.push(request)
      await this.beforePrompt?.()
      const session = this.sessions.get(request.sessionId)!
      session.events.push({
        seq: session.events.length,
        time: 1,
        type: 'agent/inbox/spliced',
        data: { inserted: [{ source: { kind: 'user', rpcId: request.requestId } }] },
      })
      return { accepted: true as const }
    },
    cancel: async () => {
      if (this.cancelError) throw this.cancelError
    },
    follow: (request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> => {
      this.followRequests.push(request)
      const session = this.sessions.get(request.address.sessionId)
      return (async function* (): AsyncGenerator<SessionFollowFrame> {
        if (!session) throw Object.assign(new Error('missing'), { code: 'session-not-found' })
        yield {
          type: 'snapshot',
          header: { version: 0, id: request.address.sessionId, createdAt: 1, cwd: session.cwd },
          cursor: session.events.at(-1)?.seq ?? -1,
          records: session.events.map(event => ({ type: 'event', event })),
          hasMore: false,
          projections: { asOfSeq: session.events.at(-1)?.seq ?? -1, values: {} },
        }
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    },
  }

  readonly sessionQuery = {
    observeSession: async (sessionId: string) => {
      await this.beforeObserve?.()
      const session = this.sessions.get(sessionId)
      if (!session) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return {
        header: { cwd: session.cwd },
        events: structuredClone(session.events),
        cursor: session.events.at(-1)?.seq ?? -1,
        [Symbol.dispose]: () => {},
      }
    },
  }
}

const roots: string[] = []
const reconcilers: Reconciler[] = []

afterEach(async () => {
  for (const reconciler of reconcilers.splice(0)) reconciler.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function input(runId = 'run-1'): StartRunInput {
  return {
    runId,
    project: { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-27T00:00:00Z' },
    prompt: 'implement the requirement',
    policy: { allowedTools: [], requireApprovalFor: [] },
  }
}

function event(seq: number, type: string, data: unknown): DshSessionEvent {
  return { seq, time: 1, type, data }
}

async function setup(
  next: FakeNext,
  runId = 'run-1',
  guard?: Pick<ExecutionGuard, 'register' | 'block'>,
) {
  const root = await mkdtemp(join(tmpdir(), 'runwright-runtime-endpoint-'))
  roots.push(root)
  const ledger = new SessionLedger(join(root, 'ledger.json'))
  const bridge = new SessionBridge(next, { ledger })
  const published: Array<{ ref: RuntimeRunRef; event: RuntimeEvent }> = []
  const reconciler = new Reconciler(next, {
    ledger,
    publish: (ref, event) => { published.push({ ref, event }) },
  })
  reconcilers.push(reconciler)
  return {
    endpoint: new RuntimeEndpoint(bridge, reconciler, guard),
    ledger,
    published,
    ref: { runtimeId: 'next-local', runId, sessionId: sessionIdForRun(runId) },
  }
}

describe('RuntimeEndpoint', () => {
  it('enforces the Core policy before the first prompt can execute tools', async () => {
    const next = new FakeNext()
    const guard = new ExecutionGuard()
    let listener!: ExecutionGuard['evaluate']
    guard.install({
      on: (_event, registered) => {
        listener = registered
        return () => {}
      },
    })
    const { endpoint } = await setup(next, 'run-1', guard)
    let decision: PreToolDecision | undefined
    next.beforePrompt = async () => {
      decision = await listener({
        name: 'shell',
        arguments: { command: 'git commit -m fixture' },
        agent: { session: { id: sessionIdForRun('run-1'), header: { cwd: '/project' } } },
      }, async () => ({ kind: 'allow' }))
    }

    await endpoint.startRun(input())

    expect(decision).toEqual({ kind: 'deny', reason: 'commit' })
    guard.dispose()
  })

  it('registers the Core policy only after the Runwright Session starts', async () => {
    const next = new FakeNext()
    const guard = { register: vi.fn(), block: vi.fn() }
    const { endpoint } = await setup(next, 'run-1', guard)
    const request = input()

    const ref = await endpoint.startRun(request)

    expect(guard.register).toHaveBeenCalledWith({
      sessionId: ref.sessionId,
      rootPath: request.project.rootPath,
      policy: request.policy,
    })
  })

  it('restores the Core policy before attaching an existing Runwright Session', async () => {
    const next = new FakeNext()
    const guard = new ExecutionGuard()
    const { endpoint, ref } = await setup(next, 'run-1', guard)
    next.sessions.set(ref.sessionId, { cwd: '/project', events: [] })
    const request = input()

    await endpoint.attachRun({
      runId: ref.runId,
      sessionId: ref.sessionId,
      project: request.project,
      policy: request.policy,
    })

    await expect(guard.evaluate({
      name: 'shell',
      arguments: { command: 'git commit -m fixture' },
      agent: { session: { id: ref.sessionId, header: { cwd: '/project' } } },
    }, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'deny', reason: 'commit' })
    guard.dispose()
  })

  it('blocks recovery execution before attach validation and after attach failure', async () => {
    const next = new FakeNext()
    const guard = new ExecutionGuard()
    const { endpoint, ref } = await setup(next, 'run-1', guard)
    next.sessions.set(ref.sessionId, { cwd: '/project', events: [] })
    const request = input()
    const attach = {
      runId: ref.runId,
      sessionId: ref.sessionId,
      project: request.project,
      policy: request.policy,
    }
    let duringAttach: PreToolDecision | undefined
    next.beforeObserve = async () => {
      duringAttach = await guard.evaluate({
        name: 'shell',
        arguments: { command: 'git commit -m fixture' },
        agent: { session: { id: ref.sessionId, header: { cwd: '/project' } } },
      }, async () => ({ kind: 'allow' }))
    }

    await endpoint.attachRun(attach)
    expect(duringAttach).toEqual({ kind: 'deny', reason: 'RECOVERY_POLICY_REQUIRED' })

    await expect(endpoint.attachRun({ ...attach, runId: 'missing', sessionId: 'missing-session' })).rejects.toThrow()
    await expect(guard.evaluate({
      name: 'shell',
      arguments: { command: 'pnpm test' },
      agent: { session: { id: 'missing-session', header: { cwd: '/project' } } },
    }, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'deny', reason: 'RECOVERY_POLICY_REQUIRED' })
    guard.dispose()
  })

  it('starts and attaches through the same bridge without a duplicate prompt or follower', async () => {
    const next = new FakeNext()
    const { endpoint } = await setup(next)

    const started = await endpoint.startRun(input())
    const repeated = await endpoint.startRun(input())
    await endpoint.attachRun({ runId: 'run-1', sessionId: started.sessionId, afterSeq: 0 })

    expect(repeated).toEqual(started)
    expect(next.promptCalls).toHaveLength(1)
    expect(next.followRequests).toHaveLength(1)
  })

  it('keeps snapshots read-only and replays their events to subscribers on attach', async () => {
    const next = new FakeNext()
    const { endpoint, ledger, ref, published } = await setup(next)
    ledger.recordPromptIntent(ref.runId, ref.sessionId)
    next.sessions.set(ref.sessionId, {
      cwd: '/project',
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ],
    })

    expect(await endpoint.getRunSnapshot(ref)).toEqual({
      ref,
      status: 'succeeded',
      events: [
        { seq: 1, type: 'run.started' },
        { seq: 2, type: 'run.succeeded', summary: 'Run completed' },
      ],
    })
    expect(ledger.get(ref.runId)?.lastSessionCursor).toBe(-1)
    const iterator = endpoint.subscribe(ref)[Symbol.asyncIterator]()
    const first = iterator.next()
    await endpoint.attachRun({ runId: ref.runId, sessionId: ref.sessionId, afterSeq: 0 })

    await expect(first).resolves.toEqual({
      done: false,
      value: { seq: 1, type: 'run.started' },
    })
    await vi.waitFor(() => expect(published).toHaveLength(2))
  })

  it('does not invent a cancelled outcome when cancellation transport fails', async () => {
    const next = new FakeNext()
    next.cancelError = new Error('secret transport detail')
    const { endpoint, ref, published } = await setup(next)

    await expect(endpoint.cancelRun(ref)).rejects.toThrow('secret transport detail')
    expect(await endpoint.handle({ id: 'cancel-1', method: 'runtime.cancel', params: ref })).toEqual({
      id: 'cancel-1',
      error: { code: 'CANCEL_UNKNOWN', message: 'Cancellation outcome unknown' },
    })
    expect(published).toEqual([])
  })
})
