import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { CoreMethod, CoreRequest, RuntimeHello } from '@runwright/contracts'
import { startCore } from './composition.js'

const token = 'test-token-that-must-not-leak'
const runtimeHello: RuntimeHello = {
  protocolMajor: 1,
  adapterVersion: '0.1.0',
  runtimeId: 'next-local',
  runtimeKind: 'next',
  dshVersion: '0.2.1-rc.3',
  nextVersion: '2.0.20-next',
  capabilities: [
    'session.start',
    'session.attach',
    'session.cancel',
    'approval.forward',
    'validation.summary',
  ],
}

type Frame = Record<string, any>

class TestClient {
  private readonly pending = new Map<string, (frame: Frame) => void>()
  private readonly frames: Frame[] = []
  private readonly frameWaiters: Array<{
    predicate: (frame: Frame) => boolean
    resolve: (frame: Frame) => void
  }> = []

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame
      const id = typeof frame.id === 'string' ? frame.id : undefined
      const pending = id ? this.pending.get(id) : undefined
      if (id && pending) {
        this.pending.delete(id)
        pending(frame)
        return
      }
      const waiterIndex = this.frameWaiters.findIndex((waiter) => waiter.predicate(frame))
      const waiter = waiterIndex >= 0 ? this.frameWaiters.splice(waiterIndex, 1)[0] : undefined
      if (waiter) waiter.resolve(frame)
      else this.frames.push(frame)
    })
  }

  static async open(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const client = new TestClient(socket)
    clients.add(client)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return client
  }

  static async connect(port: number, credential?: string, hello?: RuntimeHello): Promise<TestClient> {
    const suppliedCredential = arguments.length >= 2 ? credential : token
    const client = await TestClient.open(port)
    try {
      await client.sendHello(suppliedCredential, hello)
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  async sendHello(credential: string | undefined, hello?: RuntimeHello): Promise<void> {
    const response = this.waitForFrame((frame) => frame.id === 'hello')
    this.send({
      type: 'hello',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      ...(hello ? { hello } : {}),
    })
    const frame = await response
    if (frame.error) {
      throw Object.assign(new Error(frame.error.message), { code: frame.error.code })
    }
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  async request<T = any>(method: CoreMethod, params: unknown = {}): Promise<T> {
    const id = randomUUID()
    const response = this.waitForFrame((frame) => frame.id === id)
    const request: CoreRequest = { id, method, params }
    this.send(request)
    const frame = await response
    if (frame.error) {
      throw Object.assign(new Error(frame.error.message), { code: frame.error.code, response: frame })
    }
    return frame.result as T
  }

  respond(id: string, result: unknown): void {
    this.send({ id, result })
  }

  async nextRequest(method: CoreMethod): Promise<CoreRequest> {
    return await this.waitForFrame((frame) => frame.method === method) as CoreRequest
  }

  waitForFrame(predicate: (frame: Frame) => boolean, timeoutMs = 1_000): Promise<Frame> {
    const index = this.frames.findIndex(predicate)
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]!)
    return new Promise<Frame>((resolve, reject) => {
      const waiter = { predicate, resolve }
      this.frameWaiters.push(waiter)
      const timeout = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter)
        if (index >= 0) this.frameWaiters.splice(index, 1)
        reject(new Error('Timed out waiting for frame'))
      }, timeoutMs)
      timeout.unref()
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }
}

let directory: string
let tokenFile: string
let databasePath: string
let core: Awaited<ReturnType<typeof startCore>> | undefined
const clients = new Set<TestClient>()

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'runwright-core-server-'))
  tokenFile = join(directory, 'token')
  databasePath = join(directory, 'core.db')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
})

afterEach(async () => {
  await core?.close()
  core = undefined
  await Promise.all([...clients].map((client) => client.close()))
  clients.clear()
  rmSync(directory, { recursive: true, force: true })
})

