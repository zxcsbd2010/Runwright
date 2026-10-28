import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreResponse, StartRunInput, TaskDetail } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBridge, SessionLedger, sessionIdForRun } from '../../packages/next-adapter/src/index.js'
import { FakeNext, IntegrationHarness, once } from './helpers/fake-next.js'

const roots: string[] = []
const harnesses: IntegrationHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(): Promise<IntegrationHarness> {
  const value = await IntegrationHarness.create()
  harnesses.push(value)
  return value
}

function input(runId = 'run-crash'): StartRunInput {
  return {
    runId,
    project: { id: 'project-1', name: 'Project', rootPath: '/project', createdAt: '2026-10-27T00:00:00Z' },
    prompt: 'implement exactly once',
    policy: { allowedTools: [], requireApprovalFor: [] },
  }
}

const crashPoints = [
  'before-start-request',
  'after-start-request',
  'before-session-return',
  'after-prompt-before-ledger',
  'before-ledger',
] as const

describe('Core/NEXT crash matrix', () => {
  it.each(crashPoints)('recovers %s with one Session and one user message', async point => {
    const root = await mkdtemp(join(tmpdir(), 'runwright-crash-matrix-'))
    roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    const next = new FakeNext()
    class CrashLedger extends SessionLedger {
      private fail = true
      constructor(path: string) {
        super(path)
        if (point === 'before-start-request') throw new Error('crash before start request')
      }
      override recordPromptIntent(runId: string, sessionId: string): void {
        if (point === 'before-ledger' && this.fail) {
          this.fail = false
          throw new Error('crash before prompt intent ledger')
        }
        super.recordPromptIntent(runId, sessionId)
      }
      override markAccepted(runId: string, cursor: number): void {
        if (point === 'after-prompt-before-ledger' && this.fail) {
          this.fail = false
          throw new Error('crash after prompt before accepted ledger')
        }
        super.markAccepted(runId, cursor)
      }
    }
    if (point === 'after-start-request') next.beforeCreate = once(() => { throw new Error('crash in start request') })
    if (point === 'before-session-return') next.afterCreate = once(() => { throw new Error('crash before Session return') })

    if (point === 'before-start-request') {
      expect(() => new CrashLedger(ledgerPath)).toThrow('crash before start request')
      expect(next.createCalls).toHaveLength(0)
    } else {
      await expect(new SessionBridge(next, { ledger: new CrashLedger(ledgerPath) }).start(input())).rejects.toThrow()
    }
    const ref = await new SessionBridge(next, { ledger: new SessionLedger(ledgerPath) }).start(input())

    expect(ref.sessionId).toBe(sessionIdForRun(input().runId))
    expect(next.sessions.size).toBe(1)
    expect(next.userMessages()).toBe(1)
    expect(next.promptCalls).toHaveLength(1)
  })
})

async function startedRun(value: IntegrationHarness): Promise<{ detail: TaskDetail; sessionId: string }> {
  await value.startAdapter()
  const project = await value.registerProject()
  const created = await value.createTask(project.id)
  await value.dispatch(created.runs[0]!.id)
  await vi.waitFor(() => expect(value.next.promptCalls).toHaveLength(1))
  const detail = await value.detail(created.task.id)
  const sessionId = detail.runs[0]?.sessionId
  expect(sessionId).toBeDefined()
  return { detail, sessionId: sessionId! }
}

