import type { Project, TaskDetail } from '@runwright/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createRunwrightClient, inject } from './index.js'
import type { RemoteStreamOptions, RunwrightClientContext } from './index.js'
import type { RunwrightFollowFrame } from './store.js'

const project: Project = {
  id: 'project-1',
  name: 'demo',
  rootPath: '/picked/demo',
  createdAt: '2026-10-27T00:00:00.000Z',
}

const detail: TaskDetail = {
  task: {
    id: 'task-1',
    projectId: project.id,
    prompt: 'Implement',
    status: 'succeeded',
    activeRunId: 'run-1',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  },
  runs: [{
    id: 'run-1',
    taskId: 'task-1',
    attempt: 1,
    sessionId: 'session-1',
    status: 'succeeded',
  }],
}

const baseline: RunwrightFollowFrame = {
  kind: 'baseline',
  revision: 0,
  phase: 'ready',
  projects: [project],
  tasks: [detail.task],
  details: { [detail.task.id]: detail },
}

interface ClientFixture {
  ctx: RunwrightClientContext
  registerProject: ReturnType<typeof vi.fn>
  pick: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  openSession: ReturnType<typeof vi.fn>
  follow: ReturnType<typeof vi.fn>
  streamOptions: { current?: RemoteStreamOptions<RunwrightFollowFrame> }
  supervisor: { dispose: () => Promise<void> }
  unmount: ReturnType<typeof vi.fn>
  remoteDispose: () => Promise<void>
  effect: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
}

function fixture(picked: unknown = { ok: true, value: null }): ClientFixture {
  const registerProject = vi.fn(async () => ({ ok: true as const, value: project }))
  const pick = vi.fn(async () => picked)
  const navigate = vi.fn()
  const openSession = vi.fn(async () => ({ ok: true as const, value: 'session-1' }))
  const follow = vi.fn()
  const unmount = vi.fn(async () => {})
  const remoteDispose = vi.fn(async () => {})
  const effect = vi.fn()
  const inject = vi.fn()
  const supervisor = { dispose: vi.fn(async () => {}) }
  const streamOptions: ClientFixture['streamOptions'] = {}
  const runwright = {
    listProjects: vi.fn(),
    registerProject,
    createTask: vi.fn(),
    listTasks: vi.fn(),
    getDetail: vi.fn(),
    cancelTask: vi.fn(),
    retryTask: vi.fn(),
    openSession,
    follow,
  }
  let runwrightInjected = false
  const remote = {
    $mount: vi.fn(async () => unmount),
    $stream: vi.fn((options: RemoteStreamOptions<RunwrightFollowFrame>) => {
      streamOptions.current = options
      return {
        ...supervisor,
        async *[Symbol.asyncIterator]() {
          yield { generation: 1, value: baseline, signal: new AbortController().signal, accept: vi.fn() }
        },
      }
    }),
    get runwright() {
      if (!runwrightInjected) throw new Error('cannot get property "remote.runwright" without inject')
      return runwright
    },
    directoryPicker: { pick },
  }
  const remoteInject = vi.fn((services: string[], callback: (ctx: RunwrightClientContext) => void) => {
    runwrightInjected = services.includes('remote.runwright')
    try {
      callback({ remote } as unknown as RunwrightClientContext)
    } finally {
      runwrightInjected = false
    }
    return { dispose: remoteDispose }
  })
  const ctx = {
    inject: remoteInject,
    remote,
    uiWorkspace: { openSession: navigate },
    slots: {
      inject,
      register: vi.fn((registration: unknown) => registration),
    },
    effect,
  } as unknown as RunwrightClientContext
  return {
    ctx,
    registerProject,
    pick,
    navigate,
    openSession,
    follow,
    streamOptions,
    supervisor,
    unmount,
    remoteDispose,
    effect,
    inject,
  }
}

