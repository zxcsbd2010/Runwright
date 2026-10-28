import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import {
  attachRunInputSchema,
  coreRequestSchema,
  coreResponseSchema,
  runSnapshotSchema,
  runtimeEventFrameSchema,
  runtimeHelloSchema,
  runtimeRunRefSchema,
  startRunInputSchema,
  taskStatusSchema,
} from '@runwright/contracts'
import type {
  AttachRunInput,
  CoreMethod,
  CoreRequest,
  CoreResponse,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeHello,
  RuntimeRunRef,
  RunSnapshot,
  StartRunInput,
} from '@runwright/contracts'
import type { Orchestrator } from './orchestrator.js'
import type { RuntimeRegistry } from './runtime-registry.js'
import type { CoreStore } from './store.js'

const helloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  authorization: z.string(),
  hello: z.unknown().optional(),
})

const idSchema = z.string().min(1)
const requestParamsSchemas: Record<CoreMethod, z.ZodType> = {
  'projects.list': z.strictObject({}),
  'projects.register': z.strictObject({ name: z.string().trim().min(1), rootPath: z.string().min(1) }),
  'tasks.create': z.strictObject({ projectId: idSchema, prompt: z.string().trim().min(1) }),
  'tasks.list': z.strictObject({ projectId: idSchema.optional(), status: taskStatusSchema.optional() }),
  'tasks.detail': z.strictObject({ taskId: idSchema }),
  'tasks.cancel': z.strictObject({ taskId: idSchema }),
  'tasks.retry': z.strictObject({ taskId: idSchema }),
  'runtime.start': startRunInputSchema,
  'runtime.attach': attachRunInputSchema,
  'runtime.cancel': runtimeRunRefSchema,
  'runtime.snapshot': runtimeRunRefSchema,
}

const errorMessages: Record<string, string> = {
  UNAUTHORIZED: 'Unauthorized',
  INVALID_REQUEST: 'Invalid request',
  REQUEST_TIMEOUT: 'Request timed out',
  RUNTIME_UNAVAILABLE: 'Runtime unavailable',
  RUNTIME_INCOMPATIBLE: 'Runtime incompatible',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  TASK_NOT_FOUND: 'Task not found',
  RUN_NOT_FOUND: 'Run not found',
  RUN_STILL_ACTIVE: 'Run still active',
  CORE_CLOSED: 'Core closed',
  INTERNAL_ERROR: 'Internal error',
}

class StableCoreError extends Error {
  constructor(readonly code: string) {
    super(errorMessages[code] ?? errorMessages.INTERNAL_ERROR)
    this.name = 'StableCoreError'
  }
}

type RuntimeMethod = 'runtime.start' | 'runtime.attach' | 'runtime.cancel' | 'runtime.snapshot'

interface RuntimeTransport {
  request(method: RuntimeMethod, params: unknown): Promise<unknown>
}

interface EventStream {
  events: RuntimeEvent[]
  waiting: (() => void) | undefined
  closed: boolean
}

export class RemoteRuntimeDriver implements RuntimeDriver {
  private transport: RuntimeTransport | undefined
  private readonly streams = new Map<string, EventStream>()
  private readonly subscriptions = new Set<Promise<void>>()
  private readonly deliveries = new Map<RuntimeEvent, {
    resolve: () => void
    reject: (error: unknown) => void
  }>()

  setTransport(transport: RuntimeTransport | undefined): void {
    this.transport = transport
  }

  async startRun(input: StartRunInput): Promise<RuntimeRunRef> {
    return await this.request('runtime.start', input, runtimeRunRefSchema)
  }

  async attachRun(input: AttachRunInput): Promise<RuntimeRunRef> {
    return await this.request('runtime.attach', input, runtimeRunRefSchema)
  }

  async cancelRun(ref: RuntimeRunRef): Promise<void> {
    await this.request('runtime.cancel', ref, z.null())
  }

  async getRunSnapshot(ref: RuntimeRunRef): Promise<RunSnapshot> {
    return await this.request('runtime.snapshot', ref, runSnapshotSchema)
  }

