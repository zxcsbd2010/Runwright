import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, RuntimeHello, TaskDetail } from '@runwright/contracts'
import { openDatabase } from './database.js'
import { FakeRuntime } from './fake-runtime.js'
import { Orchestrator } from './orchestrator.js'
import { RuntimeRegistry } from './runtime-registry.js'
import { CoreStore } from './store.js'

const capabilities = [
  'session.start',
  'session.attach',
  'session.cancel',
  'approval.forward',
  'validation.summary',
]

function hello(overrides: Partial<RuntimeHello> = {}): RuntimeHello {
  return {
    protocolMajor: 1,
    adapterVersion: '0.1.0',
    runtimeId: 'next-local',
    runtimeKind: 'next',
    dshVersion: '0.2.1-rc.3',
    nextVersion: '2.0.20-next',
    capabilities: [...capabilities],
    ...overrides,
  }
}

let db: ReturnType<typeof openDatabase>
let store: CoreStore
let project: Project
let runtime: FakeRuntime
let registry: RuntimeRegistry
let orchestrator: Orchestrator

beforeEach(async () => {
  db = openDatabase(':memory:')
  store = new CoreStore(db)
  project = await store.registerProject({ name: 'Example', rootPath: '/tmp/example' })
  runtime = new FakeRuntime()
  registry = new RuntimeRegistry(runtime)
  orchestrator = new Orchestrator(store, registry)
})

afterEach(() => {
  runtime.closeAll()
  db.close()
})

async function createTask(prompt = 'add parser'): Promise<TaskDetail> {
  return store.createTask({ projectId: project.id, prompt })
}

describe('RuntimeRegistry', () => {
  it('accepts only protocol one with every required capability', () => {
    expect(registry.accept(hello())).toBe(true)
    expect(registry.accept(hello({ protocolMajor: 2 } as unknown as RuntimeHello))).toBe(false)
    expect(registry.accept(hello({ capabilities: capabilities.slice(1) }))).toBe(false)
  })
})

