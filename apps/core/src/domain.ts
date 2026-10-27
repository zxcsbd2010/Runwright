import type { Project, Run, RuntimeEvent, Task, TaskStatus } from '@runwright/contracts'

export interface ProjectRow {
  id: string
  name: string
  root_path: string
  created_at: string
}

export interface TaskRow {
  id: string
  project_id: string
  prompt: string
  status: TaskStatus
  active_run_id: string | null
  created_at: string
  updated_at: string
}

export interface RunRow {
  id: string
  task_id: string
  attempt: number
  runtime_id: string | null
  session_id: string | null
  status: TaskStatus
  dispatch_requested: number
  cancel_requested: number
  started_at: string | null
  ended_at: string | null
  last_event_seq: number
  error_code: string | null
  validation_summary: string | null
  created_at: string
}

export function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, rootPath: row.root_path, createdAt: row.created_at }
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status,
    ...(row.active_run_id ? { activeRunId: row.active_run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    status: row.status,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    lastEventSeq: row.last_event_seq,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export function statusForEvent(event: RuntimeEvent): TaskStatus {
  switch (event.type) {
    case 'run.started':
    case 'run.progress':
    case 'validation.completed':
      return 'running'
    case 'approval.requested':
      return 'waiting_approval'
    case 'run.succeeded':
      return 'succeeded'
    case 'run.failed':
      return 'failed'
    case 'run.attention':
      return 'attention'
  }
}
