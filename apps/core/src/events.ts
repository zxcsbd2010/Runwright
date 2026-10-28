import type Database from 'better-sqlite3'
import type { RuntimeEvent, TaskStatus } from '@runwright/contracts'
import { isTerminal } from './domain.js'
import type { RunRow } from './domain.js'

export type ApplyRuntimeEventResult = 'applied' | 'duplicate' | 'gap'

type Audit = (
  runId: string | null,
  kind: string,
  payload: Record<string, string | number>,
) => void

export function applyRuntimeEvent(
  db: Database.Database,
  runId: string,
  event: RuntimeEvent,
  audit: Audit,
): ApplyRuntimeEventResult {
  return db.transaction(() => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
    if (!run) throw new Error('RUN_NOT_FOUND')
    if (event.seq <= run.last_event_seq) return 'duplicate'

    if (event.seq !== run.last_event_seq + 1) {
      const now = new Date().toISOString()
      db.prepare("UPDATE runs SET status = 'attention', error_code = 'EVENT_GAP', ended_at = NULL WHERE id = ?").run(runId)
      db.prepare("UPDATE tasks SET status = 'attention', updated_at = ? WHERE active_run_id = ?").run(now, runId)
      audit(runId, 'run.attention', { runId, status: 'attention', errorCode: 'EVENT_GAP' })
      return 'gap'
    }

    const status = statusAfterEvent(run.status, event)
    const now = new Date().toISOString()
    const errorCode = event.type === 'run.failed'
      ? event.errorCode
      : event.type === 'run.attention' ? event.reason : run.error_code
    const validationSummary = event.type === 'validation.completed'
      ? event.summary
      : run.validation_summary
    const endedAt = isTerminal(run.status) ? run.ended_at : isTerminal(status) ? now : null
    db.prepare(`UPDATE runs SET status = ?, started_at = COALESCE(started_at, ?),
      ended_at = ?, last_event_seq = ?, error_code = ?, validation_summary = ? WHERE id = ?`).run(
      status,
      now,
      endedAt,
      event.seq,
      errorCode,
      validationSummary,
      runId,
    )
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE active_run_id = ?').run(status, now, runId)
    audit(runId, 'runtime.event', {
      runId,
      seq: event.seq,
      eventType: event.type,
      status,
      ...(event.type === 'run.failed' ? { errorCode: event.errorCode } : {}),
    })
    return 'applied'
  })()
}

function statusAfterEvent(currentStatus: TaskStatus, event: RuntimeEvent): TaskStatus {
  if (isTerminal(currentStatus)) return currentStatus

  switch (event.type) {
    case 'run.started':
      return 'running'
    case 'run.progress':
      return currentStatus === 'waiting_approval' ? currentStatus : 'running'
    case 'approval.requested':
      return 'waiting_approval'
    case 'approval.resolved':
      return 'running'
    case 'validation.completed':
      return currentStatus
    case 'run.succeeded':
      return 'succeeded'
    case 'run.failed':
      return 'failed'
    case 'run.cancelled':
      return 'cancelled'
    case 'run.attention':
      return 'attention'
  }
}