describe('Runwright Client composition', () => {
  it('depends only on services available before mounting the Runwright remote', () => {
    expect(inject).toEqual(['slots', 'uiWorkspace', 'remote', 'remote.directoryPicker'])
  })

  it('mounts the contribution and supervises baseline acceptance through remote.$stream', async () => {
    const fake = fixture()
    const client = await createRunwrightClient(fake.ctx)
    await vi.waitFor(() => expect(client.store.getSnapshot().phase).toBe('ready'))

    expect(fake.ctx.remote.$mount).toHaveBeenCalledTimes(1)
    expect(fake.ctx.inject).toHaveBeenCalledWith(['remote.runwright'], expect.any(Function))
    expect(fake.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(fake.inject).not.toHaveBeenCalledWith('main', expect.any(Function))
    expect(client.store.getSnapshot().projects).toEqual([project])

    const signal = new AbortController().signal
    await fake.streamOptions.current?.open(signal)
    expect(fake.follow).toHaveBeenCalledWith(signal)

    await client.dispose()
    expect(fake.supervisor.dispose).toHaveBeenCalledTimes(1)
    expect(fake.remoteDispose).toHaveBeenCalledTimes(1)
    expect(fake.unmount).toHaveBeenCalledTimes(1)
  })

  it('waits for the dynamic Remote scope before opening the follow stream', async () => {
    const fake = fixture()
    const remoteInject = vi.mocked(fake.ctx.inject).getMockImplementation()!
    vi.mocked(fake.ctx.inject).mockImplementation((services, callback) => {
      queueMicrotask(() => remoteInject(services, callback))
      return { dispose: fake.remoteDispose }
    })
    fake.follow.mockReturnValue((async function * () {})())
    vi.mocked(fake.ctx.remote.$stream).mockImplementation(<Item,>(options: RemoteStreamOptions<Item>) => {
      const followOptions = options as unknown as RemoteStreamOptions<RunwrightFollowFrame>
      fake.streamOptions.current = followOptions
      followOptions.open(new AbortController().signal)
      return {
        dispose: fake.supervisor.dispose,
        async *[Symbol.asyncIterator]() {},
      }
    })

    const client = await createRunwrightClient(fake.ctx)

    expect(fake.follow).toHaveBeenCalledTimes(1)
    await client.dispose()
  })

  it('uses the NEXT native picker when the Remote composition only offers browse', async () => {
    const fake = fixture()
    const nativePick = vi.fn(async () => '/picked/demo')
    fake.pick.mockRejectedValue(new Error('directoryPicker.pick needs the native capability; the composed picker serves "browse"'))
    const desktop = globalThis as typeof globalThis & {
      __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
    }
    desktop.__DSH_DIRECTORY_PICKER__ = { pick: nativePick }

    try {
      const client = await createRunwrightClient(fake.ctx)
      await client.actions.registerProject()

      expect(nativePick).toHaveBeenCalledTimes(1)
      expect(fake.registerProject).toHaveBeenCalledWith(
        { name: 'demo', rootPath: '/picked/demo' },
        expect.any(AbortSignal),
      )
      await client.dispose()
    } finally {
      delete desktop.__DSH_DIRECTORY_PICKER__
    }
  })

  it('treats picker cancellation as a no-op and unwraps only the picked path for registration', async () => {
    const cancelled = fixture({ ok: true, value: null })
    const cancelledClient = await createRunwrightClient(cancelled.ctx)
    await cancelledClient.actions.registerProject()
    expect(cancelled.registerProject).not.toHaveBeenCalled()
    await cancelledClient.dispose()

    const picked = fixture({ ok: true, value: '/picked/demo' })
    const pickedClient = await createRunwrightClient(picked.ctx)
    await pickedClient.actions.registerProject()
    expect(picked.registerProject).toHaveBeenCalledWith(
      { name: 'demo', rootPath: '/picked/demo' },
      expect.any(AbortSignal),
    )
    await pickedClient.dispose()
  })

  it('opens the Result Session through the real NEXT workspace navigation API', async () => {
    const fake = fixture()
    const client = await createRunwrightClient(fake.ctx)

    await client.actions.openSession(detail.task.id)

    expect(fake.openSession).toHaveBeenCalledWith(detail.task.id, expect.any(AbortSignal))
    expect(fake.navigate).toHaveBeenCalledWith('session-1')
    await client.dispose()
  })

  it('marks the existing projection offline on a stream carrier failure', async () => {
    const fake = fixture()
    const client = await createRunwrightClient(fake.ctx)
    await vi.waitFor(() => expect(client.store.getSnapshot().phase).toBe('ready'))

    fake.streamOptions.current?.carrierFailed?.(new Error('offline'))

    expect(client.store.getSnapshot()).toMatchObject({ phase: 'offline', projects: [project] })
    await client.dispose()
  })

  it('does not register or navigate after disposal while actions are in flight', async () => {
    const fake = fixture()
    let resolvePick!: (result: { ok: true; value: string }) => void
    fake.pick.mockReturnValue(new Promise(resolve => { resolvePick = resolve }))
    let resolveSession!: (result: { ok: true; value: string }) => void
    fake.openSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve }))
    const client = await createRunwrightClient(fake.ctx)
    const registering = client.actions.registerProject()
    const opening = client.actions.openSession(detail.task.id)

    await client.dispose()
    resolvePick({ ok: true, value: '/picked/demo' })
    resolveSession({ ok: true, value: 'session-1' })
    await Promise.all([registering, opening])

    expect(fake.registerProject).not.toHaveBeenCalled()
    expect(fake.navigate).not.toHaveBeenCalled()
  })
})