  subscribe(ref: RuntimeRunRef): AsyncIterable<RuntimeEvent> {
    let stream = this.streams.get(ref.runId)
    if (!stream || stream.closed) {
      stream = { events: [], waiting: undefined, closed: false }
      this.streams.set(ref.runId, stream)
    }
    const current = stream
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => { finish = resolve })
    this.subscriptions.add(done)
    const finishOnce = () => {
      if (!this.subscriptions.delete(done)) return
      finish()
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<RuntimeEvent>> => {
          for (;;) {
            const event = current.events.shift()
            if (event) return { value: event, done: false }
            if (current.closed) {
              finishOnce()
              return { value: undefined, done: true }
            }
            await new Promise<void>((resolve) => { current.waiting = resolve })
            current.waiting = undefined
          }
        },
        return: async (): Promise<IteratorResult<RuntimeEvent>> => {
          current.closed = true
          current.waiting?.()
          finishOnce()
          return { value: undefined, done: true }
        },
      }),
    }
  }

  async publish(runId: string, event: RuntimeEvent): Promise<void> {
    let stream = this.streams.get(runId)
    if (!stream || stream.closed) {
      stream = { events: [], waiting: undefined, closed: false }
      this.streams.set(runId, stream)
    }
    const delivered = new Promise<void>((resolve, reject) => {
      this.deliveries.set(event, { resolve, reject })
    })
    stream.events.push(event)
    stream.waiting?.()
    await delivered
  }

  acknowledge(_ref: RuntimeRunRef, event: RuntimeEvent, error?: unknown): void {
    const delivery = this.deliveries.get(event)
    if (!delivery) return
    this.deliveries.delete(event)
    if (error === undefined) delivery.resolve()
    else delivery.reject(error)
  }

  closeStreams(): void {
    for (const stream of this.streams.values()) {
      stream.closed = true
      stream.waiting?.()
    }
    for (const delivery of this.deliveries.values()) delivery.reject(new StableCoreError('RUNTIME_UNAVAILABLE'))
    this.deliveries.clear()
  }

  async drain(): Promise<void> {
    await Promise.all([...this.subscriptions])
  }

  private async request<T>(method: RuntimeMethod, params: unknown, schema: z.ZodType<T>): Promise<T> {
    if (!this.transport) throw new StableCoreError('RUNTIME_UNAVAILABLE')
    const result = await this.transport.request(method, params)
    const parsed = schema.safeParse(result)
    if (!parsed.success) throw new StableCoreError('INTERNAL_ERROR')
    return parsed.data
  }
}

interface ConnectionState {
  socket: WebSocket
  authenticated: boolean
  hello: RuntimeHello | undefined
}

interface PendingRuntimeRequest {
  state: ConnectionState
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export interface RuntimeServerOptions {
  host: '127.0.0.1'
  port: number
  token: string
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  store: CoreStore
  orchestrator: Orchestrator
  registry: RuntimeRegistry
  runtime: RemoteRuntimeDriver
}

export class RuntimeServer {
  private readonly http: HttpServer
  private readonly sockets = new Set<ConnectionState>()
  private readonly pending = new Map<string, PendingRuntimeRequest>()
  private readonly inFlight = new Set<Promise<void>>()
  private runtimeState: ConnectionState | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  private readonly wss: WebSocketServer

