import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { coreRequestSchema, coreResponseSchema } from '@runwright/contracts'
import type { CoreMethod, CoreRequest, CoreResponse, RuntimeEvent, RuntimeHello, RuntimeRunRef } from '@runwright/contracts'
import { assertRuntimeCapabilities } from './capabilities.js'

export interface CoreConnectionOptions {
  url: string
  tokenFile: string
  hello: RuntimeHello
  requestTimeoutMs?: number
  random?: () => number
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: CoreConnectionError) => void
  timeout: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

type EventWaiter = (result: IteratorResult<CoreRequest>) => void

export class CoreConnectionError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'CoreConnectionError'
  }
}

export class CoreConnection {
  readonly hello: RuntimeHello
  readonly events: AsyncIterable<CoreRequest>
  private socket: WebSocket | undefined
  private authenticated = false
  private disposed = false
  private startPromise: Promise<void> | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private reconnectAttempt = 0
  private readonly pending = new Map<string, PendingCall>()
  private readonly eventQueue: CoreRequest[] = []
  private readonly eventWaiters: EventWaiter[] = []
  private readonly requestTimeoutMs: number
  private readonly random: () => number

  constructor(private readonly options: CoreConnectionOptions) {
    this.hello = options.hello
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.random = options.random ?? Math.random
    this.events = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.nextEvent(),
      }),
    }
  }

  async start(): Promise<void> {
    if (this.disposed) throw new CoreConnectionError('CORE_CLOSED')
    this.startPromise ??= this.connect().catch((error: unknown) => {
      if (isRetryable(error)) this.scheduleReconnect()
      throw error
    })
    return await this.startPromise
  }

  async call<T = unknown>(method: CoreMethod, params: unknown, signal?: AbortSignal): Promise<T> {
    return await this.request<T>({ method, params }, signal)
  }

  private async request<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const socket = this.socket
    if (this.disposed) throw new CoreConnectionError('CORE_CLOSED')
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new CoreConnectionError('CORE_DISCONNECTED')
    }
    if (signal?.aborted) throw new CoreConnectionError('ABORTED')

    const id = randomUUID()
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new CoreConnectionError('REQUEST_TIMEOUT'))
      }, this.requestTimeoutMs)
      const cleanup = () => {
        clearTimeout(timeout)
        this.pending.delete(id)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new CoreConnectionError('ABORTED'))
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        ...(signal ? { signal, onAbort } : {}),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.send(JSON.stringify({ id, ...input }), (error) => {
        if (!error) return
        cleanup()
        reject(new CoreConnectionError('CORE_DISCONNECTED'))
      })
    })
  }

  respond(response: CoreResponse): void {
    const socket = this.socket
    if (this.disposed) throw new CoreConnectionError('CORE_CLOSED')
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new CoreConnectionError('CORE_DISCONNECTED')
    }
    socket.send(JSON.stringify(response))
  }

  async publish(ref: RuntimeRunRef, event: RuntimeEvent): Promise<void> {
    await this.request({
      type: 'event',
      runtimeId: ref.runtimeId,
      runId: ref.runId,
      event,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.authenticated = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close(1000)
    this.socket = undefined
    this.rejectPending(new CoreConnectionError('CORE_CLOSED'))
    for (const waiter of this.eventWaiters.splice(0)) waiter({ value: undefined, done: true })
  }

  private async connect(): Promise<void> {
    assertRuntimeCapabilities(this.hello)
    const url = parseLoopbackUrl(this.options.url)
    const token = readToken(this.options.tokenFile)
    const socket = new WebSocket(url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: CoreConnectionError) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => {
        socket.close(1008)
        finish(new CoreConnectionError('REQUEST_TIMEOUT'))
      }, this.requestTimeoutMs)

      socket.on('message', (data, isBinary) => {
        if (isBinary) return
        let input: unknown
        try {
          input = JSON.parse(data.toString())
        } catch {
          finish(new CoreConnectionError('PROTOCOL_ERROR'))
          socket.close(1008)
          return
        }
        const response = coreResponseSchema.safeParse(input)
        if (response.success) {
          if (!this.authenticated) {
            if (response.data.id !== 'hello') return
            if ('error' in response.data) {
              finish(new CoreConnectionError(response.data.error.code))
              socket.close(1008)
              return
            }
            const result = response.data.result
            if (typeof result !== 'object' || result === null || !('protocolMajor' in result)
              || result.protocolMajor !== 1) {
              finish(new CoreConnectionError('PROTOCOL_ERROR'))
              socket.close(1008)
              return
            }
            this.authenticated = true
            this.reconnectAttempt = 0
            finish()
            return
          }
          this.resolveCall(response.data)
          return
        }
        if (!this.authenticated) return
        const request = coreRequestSchema.safeParse(input)
        if (request.success) this.pushEvent(request.data)
      })
      socket.on('error', () => {
        if (!this.authenticated) {
          finish(new CoreConnectionError(this.disposed ? 'CORE_CLOSED' : 'CORE_DISCONNECTED'))
        }
      })
      socket.on('close', () => {
        finish(new CoreConnectionError(this.disposed ? 'CORE_CLOSED' : 'CORE_DISCONNECTED'))
        if (this.socket !== socket) return
        const reconnect = this.authenticated && !this.disposed
        this.authenticated = false
        this.socket = undefined
        this.rejectPending(new CoreConnectionError('CORE_DISCONNECTED'))
        if (reconnect) this.scheduleReconnect()
      })
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'hello',
          authorization: `Bearer ${token}`,
          hello: this.hello,
        }))
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = reconnectDelay(this.reconnectAttempt, this.random())
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((error: unknown) => {
        if (isRetryable(error)) this.scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref()
  }

  private nextEvent(): Promise<IteratorResult<CoreRequest>> {
    const event = this.eventQueue.shift()
    if (event) return Promise.resolve({ value: event, done: false })
    if (this.disposed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.eventWaiters.push(resolve))
  }

  private pushEvent(event: CoreRequest): void {
    const waiter = this.eventWaiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.eventQueue.push(event)
  }

  private resolveCall(response: CoreResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
    if ('error' in response) pending.reject(new CoreConnectionError(response.error.code, response.error.message))
    else pending.resolve(response.result)
  }

  private rejectPending(error: CoreConnectionError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function reconnectDelay(attempt: number, random: number): number {
  const base = Math.min(250 * 2 ** attempt, 5_000)
  return Math.min(5_000, base * (0.75 + random * 0.5))
}

function isRetryable(error: unknown): boolean {
  return error instanceof CoreConnectionError && ['CORE_DISCONNECTED', 'REQUEST_TIMEOUT'].includes(error.code)
}

function parseLoopbackUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'ws:' || !['127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new CoreConnectionError('NON_LOOPBACK_URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CoreConnectionError('INVALID_CORE_URL')
  }
  return url
}

function readToken(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new CoreConnectionError('TOKEN_FILE_PERMISSIONS')
    }
    const token = readFileSync(descriptor, 'utf8').trim()
    if (!token) throw new CoreConnectionError('TOKEN_FILE_EMPTY')
    return token
  } finally {
    closeSync(descriptor)
  }
}
