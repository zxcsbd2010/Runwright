import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { CoreRequest, RuntimeHello } from '@runwright/contracts'
import { CoreConnection, reconnectDelay } from './core-connection.js'
import type { CoreConnectionOptions } from './core-connection.js'
import { createRuntimeHello, readPackageManifest } from './capabilities.js'

const token = 'task-six-test-token'
const capabilities = [
  'session.start',
  'session.attach',
  'session.cancel',
  'approval.forward',
  'validation.summary',
]

function hello(overrides: Partial<RuntimeHello> = {}): RuntimeHello {
  return {
    protocolMajor: 1,
    adapterVersion: '0.1.0',
    runtimeId: 'next-local',
    runtimeKind: 'next',
    dshVersion: '0.2.1-rc.3',
    nextVersion: '0.2.1-rc.3',
    capabilities,
    ...overrides,
  }
}

type Frame = Record<string, any>

class FakeCore {
  readonly frames: Frame[] = []
  readonly sockets = new Set<WebSocket>()
  connections = 0
  helloError: string | undefined
  ignoreHello = false
  ignoreRequests = false
  private readonly server: WebSocketServer

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.server.on('connection', (socket) => {
      this.connections++
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Frame
        this.frames.push(frame)
        if (frame.type === 'hello') {
          if (this.ignoreHello) return
          if (this.helloError) {
            socket.send(JSON.stringify({
              id: 'hello',
              error: { code: this.helloError, message: 'Handshake rejected' },
            }), () => socket.close(1008))
          } else {
            socket.send(JSON.stringify({ id: 'hello', result: { protocolMajor: 1 } }))
          }
          return
        }
        if (!this.ignoreRequests && frame.method === 'projects.list') {
          socket.send(JSON.stringify({ id: frame.id, result: [] }))
        }
      })
    })
  }

  async start(): Promise<void> {
    if (this.server.address()) return
    await new Promise<void>((resolve) => this.server.once('listening', resolve))
  }

  get url(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Fake Core is not listening')
    return `ws://127.0.0.1:${address.port}`
  }

  requests(): CoreRequest[] {
    return this.frames.filter((frame) => typeof frame.method === 'string') as CoreRequest[]
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let directory: string
let tokenFile: string
let core: FakeCore
let connection: CoreConnection | undefined

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'runwright-adapter-'))
  tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  core = new FakeCore()
  await core.start()
})