async function start(overrides: Record<string, unknown> = {}): Promise<void> {
  core = await startCore({
    tokenFile,
    databasePath,
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 100,
    handleSignals: false,
    ...overrides,
  })
}

function port(): number {
  if (!core) throw new Error('Core not started')
  return core.server.address().port
}

describe('loopback configuration and authentication', () => {
  it('binds only to loopback and rejects a non-loopback host', async () => {
    await start()
    expect(core!.server.address().address).toBe('127.0.0.1')
    await expect(startCore({
      tokenFile,
      databasePath: join(directory, 'other.db'),
      host: '0.0.0.0',
      port: 0,
      handleSignals: false,
    })).rejects.toThrow('NON_LOOPBACK_HOST')
  })

  it('requires a token file with exactly 0600 permissions', async () => {
    chmodSync(tokenFile, 0o640)
    await expect(start()).rejects.toThrow('TOKEN_FILE_PERMISSIONS')
  })

  it('rejects missing and incorrect Bearer credentials before business RPC', async () => {
    await start()
    await expect(TestClient.connect(port(), 'wrong')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(TestClient.connect(port(), undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const early = await TestClient.open(port())
    const response = early.waitForFrame((frame) => frame.id === 'early')
    early.send({ id: 'early', method: 'projects.register', params: { name: 'Nope', rootPath: '/nope' } })
    await expect(response).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })

    const client = await TestClient.connect(port())
    await expect(client.request('projects.list')).resolves.toEqual([])
  })
})

describe('validated RPC and stable errors', () => {
  it('rejects malformed requests without echoing secrets, stacks, or request content', async () => {
    await start()
    const client = await TestClient.connect(port())
    const secretPrompt = 'confidential prompt that must never appear in an error'
    const response = client.waitForFrame((frame) => frame.id === 'bad')
    client.send({
      id: 'bad',
      method: 'tasks.create',
      params: { projectId: 'project', prompt: secretPrompt, unexpected: true },
    })
    const frame = await response
    expect(frame.error).toEqual({ code: 'INVALID_REQUEST', message: 'Invalid request' })
    expect(JSON.stringify(frame)).not.toContain(secretPrompt)
    expect(JSON.stringify(frame)).not.toContain('stack')
  })

  it('reports an invalid runtime protocol as incompatible after valid authentication', async () => {
    await start()

    await expect(TestClient.connect(port(), token, {
      ...runtimeHello,
      protocolMajor: 2,
    } as unknown as RuntimeHello)).rejects.toMatchObject({ code: 'RUNTIME_INCOMPATIBLE' })
  })

  it('serves project and task RPC methods with persisted results', async () => {
    await start()
    const client = await TestClient.connect(port())
    const project = await client.request('projects.register', { name: 'Example', rootPath: '/tmp/example' })
    await expect(client.request('projects.list')).resolves.toEqual([project])

    const created = await client.request('tasks.create', {
      projectId: project.id,
      prompt: 'add parser',
    })
    expect(created.task).toMatchObject({ projectId: project.id, status: 'queued' })
    await expect(client.request('tasks.list', { projectId: project.id, status: 'queued' }))
      .resolves.toEqual([created.task])
    await expect(client.request('tasks.detail', { taskId: created.task.id })).resolves.toEqual(created)
    await expect(client.request('tasks.detail', { taskId: 'missing' })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    })
  })

  it('times out runtime requests with a stable error', async () => {
    await start({ requestTimeoutMs: 30 })
    await TestClient.connect(port(), token, runtimeHello)
    const pending = core!.runtime.getRunSnapshot({
      runtimeId: 'next-local',
      runId: 'run-1',
      sessionId: 'session-1',
    })
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})

describe('remote runtime RPC, events, and lifecycle', () => {
  it('bridges runtime start, attach, cancel, snapshot, and runtime.event frames', async () => {
    await start()
    const runtime = await TestClient.connect(port(), token, runtimeHello)
    const client = await TestClient.connect(port())
    const project = await client.request('projects.register', { name: 'Example', rootPath: '/tmp/example' })

    const creating = client.request('tasks.create', { projectId: project.id, prompt: 'add parser' })
    const startRequest = await runtime.nextRequest('runtime.start')
    expect(startRequest.params).toMatchObject({ project: { id: project.id }, prompt: 'add parser' })
    const runId = (startRequest.params as { runId: string }).runId
    const firstRef = { runtimeId: 'next-local', runId, sessionId: 'session-1' }
    runtime.respond(startRequest.id, firstRef)
    const created = await creating
    expect(created.runs[0]).toMatchObject({ status: 'running', sessionId: 'session-1' })

    const eventAck = runtime.waitForFrame(frame => frame.id === 'event-1')
    runtime.send({ type: 'event', id: 'event-1', runtimeId: 'next-local', runId, event: { seq: 1, type: 'run.succeeded', summary: 'done' } })
    await expect(eventAck).resolves.toEqual({ id: 'event-1', result: { seq: 1 } })
    const detail = await client.request('tasks.detail', { taskId: created.task.id })
    expect(detail.runs[0]).toMatchObject({ status: 'succeeded', lastEventSeq: 1 })

    const retrying = client.request('tasks.retry', { taskId: created.task.id })
    const retryStart = await runtime.nextRequest('runtime.start')
    const retryRunId = (retryStart.params as { runId: string }).runId
    const secondRef = { runtimeId: 'next-local', runId: retryRunId, sessionId: 'session-2' }
    runtime.respond(retryStart.id, secondRef)
    await expect(retrying).resolves.toMatchObject({ id: retryRunId, attempt: 2, status: 'running' })

    const snapshotting = core!.runtime.getRunSnapshot(secondRef)
    const snapshotRequest = await runtime.nextRequest('runtime.snapshot')
    expect(snapshotRequest.params).toEqual(secondRef)
    runtime.respond(snapshotRequest.id, { ref: secondRef, status: 'running', events: [] })
    await expect(snapshotting).resolves.toEqual({ ref: secondRef, status: 'running', events: [] })

    const recovering = core!.orchestrator.recover()
    const attachRequest = await runtime.nextRequest('runtime.attach')
    expect(attachRequest.params).toEqual({
      runId: retryRunId,
      sessionId: 'session-2',
      afterSeq: 0,
      project,
      policy: {
        allowedTools: [],
        requireApprovalFor: ['commit', 'push', 'deploy', 'external_message', 'outside_project'],
      },
    })
    runtime.respond(attachRequest.id, secondRef)
    await recovering

    const cancelling = client.request('tasks.cancel', { taskId: created.task.id })
    const cancelRequest = await runtime.nextRequest('runtime.cancel')
    expect(cancelRequest.params).toEqual(secondRef)
    runtime.respond(cancelRequest.id, null)
    await expect(cancelling).resolves.toMatchObject({ task: { status: 'running' } })
  })

  it('keeps the replacement runtime registered when an overlapping connection closes', async () => {
    await start()
    const first = await TestClient.connect(port(), token, runtimeHello)
    expect(first.socket.readyState).toBe(WebSocket.OPEN)

    const replacement = await TestClient.connect(port(), token, runtimeHello)

    expect(replacement.socket.readyState).toBe(WebSocket.OPEN)
    expect(() => core!.registry.resolve()).not.toThrow()
  })

  it('keeps Core available after NEXT disconnects and leaves new work queued', async () => {
    await start()
    const runtime = await TestClient.connect(port(), token, runtimeHello)
    const client = await TestClient.connect(port())
    const project = await client.request('projects.register', { name: 'Example', rootPath: '/tmp/example' })
    await runtime.close()

    await expect(client.request('projects.list')).resolves.toEqual([project])
    const created = await client.request('tasks.create', { projectId: project.id, prompt: 'offline work' })
    expect(created.task.status).toBe('queued')
    expect(core!.server.address().address).toBe('127.0.0.1')
  })
})
