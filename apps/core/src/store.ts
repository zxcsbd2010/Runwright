import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Project, Run, RuntimeEvent, Task, TaskDetail, TaskStatus } from '@runwright/contracts'
import { isTerminal, toProject, toRun, toTask } from './domain.js'
import type { ProjectRow, RunRow, TaskRow } from './domain.js'
import { applyRuntimeEvent as projectRuntimeEvent } from './events.js'
import type { ApplyRuntimeEventResult } from './events.js'

interface CoreSnapshot {
  projects: Project[]
  tasks: Task[]
}

export interface RunContext {
  project: Project
  task: Task
  run: Run
  dispatchRequested: boolean
  cancelRequested: boolean
}

interface RunContextRow extends RunRow {
  prompt: string
  project_id: string
  task_status: TaskStatus
  task_active_run_id: string | null
  task_created_at: string
  task_updated_at: string
  project_name: string
  project_root_path: string
  project_created_at: string
}

const runContextSelect = `SELECT r.*, t.prompt, t.project_id, t.status AS task_status,
  t.active_run_id AS task_active_run_id,
  t.created_at AS task_created_at, t.updated_at AS task_updated_at,
  p.name AS project_name, p.root_path AS project_root_path, p.created_at AS project_created_at
  FROM runs r JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = t.project_id`

function toRunContext(row: RunContextRow): RunContext {
  return {
    project: {
      id: row.project_id,
      name: row.project_name,
      rootPath: row.project_root_path,
      createdAt: row.project_created_at,
    },
    task: {
      id: row.task_id,
      projectId: row.project_id,
      prompt: row.prompt,
      status: row.task_status,
      ...(row.task_active_run_id ? { activeRunId: row.task_active_run_id } : {}),
      createdAt: row.task_created_at,
      updatedAt: row.task_updated_at,
    },
    run: toRun(row),
    dispatchRequested: row.dispatch_requested === 1,
    cancelRequested: row.cancel_requested === 1,
  }
}

export class CoreStore {
  constructor(private readonly db: Database.Database) {}

  async registerProject(input: { name: string; rootPath: string }): Promise<Project> {
    return this.db.transaction(() => {
      const project: ProjectRow = {
        id: randomUUID(),
        name: input.name,
        root_path: input.rootPath,
        created_at: new Date().toISOString(),
      }
      this.db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(
        project.id, project.name, project.root_path, project.created_at,
      )
      this.audit(null, 'project.registered', { projectId: project.id })
      return toProject(project)
    })()
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as ProjectRow[]
    return rows.map(toProject)
  }