describe('Core/NEXT disconnect and restart matrix', () => {
  it.each(['event-produced', 'event-transport'] as const)('replays one event after %s disconnect', async point => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    if (point === 'event-produced') await value.stopAdapter()
    else value.connection?.dispose()
    value.next.emit(sessionId)
    if (point === 'event-transport') await value.stopAdapter()
    await value.startAdapter()

    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(1))
    expect(value.next.sessions.size).toBe(1)
    expect(value.next.userMessages()).toBe(1)
    expect((await value.detail(detail.task.id)).runs).toHaveLength(1)
  })

  it('deduplicates a committed event when its acknowledgement is lost', async () => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    const connection = value.connection as unknown as { resolveCall(response: CoreResponse): void }
    const resolveCall = connection.resolveCall.bind(value.connection)
    let dropAcknowledgement = true
    connection.resolveCall = response => {
      const result = 'result' in response ? response.result : undefined
      if (dropAcknowledgement && typeof result === 'object' && result !== null
        && 'seq' in result && result.seq === 1) {
        dropAcknowledgement = false
        value.crashAdapter()
        return
      }
      resolveCall(response)
    }
    value.next.emit(sessionId)
    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(1))
    await value.stopAdapter()

    await value.startAdapter()

    await vi.waitFor(() => expect(new SessionLedger(value.ledgerPath).get(detail.runs[0]!.id)?.lastSessionCursor).toBe(1))
    expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({ lastEventSeq: 1, status: 'running' })
    expect(new SessionLedger(value.ledgerPath).get(detail.runs[0]!.id)?.pendingPublication).toBeUndefined()
    expect(value.next.promptCalls).toHaveLength(1)
    expect(value.next.createCalls).toHaveLength(1)
  })

  it('does not repeat a cancellation whose request disconnected', async () => {
    const value = await harness()
    const { detail } = await startedRun(value)
    value.next.beforeCancel = once(() => {
      value.crashAdapter()
      throw new Error('transport lost before NEXT received cancellation')
    })

    await value.requireCore().orchestrator.cancel(detail.task.id)
    await value.stopAdapter()
    await value.startAdapter()

    expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({ status: 'attention', errorCode: 'CANCEL_UNKNOWN' })
    expect(value.next.cancelCalls).toHaveLength(0)
    expect(value.next.userMessages()).toBe(1)
  })

  it('keeps cancellation unknown when the response disconnects and never retries it', async () => {
    const value = await harness()
    const { detail } = await startedRun(value)
    value.next.afterCancel = once(() => {
      value.crashAdapter()
      throw new Error('NEXT crash before cancel response')
    })

    await value.requireCore().orchestrator.cancel(detail.task.id)
    await value.stopAdapter()
    await value.startAdapter()

    expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({ status: 'attention', errorCode: 'CANCEL_UNKNOWN' })
    expect(value.next.cancelCalls).toHaveLength(1)
    expect(value.next.userMessages()).toBe(1)
  })

  it.each(['core', 'next', 'interleaved'] as const)('resumes the same Run and Session after %s restart', async target => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    value.next.emit(sessionId)
    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(1))

    if (target === 'core') {
      await value.stopCore()
      await value.startCore()
    } else if (target === 'next') {
      await value.stopAdapter()
      await value.startAdapter()
    } else {
      value.crashAdapter()
      await value.stopCore()
      await value.stopAdapter()
      await value.startCore()
      await value.startAdapter()
    }
    if (target === 'core') await vi.waitFor(() => expect(value.connection?.start()).resolves.toBeUndefined())
    value.next.emit(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(2))
    const recovered = await value.detail(detail.task.id)
    expect(recovered.runs).toHaveLength(1)
    expect(recovered.runs[0]?.sessionId).toBe(sessionId)
    expect(value.next.sessions.size).toBe(1)
    expect(value.next.userMessages()).toBe(1)
  })
})

describe('Session and event recovery failures', () => {
  it('marks a missing Session unknown without creating a replacement or resending', async () => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    await value.stopAdapter()
    value.next.sessions.delete(sessionId)

    await value.startAdapter()

    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention', errorCode: 'ATTACH_UNKNOWN', sessionId,
    }))
    expect(value.next.sessions.size).toBe(0)
    expect(value.next.createCalls).toHaveLength(1)
    expect(value.next.promptCalls).toHaveLength(1)
  })

  it('fails closed on corrupt Session history instead of skipping a gap', async () => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    value.next.emit(sessionId)
    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(1))
    await value.stopAdapter()
    value.next.sessions.get(sessionId)!.events.push({ seq: 9, time: 1, type: 'turn/end', data: { turn: 1 } })

    await value.startAdapter()

    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention', errorCode: 'EVENT_GAP', sessionId,
    }), { timeout: 3_000 })
    expect(value.next.createCalls).toHaveLength(1)
    expect(value.next.promptCalls).toHaveLength(1)
  })

  it('rejects an occupied Session bound to another project', async () => {
    const value = await harness()
    await value.startAdapter()
    const project = await value.registerProject()
    const created = await value.createTask(project.id)
    const run = created.runs[0]!
    value.next.sessions.set(sessionIdForRun(run.id), { cwd: '/another-project', events: [] })

    await value.dispatch(run.id)

    expect((await value.detail(created.task.id)).runs[0]).toMatchObject({ status: 'attention', errorCode: 'START_UNKNOWN' })
    expect(value.next.sessions.size).toBe(1)
    expect(value.next.promptCalls).toHaveLength(0)
  })

  it('publishes attention for an unrecoverable live event gap without terminal success', async () => {
    const value = await harness()
    const { detail, sessionId } = await startedRun(value)
    value.next.emit(sessionId)
    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]?.lastEventSeq).toBe(1))
    const session = value.next.sessions.get(sessionId)!
    const event = { seq: 8, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    session.events.push(event)
    for (const channel of value.next.channels) channel.push(event)

    await vi.waitFor(async () => expect((await value.detail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention', errorCode: 'EVENT_STREAM_GAP', sessionId,
    }))
    expect((await value.detail(detail.task.id)).task.status).not.toBe('succeeded')
  })
})
