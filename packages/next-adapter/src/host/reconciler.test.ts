import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeEvent, RuntimeRunRef } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reconciler } from './reconciler.js'
import type { SessionFollowFrame, SessionFollowRequest } from './reconciler.js'
import type { DshSessionEvent } from './event-translator.js'
import { SessionLedger } from './session-ledger.js'

class Channel<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => { this.waiters.push(resolve) })
      },
    }
  }
}

class FakeNext {
  readonly requests: SessionFollowRequest[] = []
  readonly channels = new Set<Channel<DshSessionEvent>>()
  snapshot: Extract<SessionFollowFrame, { type: 'snapshot' }> = {
    type: 'snapshot',
    header: { version: 0, id: 'session-1', createdAt: 1, cwd: '/project' },
    cursor: -1,
    records: [],
    hasMore: false,
    projections: { asOfSeq: -1, values: {} },
  }
  followError: Error | undefined
  errorAfterSnapshot: Error | undefined

  readonly sessionController = {
    follow: (request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> => {
      this.requests.push(request)
      const channel = new Channel<DshSessionEvent>()
      this.channels.add(channel)
      signal.addEventListener('abort', () => channel.close(), { once: true })
      const snapshot = this.snapshot
      const followError = this.followError
      const errorAfterSnapshot = this.errorAfterSnapshot
      return (async function* (this: FakeNext): AsyncGenerator<SessionFollowFrame> {
        if (followError) throw followError
        yield snapshot
        if (errorAfterSnapshot) throw errorAfterSnapshot
        try {
          for await (const event of channel) yield { type: 'event', event }
        } finally {
          this.channels.delete(channel)
        }
      }).call(this)
    },
  }

  emit(event: DshSessionEvent): void {
    for (const channel of this.channels) channel.push(event)
  }
}

const roots: string[] = []
const reconcilers: Reconciler[] = []

afterEach(async () => {
  for (const reconciler of reconcilers.splice(0)) reconciler.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'runwright-reconciler-'))
  roots.push(root)
  return join(root, 'ledger.json')
}

function ref(runId = 'run-1', sessionId = 'session-1'): RuntimeRunRef {
  return { runtimeId: 'next-local', runId, sessionId }
}

function event(seq: number, type = 'turn/start', data: unknown = { turn: 1 }): DshSessionEvent {
  return { seq, time: 1_792_000_000_000, type, data }
}

function snapshot(records: DshSessionEvent[], hasMore = false): FakeNext['snapshot'] {
  return {
    type: 'snapshot',
    header: { version: 0, id: 'session-1', createdAt: 1, cwd: '/project' },
    cursor: records.at(-1)?.seq ?? -1,
    records: records.map(item => ({ type: 'event', event: item })),
    hasMore,
    projections: { asOfSeq: records.at(-1)?.seq ?? -1, values: {} },
  }
}

function setup(next: FakeNext, ledger: SessionLedger, published: Array<{ runId: string; event: RuntimeEvent }>): Reconciler {
  const reconciler = new Reconciler(next, {
    ledger,
    publish: (runRef, event) => { published.push({ runId: runRef.runId, event }) },
  })
  reconcilers.push(reconciler)
  return reconciler
}