  async createTask(input: { projectId: string; prompt: string }): Promise<TaskDetail> {
    return this.db.transaction(() => {
      const taskId = randomUUID()
      const runId = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare(
        'INSERT INTO tasks (id, project_id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(taskId, input.projectId, input.prompt, 'queued', now, now)
      this.db.prepare(
        'INSERT INTO runs (id, task_id, attempt, status, created_at) VALUES (?, ?, 1, ?, ?)',
      ).run(runId, taskId, 'queued', now)
      this.db.prepare('UPDATE tasks SET active_run_id = ? WHERE id = ?').run(runId, taskId)
      this.audit(runId, 'task.created', { taskId, runId, attempt: 1, status: 'queued' })
      return this.detail(taskId)
    })()
  }

  async listTasks(filter: { projectId?: string; status?: TaskStatus } = {}): Promise<Task[]> {
    const conditions: string[] = []
    const params: string[] = []
    if (filter.projectId) {
      conditions.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at, id`).all(...params) as TaskRow[]
    return rows.map(toTask)
  }

  async getDetail(taskId: string): Promise<TaskDetail> {
    return this.detail(taskId)
  }

  async getRunContext(runId: string): Promise<RunContext> {
    const row = this.db.prepare(`${runContextSelect} WHERE r.id = ?`).get(runId) as RunContextRow | undefined
    if (!row) throw new Error('RUN_NOT_FOUND')
    return toRunContext(row)
  }

  async listRecoveryRuns(): Promise<RunContext[]> {
    const rows = this.db.prepare(`${runContextSelect}
      WHERE t.active_run_id = r.id AND (r.status IN ('queued','running','waiting_approval')
        OR (r.status = 'attention' AND r.cancel_requested = 1))
      ORDER BY r.created_at, r.id`).all() as RunContextRow[]
    return rows.map(toRunContext)
  }

  async recordDispatch(runId: string): Promise<boolean> {
    return this.db.transaction(() => {
      const run = this.run(runId)
      const result = this.db.prepare('UPDATE runs SET dispatch_requested = 1 WHERE id = ? AND dispatch_requested = 0').run(runId)
      if (result.changes === 0) return false
      this.audit(runId, 'runtime.dispatch_requested', { runId, status: run.status })
      return true
    })()
  }

  async attachRuntime(runId: string, runtimeId: string, sessionId: string): Promise<void> {
    this.db.transaction(() => {
      const run = this.run(runId)
      const status = run.status === 'waiting_approval' || run.status === 'attention' ? run.status : 'running'
      const now = new Date().toISOString()
      this.db.prepare(`UPDATE runs SET runtime_id = ?, session_id = ?, status = ?,
        started_at = COALESCE(started_at, ?), ended_at = NULL WHERE id = ?`).run(runtimeId, sessionId, status, now, runId)
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE active_run_id = ?').run(status, now, runId)
      this.audit(runId, 'runtime.attached', { runId, runtimeId, sessionId, status })
    })()
  }

  async applyRuntimeEvent(runId: string, event: RuntimeEvent): Promise<ApplyRuntimeEventResult> {
    return projectRuntimeEvent(this.db, runId, event, (auditRunId, kind, payload) => {
      this.audit(auditRunId, kind, payload)
    })
  }

  async requestCancel(taskId: string): Promise<void> {
    this.db.transaction(() => {
      const task = this.task(taskId)
      if (!task.active_run_id) throw new Error('RUN_NOT_FOUND')
      this.db.prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(task.active_run_id)
      this.audit(task.active_run_id, 'cancellation.requested', {
        taskId,
        runId: task.active_run_id,
        status: task.status,
      })
    })()
  }

  async retry(taskId: string): Promise<Run> {
    return this.db.transaction(() => {
      const task = this.task(taskId)
      if (!task.active_run_id) throw new Error('RUN_NOT_FOUND')
      const previous = this.run(task.active_run_id)
      if (!isTerminal(previous.status)) throw new Error('RUN_STILL_ACTIVE')

      const runId = randomUUID()
      const now = new Date().toISOString()
      const attempt = (this.db.prepare(
        'SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM runs WHERE task_id = ?',
      ).get(taskId) as { attempt: number }).attempt
      this.db.prepare(
        'INSERT INTO runs (id, task_id, attempt, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(runId, taskId, attempt, 'queued', now)
      this.db.prepare(
        "UPDATE tasks SET active_run_id = ?, status = 'queued', updated_at = ? WHERE id = ?",
      ).run(runId, now, taskId)
      this.audit(runId, 'task.retried', {
        taskId,
        previousRunId: previous.id,
        runId,
        attempt,
        status: 'queued',
      })
      return toRun(this.run(runId))
    })()
  }

  async markAttention(runId: string, errorCode: string): Promise<void> {
    this.db.transaction(() => {
      const run = this.run(runId)
      if (isTerminal(run.status)) return
      const now = new Date().toISOString()
      this.db.prepare("UPDATE runs SET status = 'attention', error_code = ?, ended_at = NULL WHERE id = ?").run(errorCode, runId)
      this.db.prepare("UPDATE tasks SET status = 'attention', updated_at = ? WHERE active_run_id = ?").run(now, runId)
      this.audit(runId, 'run.attention', { runId, status: 'attention', errorCode })
    })()
  }

  async snapshot(): Promise<CoreSnapshot> {
    return { projects: await this.listProjects(), tasks: await this.listTasks() }
  }

  private detail(taskId: string): TaskDetail {
    const task = this.task(taskId)
    const rows = this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt').all(taskId) as RunRow[]
    const validationSummary = rows.findLast((row) => row.validation_summary !== null)?.validation_summary
    return {
      task: toTask(task),
      runs: rows.map(toRun),
      ...(validationSummary ? { validationSummary } : {}),
    }
  }

  private task(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) throw new Error('TASK_NOT_FOUND')
    return row
  }

  private run(runId: string): RunRow {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
    if (!row) throw new Error('RUN_NOT_FOUND')
    return row
  }

  private audit(runId: string | null, kind: string, payload: Record<string, string | number>): void {
    this.db.prepare(
      'INSERT INTO audits (id, run_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), runId, kind, JSON.stringify(payload), new Date().toISOString())
  }
}
