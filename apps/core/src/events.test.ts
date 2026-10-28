import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, RuntimeEvent, TaskDetail, TaskStatus } from '@runwright/contracts'
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

async function createTask(): Promise<TaskDetail> {
  return store.createTask({ projectId: project.id, prompt: 'add parser' })
}

function auditCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM audits').get() as { count: number }).count
}

describe('runtime event projection', () => {
  it('applies a contiguous event to the run, task, cursor, and audit', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!

    expect(await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.started' })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task).toMatchObject({ status: 'running', activeRunId: run.id })
    expect(updated.runs[0]).toMatchObject({ status: 'running', lastEventSeq: 1 })
    const audit = db.prepare(
      'SELECT kind, payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { kind: string; payload_json: string }
    expect(audit.kind).toBe('runtime.event')
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      seq: 1,
      eventType: 'run.started',
      status: 'running',
    })
  })

  it('returns duplicate for replayed and older sequences without changing state or audit', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.started' })
    await store.applyRuntimeEvent(run.id, { seq: 2, type: 'validation.completed', summary: '2 tests passed' })
    const auditsBefore = auditCount()

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'validation.completed',
      summary: 'duplicate',
    })).toBe('duplicate')
    expect(await store.applyRuntimeEvent(run.id, {
      seq: 1,
      type: 'run.failed',
      errorCode: 'STALE_FAILURE',
    })).toBe('duplicate')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('running')
    expect(updated.runs[0]).toMatchObject({ status: 'running', lastEventSeq: 2 })
    expect(updated.validationSummary).toBe('2 tests passed')
    expect(auditCount()).toBe(auditsBefore)
  })

  it('returns gap and marks the active run and task attention without advancing the cursor', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'run.progress',
      summary: 'editing',
    })).toBe('gap')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('attention')
    expect(updated.runs[0]).toMatchObject({
      status: 'attention',
      errorCode: 'EVENT_GAP',
      lastEventSeq: 0,
    })
    const audit = db.prepare(
      'SELECT kind, payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { kind: string; payload_json: string }
    expect(audit.kind).toBe('run.attention')
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      status: 'attention',
      errorCode: 'EVENT_GAP',
    })
  })

  it('advances progress without overwriting waiting approval', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.started' })
    await store.applyRuntimeEvent(run.id, { seq: 2, type: 'approval.requested', approvalId: 'approval-1' })

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 3,
      type: 'run.progress',
      summary: 'editing',
    })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('waiting_approval')
    expect(updated.runs[0]).toMatchObject({ status: 'waiting_approval', lastEventSeq: 3 })
    const audit = db.prepare(
      'SELECT payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { payload_json: string }
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      seq: 3,
      eventType: 'run.progress',
      status: 'waiting_approval',
    })
  })

  it('returns to running only when the requested approval is resolved', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.started' })
    await store.applyRuntimeEvent(run.id, { seq: 2, type: 'approval.requested', approvalId: 'approval-1' })

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 3,
      type: 'approval.resolved',
      approvalId: 'approval-1',
    })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('running')
    expect(updated.runs[0]).toMatchObject({ status: 'running', lastEventSeq: 3 })
  })

  it('saves validation evidence without changing the current run status', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'approval.requested', approvalId: 'approval-1' })

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'validation.completed',
      summary: '2 tests passed',
    })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('waiting_approval')
    expect(updated.runs[0]).toMatchObject({ status: 'waiting_approval', lastEventSeq: 2 })
    expect(updated.validationSummary).toBe('2 tests passed')
  })

  it('leaves validation summary absent when no validation completed event arrived', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    expect(detail.validationSummary).toBeUndefined()

    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.progress', summary: 'editing' })
    await store.applyRuntimeEvent(run.id, { seq: 2, type: 'run.succeeded', summary: 'done' })

    expect((await store.getDetail(detail.task.id)).validationSummary).toBeUndefined()
  })

  it.each([
    {
      event: { seq: 1, type: 'run.succeeded', summary: 'done' } as RuntimeEvent,
      status: 'succeeded' as TaskStatus,
      errorCode: undefined,
    },
    {
      event: { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' } as RuntimeEvent,
      status: 'failed' as TaskStatus,
      errorCode: 'MODEL_FAILED',
    },
    {
      event: { seq: 1, type: 'run.cancelled' } as RuntimeEvent,
      status: 'cancelled' as TaskStatus,
      errorCode: undefined,
    },
    {
      event: { seq: 1, type: 'run.attention', reason: 'SESSION_UNKNOWN' } as RuntimeEvent,
      status: 'attention' as TaskStatus,
      errorCode: 'SESSION_UNKNOWN',
    },
  ])('maps $event.type to $status', async ({ event, status, errorCode }) => {
    const detail = await createTask()
    const run = detail.runs[0]!

    expect(await store.applyRuntimeEvent(run.id, event)).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe(status)
    expect(updated.runs[0]).toMatchObject({ status, lastEventSeq: 1 })
    expect(updated.runs[0]?.errorCode).toBe(errorCode)
  })

  it('returns duplicate for replayed or older sequences after terminal without any writes', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'validation.completed', summary: 'keep this evidence' })
    await store.applyRuntimeEvent(run.id, { seq: 2, type: 'run.failed', errorCode: 'MODEL_FAILED' })
    const terminal = await store.getDetail(detail.task.id)
    const auditsBefore = auditCount()
    expect(terminal.task.status).toBe('failed')

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'run.succeeded',
      summary: 'replayed sequence',
    })).toBe('duplicate')
    expect(await store.applyRuntimeEvent(run.id, {
      seq: 1,
      type: 'validation.completed',
      summary: 'stale evidence',
    })).toBe('duplicate')

    expect(await store.getDetail(detail.task.id)).toEqual(terminal)
    expect(auditCount()).toBe(auditsBefore)
  })

  it('applies contiguous post-terminal validation while preserving terminal status and ended_at', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })
    const endedAt = '2026-01-02T03:04:05.000Z'
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(endedAt, run.id)
    const auditsBefore = auditCount()

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 2,
      type: 'validation.completed',
      summary: '2 tests passed',
    })).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('failed')
    expect(updated.runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_FAILED',
      lastEventSeq: 2,
      endedAt,
    })
    expect(updated.validationSummary).toBe('2 tests passed')
    expect(auditCount()).toBe(auditsBefore + 1)
    const audit = db.prepare(
      'SELECT kind, payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { kind: string; payload_json: string }
    expect(audit.kind).toBe('runtime.event')
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      seq: 2,
      eventType: 'validation.completed',
      status: 'failed',
    })
  })

  it.each([
    {
      event: { seq: 2, type: 'run.succeeded', summary: 'late success' } as RuntimeEvent,
    },
    {
      event: { seq: 2, type: 'run.progress', summary: 'late progress' } as RuntimeEvent,
    },
  ])('preserves terminal status and ended_at for a contiguous $event.type event', async ({ event }) => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })
    const endedAt = '2026-01-02T03:04:05.000Z'
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(endedAt, run.id)
    const auditsBefore = auditCount()

    expect(await store.applyRuntimeEvent(run.id, event)).toBe('applied')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('failed')
    expect(updated.runs[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_FAILED',
      lastEventSeq: 2,
      endedAt,
    })
    expect(auditCount()).toBe(auditsBefore + 1)
    const audit = db.prepare(
      'SELECT payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { payload_json: string }
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      seq: 2,
      eventType: event.type,
      status: 'failed',
    })
  })

  it('returns gap for a future sequence after terminal without advancing the cursor', async () => {
    const detail = await createTask()
    const run = detail.runs[0]!
    await store.applyRuntimeEvent(run.id, { seq: 1, type: 'run.failed', errorCode: 'MODEL_FAILED' })
    const auditsBefore = auditCount()

    expect(await store.applyRuntimeEvent(run.id, {
      seq: 3,
      type: 'validation.completed',
      summary: 'future evidence',
    })).toBe('gap')

    const updated = await store.getDetail(detail.task.id)
    expect(updated.task.status).toBe('attention')
    expect(updated.runs[0]).toMatchObject({
      status: 'attention',
      errorCode: 'EVENT_GAP',
      lastEventSeq: 1,
    })
    expect(updated.validationSummary).toBeUndefined()
    expect(auditCount()).toBe(auditsBefore + 1)
    const audit = db.prepare(
      'SELECT kind, payload_json FROM audits WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(run.id) as { kind: string; payload_json: string }
    expect(audit.kind).toBe('run.attention')
    expect(JSON.parse(audit.payload_json)).toEqual({
      runId: run.id,
      status: 'attention',
      errorCode: 'EVENT_GAP',
    })
  })
})
