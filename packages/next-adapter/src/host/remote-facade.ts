import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CoreMethod, Project, Run, Task, TaskDetail } from '@runwright/contracts'
import type { RunwrightFollowFrame } from '../client/store.js'

export interface RunwrightCoreClient {
  call<T>(method: CoreMethod, params: unknown, signal?: AbortSignal): Promise<T>
}

export interface RunwrightRemoteFacadeOptions {
  pollIntervalMs?: number
}

export class RunwrightRemoteFacade extends TypertRemoteService {
  private readonly pollIntervalMs: number

  constructor(
    ctx: Context,
    private readonly core: RunwrightCoreClient,
    options: RunwrightRemoteFacadeOptions = {},
  ) {
    super(ctx, 'runwright')
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
  }

  @Remote
  async listProjects(signal: AbortSignal): Promise<Project[]> {
    return await this.core.call('projects.list', {}, signal)
  }

  @Remote
  async registerProject(input: { name: string; rootPath: string }, signal: AbortSignal): Promise<Project> {
    return await this.core.call('projects.register', input, signal)
  }

  @Remote
  async createTask(input: { projectId: string; prompt: string }, signal: AbortSignal): Promise<TaskDetail> {
    return await this.core.call('tasks.create', input, signal)
  }

  @Remote
  async listTasks(filter: { projectId?: string; status?: Task['status'] } | undefined, signal: AbortSignal): Promise<Task[]> {
    return await this.core.call('tasks.list', filter ?? {}, signal)
  }

  @Remote
  async getDetail(taskId: string, signal: AbortSignal): Promise<TaskDetail> {
    return await this.core.call('tasks.detail', { taskId }, signal)
  }

  @Remote
  async cancelTask(taskId: string, signal: AbortSignal): Promise<TaskDetail> {
    return await this.core.call('tasks.cancel', { taskId }, signal)
  }

  @Remote
  async retryTask(taskId: string, signal: AbortSignal): Promise<Run> {
    return await this.core.call('tasks.retry', { taskId }, signal)
  }

  @Remote
  async openSession(taskId: string, signal: AbortSignal): Promise<string | undefined> {
    const detail = await this.getDetail(taskId, signal)
    return detail.runs.findLast(run => run.sessionId !== undefined)?.sessionId
  }

  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<RunwrightFollowFrame> {
    let revision = 0
    let kind: 'baseline' | 'increment' = 'baseline'
    let previous = ''
    let offline = false
    let last = { projects: [] as Project[], tasks: [] as Task[], details: {} as Record<string, TaskDetail> }
    for (;;) {
      signal.throwIfAborted()
      try {
        const frame = await this.snapshot(kind, revision, signal)
        last = { projects: frame.projects, tasks: frame.tasks, details: frame.details }
        const serialized = JSON.stringify(last)
        if (offline || serialized !== previous) {
          yield frame
          previous = serialized
          revision++
          kind = 'increment'
        }
        offline = false
      } catch (error) {
        if (signal.aborted) throw error
        if (!offline) {
          yield { kind, revision, phase: 'offline', ...last }
          revision++
          kind = 'increment'
        }
        offline = true
      }
      await waitForPoll(this.pollIntervalMs, signal)
    }
  }

  private async snapshot(
    kind: 'baseline' | 'increment',
    revision: number,
    signal: AbortSignal,
  ): Promise<RunwrightFollowFrame> {
    const [projects, tasks] = await Promise.all([
      this.core.call<Project[]>('projects.list', {}, signal),
      this.core.call<Task[]>('tasks.list', {}, signal),
    ])
    const details = Object.fromEntries(await Promise.all(tasks.map(async task => [
      task.id,
      await this.core.call<TaskDetail>('tasks.detail', { taskId: task.id }, signal),
    ] as const)))
    return { kind, revision, phase: 'ready', projects, tasks, details }
  }
}

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, intervalMs)
    const aborted = () => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
