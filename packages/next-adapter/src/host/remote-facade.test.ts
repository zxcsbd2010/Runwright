import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { CoreMethod, Project, Run, Task, TaskDetail } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoreConnectionError } from './core-connection.js'
import { RunwrightRemoteFacade } from './remote-facade.js'
import { TYPERT_REMOTE } from '../remote.js'
import type { RunwrightCoreClient } from './remote-facade.js'

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  rootPath: '/picked/demo',
  createdAt: '2026-10-27T00:00:00.000Z',
}

const task: Task = {
  id: 'task-1',
  projectId: project.id,
  prompt: 'Implement the feature',
  status: 'queued',
  activeRunId: 'run-1',
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
}

const run: Run = {
  id: 'run-1',
  taskId: task.id,
  attempt: 1,
  sessionId: 'session-1',
  status: 'queued',
}

const detail: TaskDetail = { task, runs: [run] }

function coreClient(overrides: Partial<Record<CoreMethod, unknown>> = {}): RunwrightCoreClient {
  const values: Record<CoreMethod, unknown> = {
    'projects.list': [],
    'projects.register': project,
    'tasks.create': detail,
    'tasks.list': [],
    'tasks.detail': detail,
    'tasks.cancel': detail,
    'tasks.retry': run,
    'runtime.start': undefined,
    'runtime.attach': undefined,
    'runtime.cancel': undefined,
    'runtime.snapshot': undefined,
    ...overrides,
  }
  return {
    call: vi.fn(async <T,>(method: CoreMethod): Promise<T> => values[method] as T) as RunwrightCoreClient['call'],
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('RunwrightRemoteFacade', () => {
  it('accepts ready and offline follow frames through the strict Typert codec', () => {
    const follow = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'follow')!
    const schema = (follow.result as unknown as { schema: { safeParse: (value: unknown) => { success: boolean } } }).schema
    const frame = { kind: 'baseline', revision: 0, projects: [], tasks: [], details: {} }

    expect(schema.safeParse({ ...frame, phase: 'ready' }).success).toBe(true)
    expect(schema.safeParse({ ...frame, phase: 'offline' }).success).toBe(true)
  })

  it('maps every workbench command to the existing Core RPC contract', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const core = coreClient({
      'projects.list': [project],
      'tasks.list': [task],
    })
    const service = new RunwrightRemoteFacade(ctx, core)
    const signal = new AbortController().signal

    await expect(service.listProjects(signal)).resolves.toEqual([project])
    await expect(service.registerProject({ name: 'Demo', rootPath: '/picked/demo' }, signal)).resolves.toEqual(project)
    await expect(service.createTask({ projectId: project.id, prompt: task.prompt }, signal)).resolves.toEqual(detail)
    await expect(service.listTasks({ projectId: project.id }, signal)).resolves.toEqual([task])
    await expect(service.listTasks(undefined, signal)).resolves.toEqual([task])
    await expect(service.getDetail(task.id, signal)).resolves.toEqual(detail)
    await expect(service.cancelTask(task.id, signal)).resolves.toEqual(detail)
    await expect(service.retryTask(task.id, signal)).resolves.toEqual(run)
    await expect(service.openSession(task.id, signal)).resolves.toBe('session-1')

    expect(core.call).toHaveBeenCalledWith('projects.list', {}, signal)
    expect(core.call).toHaveBeenCalledWith('projects.register', { name: 'Demo', rootPath: '/picked/demo' }, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.create', { projectId: project.id, prompt: task.prompt }, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.list', { projectId: project.id }, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.list', {}, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.detail', { taskId: task.id }, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.cancel', { taskId: task.id }, signal)
    expect(core.call).toHaveBeenCalledWith('tasks.retry', { taskId: task.id }, signal)
  })

  it('exposes follow as a Remote stream that yields a baseline before increments', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    let projects: Project[] = []
    const core = coreClient()
    vi.mocked(core.call).mockImplementation(async <T,>(method: CoreMethod): Promise<T> => {
      if (method === 'projects.list') return projects as T
      if (method === 'tasks.list') return [] as T
      throw new Error(`unexpected method: ${method}`)
    })
    const service = new RunwrightRemoteFacade(ctx, core, { pollIntervalMs: 1 })
    const abort = new AbortController()
    const stream = service.follow(abort.signal)[Symbol.asyncIterator]()

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { kind: 'baseline', revision: 0, phase: 'ready', projects: [], tasks: [], details: {} },
    })
    projects = [project]
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: {
        kind: 'increment',
        revision: 1,
        phase: 'ready',
        projects: [project],
        tasks: [],
        details: {},
      },
    })
    abort.abort()
    await stream.return?.()

    expect(remoteMethods(service)).toContainEqual({
      method: 'follow',
      mode: 'stream',
      invocation: { kind: 'direct' },
    })
  })

  it('propagates Core offline failures instead of fabricating an empty project list', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const core = coreClient()
    vi.mocked(core.call).mockRejectedValue(new CoreConnectionError('CORE_DISCONNECTED'))
    const service = new RunwrightRemoteFacade(ctx, core)

    await expect(service.listProjects(new AbortController().signal)).rejects.toMatchObject({ code: 'CORE_DISCONNECTED' })
  })

  it('keeps follow alive across a transient Core outage and yields after recovery', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const core = coreClient()
    let offline = true
    vi.mocked(core.call).mockImplementation(async <T,>(method: CoreMethod): Promise<T> => {
      if (offline) throw new CoreConnectionError('CORE_DISCONNECTED')
      if (method === 'projects.list') return [project] as T
      if (method === 'tasks.list') return [] as T
      throw new Error(`unexpected method: ${method}`)
    })
    const service = new RunwrightRemoteFacade(ctx, core, { pollIntervalMs: 1 })
    const abort = new AbortController()
    const stream = service.follow(abort.signal)[Symbol.asyncIterator]()
    const first = stream.next()
    await vi.waitFor(() => expect(core.call).toHaveBeenCalled())
    await expect(first).resolves.toEqual({
      done: false,
      value: { kind: 'baseline', revision: 0, phase: 'offline', projects: [], tasks: [], details: {} },
    })
    offline = false
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { kind: 'increment', revision: 1, phase: 'ready', projects: [project], tasks: [], details: {} },
    })
    abort.abort()
    await stream.return?.()
  })
})