afterEach(async () => {
  connection?.dispose()
  connection = undefined
  await core.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

function options(overrides: Partial<CoreConnectionOptions> = {}): CoreConnectionOptions {
  return {
    url: core.url,
    tokenFile,
    hello: hello(),
    requestTimeoutMs: 50,
    ...overrides,
  }
}

describe('CoreConnection handshake and security', () => {
  it('accepts only literal loopback ws URLs and a private local token file', async () => {
    connection = new CoreConnection(options({ url: 'ws://0.0.0.0:47832' }))
    await expect(connection.start()).rejects.toThrow('NON_LOOPBACK_URL')
    expect(core.connections).toBe(0)

    chmodSync(tokenFile, 0o640)
    connection = new CoreConnection(options())
    await expect(connection.start()).rejects.toThrow('TOKEN_FILE_PERMISSIONS')
    expect(core.connections).toBe(0)
  })

  it('sends Bearer authentication and the complete runtime hello in the first frame', async () => {
    connection = new CoreConnection(options())
    await connection.start()

    expect(core.frames[0]).toEqual({
      type: 'hello',
      authorization: `Bearer ${token}`,
      hello: hello(),
    })
    expect(connection.hello).toEqual(hello())
    await expect(connection.call('projects.list', {})).resolves.toEqual([])
    expect(core.requests()[0]?.method).toBe('projects.list')
  })

  it('refuses to advertise a runtime when any required capability is missing', async () => {
    connection = new CoreConnection(options({
      hello: hello({ capabilities: capabilities.slice(0, -1) }),
    }))

    await expect(connection.start()).rejects.toThrow('CAPABILITIES_UNAVAILABLE')
    expect(core.connections).toBe(0)
  })

  it('treats protocol incompatibility as fatal instead of reconnecting', async () => {
    core.helloError = 'RUNTIME_INCOMPATIBLE'
    connection = new CoreConnection(options())

    await expect(connection.start()).rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(core.connections).toBe(1)
  })
})

describe('runtime manifest reporting', () => {
  it('reads adapter, NEXT, and DSH versions from package manifests', () => {
    const adapterManifest = readPackageManifest(new URL('../../package.json', import.meta.url))
    const nextPath = join(directory, 'next-package.json')
    const dshPath = join(directory, 'dsh-package.json')
    writeFileSync(nextPath, JSON.stringify({ name: 'next', version: '0.2.1-rc.3' }))
    writeFileSync(dshPath, JSON.stringify({ name: 'dsh', version: '0.2.1-rc.3' }))

    const reported = createRuntimeHello({
      adapterManifest,
      nextManifest: readPackageManifest(nextPath),
      dshManifest: readPackageManifest(dshPath),
      runtimeId: 'next-local',
      capabilities,
    })

    expect(reported).toEqual(hello({ adapterVersion: adapterManifest.version }))
    expect(reported.adapterVersion).toBe('0.1.2')
  })
})

describe('CoreConnection calls', () => {
  it('times out unresolved calls and supports caller cancellation', async () => {
    core.ignoreRequests = true
    connection = new CoreConnection(options({ requestTimeoutMs: 30 }))
    await connection.start()

    await expect(connection.call('projects.list', {})).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })

    const controller = new AbortController()
    const pending = connection.call('projects.list', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('waits for Core to acknowledge each published runtime event', async () => {
    connection = new CoreConnection(options({ requestTimeoutMs: 30 }))
    await connection.start()

    await expect(connection.publish(
      { runtimeId: 'next-local', runId: 'run-1', sessionId: 'session-1' },
      { seq: 1, type: 'run.started' },
    )).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })

    connection.dispose()
    connection = new CoreConnection(options({ requestTimeoutMs: 1_000 }))
    await connection.start()
    const published = connection.publish(
      { runtimeId: 'next-local', runId: 'run-1', sessionId: 'session-1' },
      { seq: 2, type: 'run.succeeded', summary: 'done' },
    )
    await vi.waitFor(() => {
      const frame = core.frames.findLast(frame => frame.type === 'event')
      expect(frame).toMatchObject({ type: 'event', event: { seq: 2 } })
      ;[...core.sockets][0]!.send(JSON.stringify({ id: frame!.id, result: { seq: 2 } }))
    })
    await expect(published).resolves.toBeUndefined()
  })

  it('exposes validated runtime requests as events and sends their responses', async () => {
    connection = new CoreConnection(options())
    await connection.start()
    const events = connection.events[Symbol.asyncIterator]()
    const next = events.next()
    const socket = [...core.sockets][0]!
    socket.send(JSON.stringify({
      id: 'runtime-request-1',
      method: 'runtime.snapshot',
      params: { runtimeId: 'next-local', runId: 'run-1', sessionId: 'session-1' },
    }))

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        id: 'runtime-request-1',
        method: 'runtime.snapshot',
        params: { runtimeId: 'next-local', runId: 'run-1', sessionId: 'session-1' },
      },
    })
    connection.respond({ id: 'runtime-request-1', result: { status: 'running' } })
    await vi.waitFor(() => {
      expect(core.frames).toContainEqual({ id: 'runtime-request-1', result: { status: 'running' } })
    })
  })
})

describe('CoreConnection reconnection and disposal', () => {
  it('reconnects after disconnect and computes bounded exponential backoff with jitter', async () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => reconnectDelay(attempt, 0.5)))
      .toEqual([250, 500, 1000, 2000, 4000, 5000])
    expect(reconnectDelay(0, 0)).toBe(187.5)
    expect(reconnectDelay(0, 1)).toBe(312.5)
    expect(reconnectDelay(20, 1)).toBe(5000)

    connection = new CoreConnection(options({ random: () => 0.5 }))
    await connection.start()
    ;[...core.sockets][0]!.terminate()
    await vi.waitFor(() => expect(core.connections).toBe(2), { timeout: 1_000 })
  })

  it('dispose rejects pending calls and prevents reconnect timers', async () => {
    core.ignoreRequests = true
    connection = new CoreConnection(options())
    await connection.start()
    const pending = connection.call('projects.list', {})
    vi.useFakeTimers()
    ;[...core.sockets][0]!.terminate()
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).rejects.toMatchObject({ code: 'CORE_DISCONNECTED' })

    connection.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(core.connections).toBe(1)
    await expect(connection.call('projects.list', {})).rejects.toMatchObject({ code: 'CORE_CLOSED' })
  })

  it('settles an in-flight handshake immediately when disposed', async () => {
    core.ignoreHello = true
    connection = new CoreConnection(options({ requestTimeoutMs: 10_000 }))
    const starting = connection.start()

    connection.dispose()
    await expect(starting).rejects.toMatchObject({ code: 'CORE_CLOSED' })
  })
})