describe('Orchestrator', () => {
  it('leaves queued work unchanged while the runtime is unavailable', async () => {
    const detail = await createTask()
    await orchestrator.dispatch(detail.runs[0]!.id)

    expect(runtime.startCalls).toHaveLength(0)
    expect((await store.getDetail(detail.task.id)).runs[0]).toMatchObject({ status: 'queued' })
  })

  it('persists dispatch before start and deduplicates concurrent starts', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    let release: () => void = () => {}
    runtime.startGate = new Promise<void>((resolve) => { release = resolve })
    let dispatchRequestedAtStart = 0
    runtime.onStart = () => {
      dispatchRequestedAtStart = (db.prepare(
        'SELECT dispatch_requested FROM runs WHERE id = ?',
      ).get(run.id) as { dispatch_requested: number }).dispatch_requested
    }
    runtime.onSubscribe = () => {
      expect(db.prepare('SELECT runtime_id, session_id FROM runs WHERE id = ?').get(run.id)).toEqual({
        runtime_id: 'next-local',
        session_id: `session-${run.id}`,
      })
    }

    const first = orchestrator.dispatch(run.id)
    const second = orchestrator.dispatch(run.id)
    await vi.waitFor(() => expect(runtime.startCalls).toHaveLength(1))
    release()
    await Promise.all([first, second])

    expect(dispatchRequestedAtStart).toBe(1)
    expect(runtime.startCalls.map((call) => call.runId)).toEqual([run.id])
    expect(runtime.subscribeCalls).toHaveLength(1)
  })

  it('claims dispatch atomically across Core processes sharing one database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runwright-dispatch-'))
    const path = join(directory, 'core.db')
    const firstDb = openDatabase(path)
    const secondDb = openDatabase(path)
    try {
      const firstStore = new CoreStore(firstDb)
      const secondStore = new CoreStore(secondDb)
      const sharedProject = await firstStore.registerProject({ name: 'Example', rootPath: '/tmp/example' })
      const detail = await firstStore.createTask({ projectId: sharedProject.id, prompt: 'add parser' })
      const first = new Orchestrator(firstStore, registry)
      const second = new Orchestrator(secondStore, registry)
      registry.accept(hello())

      await Promise.all([
        first.dispatch(detail.runs[0]!.id),
        second.dispatch(detail.runs[0]!.id),
      ])

      expect(runtime.startCalls).toHaveLength(1)
      expect(runtime.subscribeCalls).toHaveLength(1)
    } finally {
      firstDb.close()
      secondDb.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers unfinished starts with the same run and only attaches existing sessions', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.recordDispatch(run.id)

    await orchestrator.recover()
    expect(runtime.startCalls.map((call) => call.runId)).toEqual([run.id])
    expect(runtime.attachCalls).toHaveLength(0)

    await orchestrator.recover()
    expect(runtime.startCalls).toHaveLength(1)
    expect(runtime.attachCalls.map((call) => call.runId)).toEqual([run.id])
    expect((await store.getDetail(detail.task.id)).runs).toHaveLength(1)
  })

  it('pauses new dispatch until recovery completes', async () => {
    registry.accept(hello())
    const first = await createTask('first')
    await store.recordDispatch(first.runs[0]!.id)
    let release: () => void = () => {}
    runtime.startGate = new Promise<void>((resolve) => { release = resolve })

    const recovering = orchestrator.recover()
    await vi.waitFor(() => expect(runtime.startCalls).toHaveLength(1))
    const second = await createTask('second')
    await orchestrator.dispatch(second.runs[0]!.id)
    release()
    await recovering

    expect(runtime.startCalls.map((call) => call.runId)).toEqual([first.runs[0]!.id])
    expect((await store.getDetail(second.task.id)).runs[0]?.status).toBe('queued')
    await orchestrator.dispatch(second.runs[0]!.id)
    expect(runtime.startCalls).toHaveLength(2)
  })

  it('preserves waiting approval when recovering an existing session', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.attachRuntime(run.id, 'next-local', 'session-1')
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'approval.requested', approvalId: 'approval-1' })

    await orchestrator.recover()

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('waiting_approval')
    expect(updated.runs[0]).toMatchObject({ status: 'waiting_approval', sessionId: 'session-1' })
    expect(runtime.startCalls).toHaveLength(0)
    expect(runtime.attachCalls.map((call) => call.runId)).toEqual([run.id])
  })

  it.each([
    {
      name: 'run',
      ref: { runtimeId: 'next-local', runId: 'other-run', sessionId: 'session-1' },
      errorCode: 'RUN_ID_MISMATCH',
    },
    {
      name: 'session',
      ref: { runtimeId: 'next-local', runId: '', sessionId: 'session-2' },
      errorCode: 'SESSION_MISMATCH',
    },
  ])('rejects a mismatched attach $name without replacing the existing session', async ({ ref, errorCode }) => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.attachRuntime(run.id, 'next-local', 'session-1')
    runtime.attachResult = { ...ref, runId: ref.runId || run.id }

    await orchestrator.recover()

    expect((await store.getDetail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention',
      errorCode,
      sessionId: 'session-1',
    })
    expect(runtime.subscribeCalls).toHaveLength(0)
  })

  it('does not turn runtime disconnection into run failure', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.attachRuntime(run.id, 'next-local', 'session-1')

    expect(registry.accept(hello({ capabilities: [] }))).toBe(false)
    await orchestrator.recover()

    expect((await store.getDetail(detail.task.id)).runs[0]).toMatchObject({
      status: 'running',
      sessionId: 'session-1',
    })
    expect(runtime.startCalls).toHaveLength(0)
  })

  it('leaves untouched queued work unchanged if runtime compatibility is lost during recovery', async () => {
    registry.accept(hello())
    const first = await createTask('first')
    const second = await createTask('second')
    runtime.onStart = () => {
      registry.accept(hello({ capabilities: [] }))
    }

    await orchestrator.recover()

    expect(runtime.startCalls).toHaveLength(1)
    const pending = runtime.startCalls[0]!.runId === first.runs[0]!.id ? second : first
    expect((await store.getDetail(pending.task.id)).runs[0]?.status).toBe('queued')
    expect((await store.getRunContext(pending.runs[0]!.id)).dispatchRequested).toBe(false)
  })

  it('marks unknown cancellation as attention without retrying or replacing the session', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await orchestrator.dispatch(run.id)
    const sessionId = (await store.getDetail(detail.task.id)).runs[0]?.sessionId
    runtime.cancelError = new Error('disconnect')

    await orchestrator.cancel(detail.task.id)

    const updated = await store.getDetail(detail.task.id)
    expect(updated.runs).toHaveLength(1)
    expect(updated.runs[0]).toMatchObject({
      status: 'attention',
      errorCode: 'CANCEL_UNKNOWN',
      sessionId,
    })
    expect(runtime.startCalls).toHaveLength(1)
  })

  it('reattaches an unknown cancellation to reconcile its outcome without cancelling again', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await orchestrator.dispatch(run.id)
    runtime.cancelError = new Error('disconnect')
    await orchestrator.cancel(detail.task.id)

    await orchestrator.recover()

    expect(runtime.attachCalls.map(call => call.runId)).toEqual([run.id])
    expect(runtime.cancelCalls).toHaveLength(1)
    expect(runtime.startCalls).toHaveLength(1)
  })

  it('resumes a claimed start when cancellation became unknown before a Session was saved', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.recordDispatch(run.id)
    await store.requestCancel(detail.task.id)
    await store.markAttention(run.id, 'CANCEL_UNKNOWN')

    await orchestrator.recover()

    expect(runtime.startCalls.map(call => call.runId)).toEqual([run.id])
    expect(runtime.cancelCalls).toHaveLength(0)
    expect((await store.getRunContext(run.id)).run.sessionId).toBe(`session-${run.id}`)
  })

  it('keeps unknown cancellation attention when an in-flight start finishes', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    let release: () => void = () => {}
    runtime.startGate = new Promise<void>((resolve) => { release = resolve })
    const dispatching = orchestrator.dispatch(run.id)
    await vi.waitFor(() => expect(runtime.startCalls).toHaveLength(1))

    await orchestrator.cancel(detail.task.id)
    release()
    await dispatching

    expect((await store.getDetail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention',
      errorCode: 'CANCEL_UNKNOWN',
      sessionId: `session-${run.id}`,
    })
    expect(runtime.startCalls).toHaveLength(1)
  })

  it('restores event subscriptions only after runtime association', async () => {
    registry.accept(hello())
    const detail = await createTask()
    const run = detail.runs[0]!
    await orchestrator.dispatch(run.id)

    expect(runtime.operations.indexOf(`subscribe:${run.id}`)).toBeGreaterThan(
      runtime.operations.indexOf(`start:${run.id}`),
    )
    runtime.emit(run.id, { seq: 1, type: 'run.succeeded', summary: 'done' })
    await vi.waitFor(async () => {
      expect((await store.getDetail(detail.task.id)).runs[0]?.status).toBe('succeeded')
    })
  })
})