  constructor(private readonly options: RuntimeServerOptions) {
    this.http = createServer((_, response) => {
      response.writeHead(426)
      response.end()
    })
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 1024 * 1024 })
    this.wss.on('connection', (socket) => this.accept(socket))
    this.options.runtime.setTransport({
      request: (method, params) => this.requestRuntime(method, params),
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off('error', reject)
        resolve()
      })
    })
  }

  address(): AddressInfo {
    const address = this.http.address()
    if (!address || typeof address === 'string') throw new Error('SERVER_NOT_LISTENING')
    return address
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise
    this.closePromise = this.performClose()
    return await this.closePromise
  }

  private async performClose(): Promise<void> {
    this.closing = true
    this.options.runtime.setTransport(undefined)
    this.options.runtime.closeStreams()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new StableCoreError('CORE_CLOSED'))
    }
    this.pending.clear()

    const wssClosed = new Promise<void>((resolve) => this.wss.close(() => resolve()))
    const httpClosed = new Promise<void>((resolve) => this.http.close(() => resolve()))
    await Promise.all([...this.sockets].map((state) => this.closeSocket(state.socket)))
    await Promise.all([wssClosed, httpClosed])
    await Promise.all([...this.inFlight])
    await this.options.runtime.drain()
  }

  private accept(socket: WebSocket): void {
    const state: ConnectionState = { socket, authenticated: false, hello: undefined }
    this.sockets.add(state)
    socket.on('message', (data, isBinary) => {
      this.track(this.onMessage(state, data, isBinary))
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(state)
      for (const [id, pending] of this.pending) {
        if (pending.state !== state) continue
        clearTimeout(pending.timeout)
        this.pending.delete(id)
        pending.reject(new StableCoreError('RUNTIME_UNAVAILABLE'))
      }
      if (this.runtimeState === state) {
        this.runtimeState = undefined
        this.options.runtime.setTransport(this.closing ? undefined : {
          request: (method, params) => this.requestRuntime(method, params),
        })
        this.options.runtime.closeStreams()
        if (state.hello) this.options.registry.accept({ ...state.hello, capabilities: [] })
      }
    })
  }

  private async onMessage(state: ConnectionState, data: RawData, isBinary: boolean): Promise<void> {
    let input: unknown
    try {
      if (isBinary) throw new Error('binary')
      input = JSON.parse(data.toString())
    } catch {
      this.sendError(state.socket, 'request', new StableCoreError('INVALID_REQUEST'))
      return
    }

    if (!state.authenticated) {
      await this.authenticate(state, input)
      return
    }

    const response = coreResponseSchema.safeParse(input)
    if (response.success && this.pending.has(response.data.id)) {
      this.resolveRuntimeResponse(state, response.data)
      return
    }

    const event = runtimeEventFrameSchema.safeParse(input)
    if (event.success) {
      if (this.runtimeState !== state || state.hello?.runtimeId !== event.data.runtimeId) {
        this.sendError(state.socket, event.data.id, new StableCoreError('RUNTIME_UNAVAILABLE'))
        return
      }
      try {
        await this.options.runtime.publish(event.data.runId, event.data.event)
        this.send(state.socket, { id: event.data.id, result: { seq: event.data.event.seq } })
      } catch (error) {
        this.sendError(state.socket, event.data.id, error)
      }
      return
    }

    const request = coreRequestSchema.safeParse(input)
    if (!request.success) {
      this.sendError(state.socket, this.responseId(input), new StableCoreError('INVALID_REQUEST'))
      return
    }
    if (this.closing) {
      this.sendError(state.socket, request.data.id, new StableCoreError('SERVICE_UNAVAILABLE'))
      return
    }
    await this.onRequest(state.socket, request.data)
  }

  private async authenticate(state: ConnectionState, input: unknown): Promise<void> {
    const hello = helloFrameSchema.safeParse(input)
    if (!hello.success || !this.tokenMatches(hello.success ? hello.data.authorization : undefined)) {
      const isHello = typeof input === 'object' && input !== null && 'type' in input && input.type === 'hello'
      this.sendError(state.socket, isHello ? 'hello' : this.responseId(input), new StableCoreError('UNAUTHORIZED'), true)
      return
    }
    if (hello.data.hello !== undefined) {
      const parsed = runtimeHelloSchema.safeParse(hello.data.hello)
      if (!parsed.success || !this.options.registry.accept(parsed.data)) {
        this.sendError(state.socket, 'hello', new StableCoreError('RUNTIME_INCOMPATIBLE'), true)
        return
      }
      state.hello = parsed.data
    }

    state.authenticated = true
    if (state.hello) {
      const previous = this.runtimeState
      this.runtimeState = state
      if (previous && previous !== state) await this.closeSocket(previous.socket)
      this.track(this.options.orchestrator.recover().catch(() => {}))
    }
    this.send(state.socket, { id: 'hello', result: { protocolMajor: 1 } })
  }

  private async onRequest(socket: WebSocket, request: CoreRequest): Promise<void> {
    try {
      const params = requestParamsSchemas[request.method].safeParse(request.params)
      if (!params.success || request.method.startsWith('runtime.')) {
        throw new StableCoreError('INVALID_REQUEST')
      }
      const result = await this.withTimeout(this.dispatch(request.method, params.data))
      this.send(socket, { id: request.id, result })
    } catch (error) {
      this.sendError(socket, request.id, error)
    }
  }

  private async dispatch(method: CoreMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'projects.list':
        return await this.options.store.listProjects()
      case 'projects.register':
        return await this.options.store.registerProject(params as { name: string; rootPath: string })
      case 'tasks.create': {
        const detail = await this.options.store.createTask(params as { projectId: string; prompt: string })
        const run = detail.runs[0]
        if (!run) throw new StableCoreError('INTERNAL_ERROR')
        await this.options.orchestrator.dispatch(run.id)
        return await this.options.store.getDetail(detail.task.id)
      }
      case 'tasks.list':
        return await this.options.store.listTasks(params as NonNullable<Parameters<CoreStore['listTasks']>[0]>)
      case 'tasks.detail':
        return await this.options.store.getDetail((params as { taskId: string }).taskId)
      case 'tasks.cancel': {
        const taskId = (params as { taskId: string }).taskId
        await this.options.orchestrator.cancel(taskId)
        return await this.options.store.getDetail(taskId)
      }
      case 'tasks.retry': {
        const run = await this.options.store.retry((params as { taskId: string }).taskId)
        await this.options.orchestrator.dispatch(run.id)
        return (await this.options.store.getRunContext(run.id)).run
      }
      default:
        throw new StableCoreError('INVALID_REQUEST')
    }
  }

  private requestRuntime(method: RuntimeMethod, params: unknown): Promise<unknown> {
    const state = this.runtimeState
    if (this.closing || !state || state.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new StableCoreError('RUNTIME_UNAVAILABLE'))
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new StableCoreError('REQUEST_TIMEOUT'))
      }, this.options.requestTimeoutMs)
      this.pending.set(id, { state, resolve, reject, timeout })
      state.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new StableCoreError('RUNTIME_UNAVAILABLE'))
      })
    })
  }

  private resolveRuntimeResponse(state: ConnectionState, response: CoreResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    if (pending.state !== state || this.runtimeState !== state) {
      this.sendError(state.socket, response.id, new StableCoreError('INVALID_REQUEST'))
      return
    }
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if ('error' in response) pending.reject(new StableCoreError(response.error.code))
    else pending.resolve(response.result)
  }

  private tokenMatches(authorization: string | undefined): boolean {
    const expected = Buffer.from(this.options.token)
    const supplied = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '')
    const sameLength = supplied.length === expected.length
    const compared = timingSafeEqual(sameLength ? supplied : expected, expected)
    return sameLength && compared
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new StableCoreError('REQUEST_TIMEOUT')), this.options.requestTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private sendError(socket: WebSocket, id: string, error: unknown, close = false): void {
    const stable = this.stableError(error)
    this.send(socket, { id, error: { code: stable.code, message: stable.message } }, close)
  }

  private stableError(error: unknown): StableCoreError {
    if (error instanceof StableCoreError) return error
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) && errorMessages[error.message]) {
      return new StableCoreError(error.message)
    }
    return new StableCoreError('INTERNAL_ERROR')
  }

  private send(socket: WebSocket, frame: CoreResponse, close = false): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame), () => {
      if (close) socket.close(1008)
    })
  }

  private responseId(input: unknown): string {
    if (typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string') {
      return input.id
    }
    return 'request'
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work)
    void work.finally(() => this.inFlight.delete(work))
  }

  private async closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => socket.terminate(), this.options.shutdownTimeoutMs)
      timeout.unref()
      socket.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      socket.close(1012)
    })
  }
}