describe('Reconciler', () => {
  it('does not finish attach before the initial Session snapshot is received', async () => {
    const next = new FakeNext()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    next.sessionController.follow = () => (async function* (): AsyncGenerator<SessionFollowFrame> {
      await gate
      yield snapshot([])
    })()
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(await ledgerPath()), published)

    const attaching = reconciler.attach(ref(), 0)
    await expect(Promise.race([
      attaching.then(() => 'attached'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ])).resolves.toBe('pending')
    release()
    await attaching
  })

  it('uses the real follow address, shares duplicate attach, and emits contiguous events', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([
      event(0),
      event(1, 'approval/asked', { id: 'approval-1', toolName: 'shell' }),
    ])
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(await ledgerPath()), published)

    await reconciler.attach(ref(), 0)
    await reconciler.attach(ref(), 0)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    next.emit(event(2, 'approval/decided', { id: 'approval-1', outcome: 'allowed-once' }))
    await vi.waitFor(() => expect(published).toHaveLength(3))

    expect(next.requests).toEqual([{ address: { kind: 'session', sessionId: 'session-1' } }])
    expect(published.map(item => item.event)).toEqual([
      { seq: 1, type: 'run.started' },
      { seq: 2, type: 'approval.requested', approvalId: 'approval-1' },
      { seq: 3, type: 'approval.resolved', approvalId: 'approval-1' },
    ])
  })

  it('deduplicates a replayed snapshot after restart and resumes Core sequence numbers', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([event(0), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })])
    const path = await ledgerPath()
    const ledger = new SessionLedger(path)
    ledger.recordPromptIntent('run-1', 'session-1')
    const firstPublished: Array<{ runId: string; event: RuntimeEvent }> = []
    const first = setup(next, ledger, firstPublished)
    await first.attach(ref(), 0)
    await vi.waitFor(() => expect(firstPublished).toHaveLength(2))
    expect(new SessionLedger(path).get('run-1')?.lastSessionCursor).toBe(1)
    first.dispose()

    const resumedPublished: Array<{ runId: string; event: RuntimeEvent }> = []
    const resumed = setup(next, new SessionLedger(path), resumedPublished)
    await resumed.attach(ref(), 2)
    next.emit(event(2))
    await vi.waitFor(() => expect(resumedPublished).toHaveLength(1))
    expect(resumedPublished[0]?.event).toEqual({ seq: 3, type: 'run.started' })
  })

  it('numbers two Runs independently', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([event(0)])
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(await ledgerPath()), published)

    await reconciler.attach(ref('run-a', 'session-a'), 0)
    await reconciler.attach(ref('run-b', 'session-b'), 0)
    await vi.waitFor(() => expect(published).toHaveLength(2))
    expect(published).toEqual([
      { runId: 'run-a', event: { seq: 1, type: 'run.started' } },
      { runId: 'run-b', event: { seq: 1, type: 'run.started' } },
    ])
  })

  it('fails closed on a truncated snapshot instead of skipping missing history', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], true)
    const path = await ledgerPath()
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(path), published)

    await reconciler.attach(ref(), 0)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published[0]?.event).toEqual({ seq: 1, type: 'run.attention', reason: 'EVENT_GAP' })
    expect(new SessionLedger(path).get('run-1')?.lastSessionCursor ?? -1).toBe(-1)
  })

  it('maps a missing Session to attention without creating a replacement', async () => {
    const next = new FakeNext()
    next.followError = Object.assign(new Error('missing'), { code: 'session-not-found' })
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(await ledgerPath()), published)

    await reconciler.attach(ref(), 0)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published[0]?.event).toEqual({ seq: 1, type: 'run.attention', reason: 'SESSION_NOT_FOUND' })
    expect(next.requests).toHaveLength(1)
  })

  it('maps an unrecoverable live follow gap to attention', async () => {
    const next = new FakeNext()
    next.errorAfterSnapshot = Object.assign(new Error('session event stream skipped seq 1'), { code: 'internal' })
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    const reconciler = setup(next, new SessionLedger(await ledgerPath()), published)

    await reconciler.attach(ref(), 0)
    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(published[0]?.event).toEqual({ seq: 1, type: 'run.attention', reason: 'EVENT_STREAM_GAP' })
  })

  it('reuses the Core sequence when a committed event acknowledgement is lost', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([event(0)])
    const path = await ledgerPath()
    const ledger = new SessionLedger(path)
    ledger.recordPromptIntent('run-1', 'session-1')
    const published: RuntimeEvent[] = []
    let disconnect = true
    const reconciler = new Reconciler(next, {
      ledger,
      publish: (_ref, event) => {
        published.push(event)
        if (disconnect) throw new Error('CORE_DISCONNECTED')
      },
    })
    reconcilers.push(reconciler)
    await reconciler.attach(ref(), 0)
    reconciler.dispose()

    disconnect = false
    expect(new SessionLedger(path).get('run-1')?.pendingPublication).toEqual({ coreSeq: 1, sessionCursor: 0 })
    const resumed = new Reconciler(next, {
      ledger: new SessionLedger(path),
      publish: (_ref, event) => { published.push(event) },
    })
    reconcilers.push(resumed)
    await resumed.attach(ref(), 1)
    await vi.waitFor(() => expect(published).toHaveLength(2))

    expect(published).toEqual([{ seq: 1, type: 'run.started' }, { seq: 1, type: 'run.started' }])
  })

  it('does not assign a pending attention sequence to a normal event', async () => {
    const next = new FakeNext()
    next.followError = Object.assign(new Error('missing'), { code: 'session-not-found' })
    const path = await ledgerPath()
    const ledger = new SessionLedger(path)
    ledger.recordPromptIntent('run-1', 'session-1')
    const published: RuntimeEvent[] = []
    let disconnect = true
    const reconciler = new Reconciler(next, {
      ledger,
      publish: (_ref, event) => {
        published.push(event)
        if (disconnect) throw new Error('CORE_DISCONNECTED')
      },
    })
    reconcilers.push(reconciler)
    await reconciler.attach(ref(), 0)
    reconciler.dispose()

    disconnect = false
    next.followError = undefined
    next.snapshot = snapshot([event(0)])
    const resumed = new Reconciler(next, {
      ledger: new SessionLedger(path),
      publish: (_ref, event) => { published.push(event) },
    })
    reconcilers.push(resumed)
    await resumed.attach(ref(), 1)
    await vi.waitFor(() => expect(published).toHaveLength(2))

    expect(published).toEqual([
      { seq: 1, type: 'run.attention', reason: 'SESSION_NOT_FOUND' },
      { seq: 2, type: 'run.started' },
    ])
  })

  it('allows Core recovery to replay an event whose publication disconnected', async () => {
    const next = new FakeNext()
    next.snapshot = snapshot([event(0)])
    const path = await ledgerPath()
    const ledger = new SessionLedger(path)
    ledger.recordPromptIntent('run-1', 'session-1')
    const published: Array<{ runId: string; event: RuntimeEvent }> = []
    let disconnected = true
    const reconciler = new Reconciler(next, {
      ledger,
      publish: (runRef, event) => {
        if (disconnected) throw new Error('CORE_DISCONNECTED')
        published.push({ runId: runRef.runId, event })
      },
    })
    reconcilers.push(reconciler)

    await reconciler.attach(ref(), 0)
    await vi.waitFor(() => expect(next.requests).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    disconnected = false
    await reconciler.attach(ref(), 0)

    await vi.waitFor(() => expect(published).toHaveLength(1))
    expect(next.requests).toHaveLength(2)
    expect(published[0]?.event).toEqual({ seq: 1, type: 'run.started' })
  })
})
