import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from '../../apps/core/node_modules/ws/wrapper.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, startCore } from '../../apps/core/src/index.js'
import {
  CoreConnection,
  DesktopSerializer,
  apply,
  createHostRuntime,
} from '../../packages/next-adapter/src/index.js'
import type { HostContext } from '../../packages/next-adapter/src/index.js'
import { createRunwrightClient } from '../../packages/next-adapter/src/client.js'
import type { RunwrightClientContext } from '../../packages/next-adapter/src/client.js'
import { IntegrationHarness, SECRET_FIXTURE, runtimeHello } from './helpers/fake-next.js'

const roots: string[] = []
const harnesses: IntegrationHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(): Promise<IntegrationHarness> {
  const value = await IntegrationHarness.create()
  harnesses.push(value)
  return value
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'runwright-security-'))
  roots.push(value)
  return value
}

function unauthorizedExchange(port: number, authorization: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const frames: string[] = []
    socket.on('message', data => {
      frames.push(data.toString())
      socket.send(JSON.stringify({ id: 'project-1', method: 'projects.register', params: { name: 'bad', rootPath: '/unauthorized' } }))
      setTimeout(() => socket.close(), 0)
    })
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', authorization })))
    socket.on('close', () => resolve(frames))
    socket.on('error', reject)
  })
}

function authorizedProjectExchange(port: number, authorization: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const frames: string[] = []
    socket.on('message', data => {
      frames.push(data.toString())
      if (frames.length === 1) {
        socket.send(JSON.stringify({ id: 'project-valid', method: 'projects.register', params: { name: 'valid', rootPath: '/authorized' } }))
      } else {
        socket.close()
      }
    })
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', authorization })))
    socket.on('close', () => resolve(frames))
    socket.on('error', reject)
  })
}

describe('loopback, authentication, and protocol security', () => {
  it('refuses non-loopback Core listeners', async () => {
    const directory = await root()
    const tokenFile = join(directory, 'token')
    await writeFile(tokenFile, SECRET_FIXTURE, { mode: 0o600 })
    await expect(startCore({ host: '0.0.0.0', tokenFile, databasePath: join(directory, 'core.db'), handleSignals: false }))
      .rejects.toThrow('NON_LOOPBACK_HOST')
  })

  it('rejects non-loopback adapter URLs and missing tokens before any RPC', async () => {
    const directory = await root()
    const options = { url: 'ws://example.com', tokenFile: join(directory, 'missing'), hello: runtimeHello() }
    await expect(new CoreConnection(options).start()).rejects.toMatchObject({ code: 'NON_LOOPBACK_URL' })
    const value = await harness()
    await expect(new CoreConnection({
      ...options,
      url: `ws://127.0.0.1:${value.requireCore().server.address().port}`,
    }).start()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects missing credentials and never reflects token fixtures in RPC errors', async () => {
    const value = await harness()
    const frames = await unauthorizedExchange(value.requireCore().server.address().port, `Bearer wrong-${SECRET_FIXTURE}`)
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]!)).toMatchObject({ id: 'hello', error: { code: 'UNAUTHORIZED' } })
    expect(frames.join('\n')).not.toContain(SECRET_FIXTURE)
    expect(await value.requireCore().store.listProjects()).toHaveLength(0)
  })

  it('rejects an unauthorized project registration before authentication', async () => {
    const value = await harness()
    const port = value.requireCore().server.address().port
    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      socket.on('open', () => socket.send(JSON.stringify({
        id: 'register-unauthorized', method: 'projects.register', params: { name: 'bad', rootPath: '/unauthorized' },
      })))
      socket.on('message', data => { const text = data.toString(); socket.close(); resolve(text) })
      socket.on('error', reject)
    })
    expect(JSON.parse(response)).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
    expect(await value.requireCore().store.listProjects()).toHaveLength(0)
  })

  it('rejects protocol major mismatch and missing required capabilities without dispatch', async () => {
    const value = await harness()
    await expect(value.startAdapter(runtimeHello({ protocolMajor: 2 } as unknown as ReturnType<typeof runtimeHello>)))
      .rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
    await value.stopAdapter()
    await expect(value.startAdapter(runtimeHello({ capabilities: ['session.start'] })))
      .rejects.toThrow('CAPABILITIES_UNAVAILABLE')
    expect(value.next.createCalls).toHaveLength(0)
    expect(value.next.promptCalls).toHaveLength(0)
  })
})

