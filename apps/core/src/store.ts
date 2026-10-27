import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Project, Run, RuntimeEvent, Task, TaskDetail, TaskStatus } from '@runwright/contracts'
import { isTerminal, statusForEvent, toProject, toRun, toTask } from './domain.js'
import type { ProjectRow, RunRow, TaskRow } from './domain.js'

interface CoreSnapshot {
  projects: Project[]
  tasks: Task[]
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
      this.audit(null, 'project.registered', { projectId: project.id, name: project.name })
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

  async recordDispatch(runId: string): Promise<void> {
    this.db.transaction(() => {
      const run = this.run(runId)
      this.db.prepare('UPDATE runs SET dispatch_requested = 1 WHERE id = ?').run(runId)
      this.audit(runId, 'runtime.dispatch_requested', { runId, status: run.status })
    })()
  }

  async attachRuntime(runId: string, runtimeId: string, sessionId: string): Promise<void> {
    this.db.transaction(() => {
      this.run(runId)
      const now = new Date().toISOString()
      this.db.prepare(`UPDATE runs SET runtime_id = ?, session_id = ?, status = 'running',
        started_at = COALESCE(started_at, ?), ended_at = NULL WHERE id = ?`).run(runtimeId, sessionId, now, runId)
      this.db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE active_run_id = ?`).run(now, runId)
      this.audit(runId, 'runtime.attached', { runId, runtimeId, sessionId, status: 'running' })
    })()
  }

  async applyEvent(runId: string, event: RuntimeEvent): Promise<void> {
    this.db.transaction(() => {
      const run = this.run(runId)
      if (isTerminal(run.status) || event.seq <= run.last_event_seq) return

      const status = statusForEvent(event)
      const now = new Date().toISOString()
      const errorCode = event.type === 'run.failed'
        ? event.errorCode
        : event.type === 'run.attention' ? event.reason : run.error_code
      const validationSummary = event.type === 'validation.completed'
        ? event.summary
        : run.validation_summary
      this.db.prepare(`UPDATE runs SET status = ?, started_at = COALESCE(started_at, ?),
        ended_at = ?, last_event_seq = ?, error_code = ?, validation_summary = ? WHERE id = ?`).run(
        status,
        now,
        isTerminal(status) ? now : null,
        event.seq,
        errorCode,
        validationSummary,
        runId,
      )
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE active_run_id = ?').run(status, now, runId)
      this.audit(runId, 'runtime.event', {
        runId,
        seq: event.seq,
        eventType: event.type,
        status,
        ...(event.type === 'run.failed' ? { errorCode: event.errorCode } : {}),
        ...('summary' in event ? { summary: event.summary } : {}),
      })
    })()
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
