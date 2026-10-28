import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, TaskDetail } from '@runwright/contracts'
import { openDatabase } from './database.js'
import { CoreStore } from './store.js'

let db: ReturnType<typeof openDatabase>
let store: CoreStore
let project: Project

beforeEach(async () => {
  db = openDatabase(':memory:')
  store = new CoreStore(db)
  project = await store.registerProject({ name: 'Example', rootPath: '/tmp/example' })
})

afterEach(() => {
  db.close()
})

async function createTask(prompt = 'add parser'): Promise<TaskDetail> {
  return store.createTask({ projectId: project.id, prompt })
}

describe('projects and snapshots', () => {
  it('registers and lists projects without storing paths in audit payloads', async () => {
    expect(await store.listProjects()).toEqual([project])
    expect((await store.snapshot()).projects).toEqual([project])
    const audits = db.prepare('SELECT payload_json FROM audits').all() as Array<{ payload_json: string }>
    expect(JSON.stringify(audits)).not.toContain(project.rootPath)
    expect(JSON.stringify(audits)).not.toContain(project.name)
  })
})

describe('task and run lifecycle', () => {
  it('creates a task with attempt one and filters tasks', async () => {
    const detail = await createTask()
    expect(detail.task.status).toBe('queued')
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]).toMatchObject({ attempt: 1, status: 'queued', lastEventSeq: 0 })
    expect(await store.listTasks({ projectId: project.id, status: 'queued' })).toEqual([detail.task])
    expect((await store.snapshot()).tasks).toEqual([detail.task])
  })

  it('rejects retry while a run is active', async () => {
    const detail = await createTask()
    await expect(store.retry(detail.task.id)).rejects.toThrow('RUN_STILL_ACTIVE')
    expect((await store.getDetail(detail.task.id)).runs).toHaveLength(1)
  })

  it('creates attempt two after failure and preserves run history', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.recordDispatch(run.id)
    await store.attachRuntime(run.id, 'next-local', 'session-1')
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })

    const retry = await store.retry(detail.task.id)
    expect(retry).toMatchObject({ attempt: 2, status: 'queued' })
    expect(retry.id).not.toBe(run.id)
    const updated = await store.getDetail(detail.task.id)
    expect(updated.runs).toHaveLength(2)
    expect(updated.runs[0]).toMatchObject({ id: run.id, status: 'failed', sessionId: 'session-1' })
    expect(updated.task.activeRunId).toBe(retry.id)
  })

  it('records dispatch and runtime association without auditing the prompt', async () => {
    const detail = await createTask('a confidential requirement')
    const run = detail.runs[0]!
    await store.recordDispatch(run.id)
    await store.attachRuntime(run.id, 'next-local', 'session-1')

    const attached = (await store.getDetail(detail.task.id)).runs[0]!
    expect(attached).toMatchObject({ runtimeId: 'next-local', sessionId: 'session-1', status: 'running' })
    const audits = db.prepare('SELECT payload_json FROM audits').all() as Array<{ payload_json: string }>
    expect(JSON.stringify(audits)).not.toContain('a confidential requirement')
  })

  it('marks cancellation as requested without pretending it completed', async () => {
    const detail = await createTask()
    await store.requestCancel(detail.task.id)
    const run = db.prepare('SELECT cancel_requested, status FROM runs').get() as { cancel_requested: number; status: string }
    expect(run).toEqual({ cancel_requested: 1, status: 'queued' })
    await expect(store.retry(detail.task.id)).rejects.toThrow('RUN_STILL_ACTIVE')
  })

  it('marks uncertain runs as attention and preserves the original association', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.attachRuntime(run.id, 'next-local', 'session-1')
    await store.markAttention(run.id, 'SESSION_UNKNOWN')
    expect((await store.getDetail(detail.task.id)).runs[0]).toMatchObject({
      status: 'attention',
      errorCode: 'SESSION_UNKNOWN',
      sessionId: 'session-1',
    })
    await expect(store.retry(detail.task.id)).rejects.toThrow('RUN_STILL_ACTIVE')
  })
})

describe('event transactions', () => {
  it('applies continuous events and ignores duplicates', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    expect(await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.started' })).toBe('applied')
    expect(await store.applyRuntimeEvent(run.id, { seq: 2, type: 'validation.completed', summary: '2 tests passed' })).toBe('applied')
    expect(await store.applyRuntimeEvent(run.id, { seq: 2, type: 'validation.completed', summary: 'duplicate' })).toBe('duplicate')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.runs[0]).toMatchObject({ status: 'running', lastEventSeq: 2 })
    expect(updated.validationSummary).toBe('2 tests passed')
  })

  it('rolls back run, task, cursor, and audit when audit insertion fails', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    const auditsBefore = db.prepare('SELECT COUNT(*) AS count FROM audits').get() as { count: number }
    db.exec(`CREATE TRIGGER fail_runtime_audit BEFORE INSERT ON audits WHEN NEW.kind = 'runtime.event'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`)

    await expect(store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.succeeded', summary: 'done' })).rejects.toThrow('forced audit failure')
    const persisted = db.prepare('SELECT status, last_event_seq FROM runs').get()
    expect(persisted).toEqual({ status: 'queued', last_event_seq: 0 })
    expect((await store.getDetail(detail.task.id)).task.status).toBe('queued')
    expect(db.prepare('SELECT COUNT(*) AS count FROM audits').get()).toEqual(auditsBefore)
  })

  it('advances contiguous events after terminal without overwriting terminal status', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })
    const terminal = await store.getDetail(detail.task.id)

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'run.succeeded',
      summary: 'late success',
    })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('failed')
    expect(updated.runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_FAILED',
      lastEventSeq: 2,
      endedAt: terminal.runs[0]?.endedAt,
    })
  })
})

describe('migrations', () => {
  it('preserves associations and history after reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runwright-core-'))
    const path = join(directory, 'core.db')
    const firstDb = openDatabase(path)
    try {
      const first = new CoreStore(firstDb)
      const persistedProject = await first.registerProject({ name: 'Persistent', rootPath: '/tmp/persistent' })
      const detail = await first.createTask({ projectId: persistedProject.id, prompt: 'persist me' })
      await first.attachRuntime(detail.runs[0]!.id, 'next-local', 'session-persistent')
      await first.applyRuntimeEvent(detail.runs[0]!.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })
      await first.retry(detail.task.id)

      const reopened = openDatabase(path)
      try {
        const migrated = new CoreStore(reopened)
        expect((await migrated.getDetail(detail.task.id)).runs).toHaveLength(2)
        expect((await migrated.getDetail(detail.task.id)).runs[0]).toMatchObject({ sessionId: 'session-persistent' })
        expect(reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 1 })
      } finally {
        reopened.close()
      }
    } finally {
      firstDb.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