describe('Host project, execution, and failure-isolation security', () => {
  it('registers only the path returned by the native directory picker', async () => {
    const registrations: unknown[] = []
    const emptySupervisor = {
      async *[Symbol.asyncIterator]() {},
      dispose: async () => {},
    }
    const ctx: RunwrightClientContext = {
      inject: (services, callback) => {
        callback(ctx)
        return { dispose: async () => {} }
      },
      remote: {
        $mount: async () => () => {},
        $stream: () => emptySupervisor,
        directoryPicker: { pick: async () => ({ ok: true as const, value: '/authorized/native-choice' }) },
        runwright: {
          registerProject: async input => { registrations.push(input); return { ok: true as const, value: input } },
        },
      } as unknown as RunwrightClientContext['remote'],
      sessions: { open: () => {} },
      slots: { inject: () => {}, register: () => ({}) },
      effect: () => {},
    }
    const client = await createRunwrightClient(ctx)

    await client.actions.registerProject()

    expect(registrations).toEqual([{ name: 'native-choice', rootPath: '/authorized/native-choice' }])
    expect(client.actions.registerProject).toHaveLength(0)
    await client.dispose()
  })

  it('requires native approval for external side effects and never executes them in the adapter', async () => {
    const value = await harness()
    await value.startAdapter()
    const project = await value.registerProject()
    const created = await value.createTask(project.id)
    await value.dispatch(created.runs[0]!.id)
    await vi.waitFor(() => expect(value.next.promptCalls).toHaveLength(1))
    const sessionId = (await value.detail(created.task.id)).runs[0]!.sessionId!
    let executed = false

    const decision = await value.guard!.evaluate({
      name: 'shell',
      arguments: { command: 'git push origin main' },
      agent: { session: { id: sessionId, header: { cwd: value.projectRoot } } },
    }, async () => { executed = true; return { kind: 'allow' as const } })

    expect(decision).toEqual({ kind: 'ask', reason: 'push' })
    expect(executed).toBe(false)
  })

  it('serializes CUA work without blocking an unrelated Host service', async () => {
    const serializer = new DesktopSerializer()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = serializer.run(async () => { order.push('cua-start'); await gate; order.push('cua-end') })
    const second = serializer.run(async () => { order.push('cua-second') })
    await Promise.resolve().then(() => { order.push('unrelated-host-service') })
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['cua-start', 'unrelated-host-service', 'cua-end', 'cua-second'])
  })

  it('contains adapter initialization failures without replacing other Host services or leaking details', () => {
    const errors: string[] = []
    const unrelatedService = () => 'available'
    const ctx = {
      logger: { error: (message: string) => errors.push(message) },
      on: () => () => {},
      effect: () => {},
      sessionController: {},
      sessionQuery: {},
      unrelatedService,
    } as unknown as HostContext & { unrelatedService: () => string }

    expect(() => apply(ctx, () => { throw new Error(`secret ${SECRET_FIXTURE}`) })).not.toThrow()
    expect(ctx.unrelatedService()).toBe('available')
    expect(errors).toEqual(['runwright-next-adapter: initialization failed'])
    expect(errors.join('\n')).not.toContain(SECRET_FIXTURE)
  })
})

describe('secret fixture regression across persisted audit and RPC', () => {
  it('keeps token material out of valid RPC results, failures, logs, and audit payloads', async () => {
    const value = await harness()
    const project = await value.registerProject()
    await value.createTask(project.id)
    const database = openDatabase(value.databasePath)
    const audits = database.prepare('SELECT payload_json FROM audits').all() as Array<{ payload_json: string }>
    database.close()
    const rpcFrames = await unauthorizedExchange(value.requireCore().server.address().port, `Bearer ${SECRET_FIXTURE}-wrong`)
    const validFrames = await authorizedProjectExchange(value.requireCore().server.address().port, `Bearer ${SECRET_FIXTURE}`)

    expect(audits.length).toBeGreaterThan(0)
    expect(JSON.parse(validFrames[1]!)).toMatchObject({ id: 'project-valid', result: { name: 'valid' } })
    expect(JSON.stringify(audits)).not.toContain(SECRET_FIXTURE)
    expect([...rpcFrames, ...validFrames].join('\n')).not.toContain(SECRET_FIXTURE)
    expect(JSON.stringify(project)).not.toContain(SECRET_FIXTURE)
  })
})
