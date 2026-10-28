import { createElement, useState, useSyncExternalStore } from 'react'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { Project, Run, Task, TaskDetail } from '@runwright/contracts'
import { TYPERT_REMOTE } from '../remote.js'
import { RunwrightStore } from './store.js'
import type { RunwrightFollowFrame } from './store.js'
import { RunwrightWorkbench } from './workbench.js'

export const inject = ['slots', 'sessions', 'remote', 'remote.runwright', 'directoryPicker']

export interface RemoteStreamItem<Item> {
  readonly generation: number
  readonly value: Item
  readonly signal: AbortSignal
  accept(): void
}

export interface RemoteStreamOptions<Item> {
  readonly name: string
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  readonly ended: (accepted: boolean) => Error
  readonly carrierFailed?: (error: unknown) => void
}

export interface RemoteStreamSupervisor<Item> extends AsyncIterable<RemoteStreamItem<Item>> {
  dispose(): Promise<void>
}

interface RunwrightRemoteApi {
  listProjects(signal?: AbortSignal): Promise<RemoteResult<Project[]>>
  registerProject(input: { name: string; rootPath: string }, signal?: AbortSignal): Promise<RemoteResult<Project>>
  createTask(input: { projectId: string; prompt: string }, signal?: AbortSignal): Promise<RemoteResult<TaskDetail>>
  listTasks(filter?: { projectId?: string; status?: Task['status'] }, signal?: AbortSignal): Promise<RemoteResult<Task[]>>
  getDetail(taskId: string, signal?: AbortSignal): Promise<RemoteResult<TaskDetail>>
  cancelTask(taskId: string, signal?: AbortSignal): Promise<RemoteResult<TaskDetail>>
  retryTask(taskId: string, signal?: AbortSignal): Promise<RemoteResult<Run>>
  openSession(taskId: string, signal?: AbortSignal): Promise<RemoteResult<string | undefined>>
  follow(signal?: AbortSignal): AsyncIterable<RunwrightFollowFrame>
}

export interface RunwrightClientContext {
  remote: {
    $mount(contribution: TypertRemoteContribution): Promise<() => void | Promise<void>>
    $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStreamSupervisor<Item>
    runwright: RunwrightRemoteApi
  }
  directoryPicker: {
    pick(): Promise<RemoteResult<string | null>>
  }
  sessions: {
    open(sessionId: string): void
  }
  slots: {
    inject(seat: string, register: () => unknown): unknown
    register(registration: Record<string, unknown>, component: unknown): unknown
  }
  effect(effect: () => void | (() => void), description?: string): unknown
}

export interface RunwrightActions {
  registerProject(): Promise<void>
  createTask(projectId: string, prompt: string): Promise<void>
  cancelTask(taskId: string): Promise<void>
  retryTask(taskId: string): Promise<void>
  openSession(taskId: string): Promise<void>
}

export interface RunwrightClient {
  store: RunwrightStore
  actions: RunwrightActions
  dispose(): Promise<void>
}

export async function apply(ctx: RunwrightClientContext): Promise<void> {
  await createRunwrightClient(ctx)
}

export async function createRunwrightClient(
  ctx: RunwrightClientContext,
  contribution: TypertRemoteContribution = TYPERT_REMOTE,
): Promise<RunwrightClient> {
  const unmount = await ctx.remote.$mount(contribution)
  const store = new RunwrightStore()
  const methodHandle = ctx.remote.runwright
  const supervisor = ctx.remote.$stream<RunwrightFollowFrame>({
    name: 'runwright.follow',
    open: (signal) => {
      const protocolStream = methodHandle.follow(signal)
      return protocolStream
    },
    ended: accepted => new Error(accepted ? 'Runwright stream ended' : 'Runwright stream ended before baseline acceptance'),
    carrierFailed: () => { store.setOffline() },
  })

  let disposed = false
  const lifetime = new AbortController()
  const consuming = consumeFollow(supervisor, store, () => disposed)
  const actions: RunwrightActions = {
    async registerProject() {
      const picked = await ctx.directoryPicker.pick()
      if (disposed) return
      if (!picked.ok) throw new Error(picked.error.message)
      if (picked.value === null) return
      const rootPath = picked.value
      await unwrap(methodHandle.registerProject({ name: directoryName(rootPath), rootPath }, lifetime.signal))
    },
    async createTask(projectId, prompt) {
      await unwrap(methodHandle.createTask({ projectId, prompt }, lifetime.signal))
    },
    async cancelTask(taskId) {
      await unwrap(methodHandle.cancelTask(taskId, lifetime.signal))
    },
    async retryTask(taskId) {
      await unwrap(methodHandle.retryTask(taskId, lifetime.signal))
    },
    async openSession(taskId) {
      const sessionId = await unwrap(methodHandle.openSession(taskId, lifetime.signal))
      if (!disposed && sessionId !== undefined) ctx.sessions.open(sessionId)
    },
  }

  const Container = () => {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [projectChoice, setProjectChoice] = useState<string>()
    const [taskChoice, setTaskChoice] = useState<string>()
    const selectedProjectId = state.projects.some(project => project.id === projectChoice)
      ? projectChoice
      : state.projects[0]?.id
    const selectedTaskId = state.tasks.some(task => task.id === taskChoice) ? taskChoice : state.tasks[0]?.id
    return createElement(RunwrightWorkbench, {
      ...state,
      selectedProjectId,
      selectedTaskId,
      onSelectProject: setProjectChoice,
      onRegisterProject: () => { void actions.registerProject() },
      onCreateTask: (prompt: string) => {
        if (selectedProjectId) void actions.createTask(selectedProjectId, prompt)
      },
      onSelectTask: setTaskChoice,
      onCancelTask: (taskId: string) => { void actions.cancelTask(taskId) },
      onRetryTask: (taskId: string) => { void actions.retryTask(taskId) },
      onOpenSession: (taskId: string) => { void actions.openSession(taskId) },
    })
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'runwright',
    order: 50,
    label: 'Runwright',
  }, Container))

  const dispose = async () => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    await supervisor.dispose()
    await consuming
    await unmount()
  }
  ctx.effect(() => () => { void dispose() }, 'Runwright workbench')
  return { store, actions, dispose }
}

async function consumeFollow(
  supervisor: RemoteStreamSupervisor<RunwrightFollowFrame>,
  store: RunwrightStore,
  disposed: () => boolean,
): Promise<void> {
  let openingGeneration = 0
  try {
    for await (const item of supervisor) {
      if (disposed()) break
      if (item.generation !== openingGeneration) {
        store.applyBaseline(item.value)
        item.accept()
        openingGeneration = item.generation
      } else {
        store.applyIncrement(item.value)
      }
    }
  } catch {
    if (!disposed()) store.setOffline()
  }
}

async function unwrap<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const resolved = await result
  if (!resolved.ok) throw new Error(resolved.error.message)
  return resolved.value
}

function directoryName(rootPath: string): string {
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Runwright project'
}
