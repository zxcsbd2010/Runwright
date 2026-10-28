import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreRequest, Project, RuntimeHello, TaskDetail } from '@runwright/contracts'
import { startCore } from '../../../apps/core/src/index.js'
import type { StartedCore } from '../../../apps/core/src/index.js'
import {
  CoreConnection,
  ExecutionGuard,
  SessionLedger,
  createHostRuntime,
  createRuntimeHello,
  requiredRuntimeCapabilities,
} from '../../../packages/next-adapter/src/index.js'
import type { HostRuntime, HostRuntimeHost } from '../../../packages/next-adapter/src/index.js'
import type { DshSessionEvent, SessionFollowFrame } from '../../../packages/next-adapter/src/index.js'

export const SECRET_FIXTURE = 'rw-secret-fixture-9f27c1'

export interface FakeSession {
  cwd: string
  events: DshSessionEvent[]
}

interface FollowChannel {
  push(event: DshSessionEvent): void
  close(): void
}

class Channel<T> implements FollowChannel {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}

/** Only the verified DSH SessionController and SessionQuery surfaces used by the adapter. */
export class FakeNext implements HostRuntimeHost {
  readonly sessions = new Map<string, FakeSession>()
  readonly createCalls: Array<{ sessionId: string; cwd: string }> = []
  readonly promptCalls: Array<{ requestId: string; sessionId: string }> = []
  readonly cancelCalls: string[] = []
  readonly channels = new Set<Channel<DshSessionEvent>>()
  beforeCreate: (() => void | Promise<void>) | undefined
  afterCreate: (() => void | Promise<void>) | undefined
  afterPrompt: (() => void | Promise<void>) | undefined
  beforeCancel: (() => void | Promise<void>) | undefined
  afterCancel: (() => void | Promise<void>) | undefined
  followError: Error | undefined

  readonly sessionController = {
    create: async (request: { sessionId: string; cwd: string }) => {
      this.createCalls.push(request)
      await this.beforeCreate?.()
      if (this.sessions.has(request.sessionId)) throw Object.assign(new Error('occupied'), { code: 'SESSION_EXISTS' })
      this.sessions.set(request.sessionId, { cwd: request.cwd, events: [] })
      await this.afterCreate?.()
      return { sessionId: request.sessionId }
    },
    prompt: async (request: {
      requestId: string
      sessionId: string
      mode: 'queue'
      content: Array<{ type: 'text'; text: string }>
    }) => {
      this.promptCalls.push({ requestId: request.requestId, sessionId: request.sessionId })
      const session = this.requireSession(request.sessionId)
      session.events.push({
        seq: nextSeq(session),
        time: 1_792_000_000_000,
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: `message-${this.promptCalls.length}`, source: { kind: 'user', rpcId: request.requestId } }],
        },
      })
      await this.afterPrompt?.()
      return { accepted: true as const }
    },
    cancel: async (request: { sessionId: string }) => {
      await this.beforeCancel?.()
      this.requireSession(request.sessionId)
      this.cancelCalls.push(request.sessionId)
      await this.afterCancel?.()
    },
    follow: (request: { address: { kind: 'session'; sessionId: string } }, signal: AbortSignal) => {
      const channel = new Channel<DshSessionEvent>()
      this.channels.add(channel)
      signal.addEventListener('abort', () => channel.close(), { once: true })
      return (async function* (next: FakeNext): AsyncGenerator<SessionFollowFrame> {
        if (next.followError) throw next.followError
        const session = next.requireSession(request.address.sessionId)
        yield {
          type: 'snapshot',
          header: { version: 0, id: request.address.sessionId, createdAt: 1, cwd: session.cwd },
          cursor: session.events.at(-1)?.seq ?? -1,
          records: structuredClone(session.events).map(event => ({ type: 'event' as const, event })),
          hasMore: false,
          projections: { asOfSeq: session.events.at(-1)?.seq ?? -1, values: {} },
        }
        try {
          for await (const event of channel) yield { type: 'event', event }
        } finally {
          next.channels.delete(channel)
        }
      })(this)
    },
  }

  readonly sessionQuery = {
    observeSession: async (sessionId: string) => {
      const session = this.sessions.get(sessionId)
      if (!session) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return {
        header: { cwd: session.cwd },
        events: structuredClone(session.events),
        cursor: session.events.at(-1)?.seq ?? -1,
        [Symbol.dispose]: () => {},
      }
    },
  }

  emit(sessionId: string, type = 'turn/start', data: unknown = { turn: 1 }): DshSessionEvent {
    const session = this.requireSession(sessionId)
    const event = { seq: nextSeq(session), time: 1_792_000_000_000, type, data }
    session.events.push(event)
    for (const channel of this.channels) channel.push(event)
    return event
  }

  closeFollows(): void {
    for (const channel of this.channels) channel.close()
  }

  userMessages(): number {
    return [...this.sessions.values()].flatMap(session => session.events).filter(event =>
      event.type === 'user/message' || event.type === 'agent/inbox/spliced').length
  }

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    return session
  }
}

function nextSeq(session: FakeSession): number {
  return (session.events.at(-1)?.seq ?? -1) + 1
}

export function runtimeHello(overrides: Partial<RuntimeHello> = {}): RuntimeHello {
  return {
    ...createRuntimeHello({
      adapterManifest: { version: '0.1.0' },
      nextManifest: { version: '2.0.20-next' },
      dshManifest: { version: '0.2.1-rc.4' },
      runtimeId: 'next-local',
      capabilities: requiredRuntimeCapabilities,
    }),
    ...overrides,
  }
}

export class IntegrationHarness {
  readonly root: string
  readonly tokenFile: string
  readonly databasePath: string
  readonly ledgerPath: string
  readonly projectRoot: string
  readonly next = new FakeNext()
  core: StartedCore | undefined
  connection: CoreConnection | undefined
  runtime: HostRuntime | undefined
  guard: ExecutionGuard | undefined
  private requestLoop: Promise<void> | undefined
  private port = 0

  private constructor(root: string) {
    this.root = root
    this.tokenFile = join(root, 'token')
    this.databasePath = join(root, 'core.db')
    this.ledgerPath = join(root, 'next-sessions.json')
    this.projectRoot = join(root, 'project')
  }

  static async create(): Promise<IntegrationHarness> {
    const root = await mkdtemp(join(tmpdir(), 'runwright-integration-'))
    const harness = new IntegrationHarness(root)
    await writeFile(harness.tokenFile, SECRET_FIXTURE, { mode: 0o600 })
    await harness.startCore()
    return harness
  }

  async startCore(): Promise<void> {
    if (this.core) return
    this.core = await startCore({
      tokenFile: this.tokenFile,
      databasePath: this.databasePath,
      port: this.port,
      handleSignals: false,
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 100,
    })
    this.port = this.core.server.address().port
  }

  async stopCore(): Promise<void> {
    const core = this.core
    this.core = undefined
    await core?.close()
  }

  async startAdapter(hello = runtimeHello()): Promise<void> {
    if (this.connection) return
    const connection = new CoreConnection({
      url: `ws://127.0.0.1:${this.port}`,
      tokenFile: this.tokenFile,
      hello,
      requestTimeoutMs: 500,
      random: () => 0,
    })
    const guard = new ExecutionGuard()
    const runtime = createHostRuntime(this.next, connection, guard, this.ledgerPath)
    this.connection = connection
    this.runtime = runtime
    this.guard = guard
    await connection.start()
    this.requestLoop = runtime.runRequests().catch(() => {})
  }

  crashAdapter(): void {
    this.runtime?.dispose()
    this.connection?.dispose()
    this.next.closeFollows()
  }

  async stopAdapter(): Promise<void> {
    const connection = this.connection
    const runtime = this.runtime
    this.connection = undefined
    this.runtime = undefined
    this.guard = undefined
    runtime?.dispose()
    connection?.dispose()
    this.next.closeFollows()
    await this.requestLoop
    this.requestLoop = undefined
  }

  async registerProject(): Promise<Project> {
    return await this.requireCore().store.registerProject({ name: 'Integration', rootPath: this.projectRoot })
  }

  async createTask(projectId: string, prompt = 'implement once'): Promise<TaskDetail> {
    return await this.requireCore().store.createTask({ projectId, prompt })
  }

  async dispatch(runId: string): Promise<void> {
    await this.requireCore().orchestrator.dispatch(runId)
  }

  async detail(taskId: string): Promise<TaskDetail> {
    return await this.requireCore().store.getDetail(taskId)
  }

  async close(): Promise<void> {
    await this.stopAdapter()
    await this.stopCore()
    await rm(this.root, { recursive: true, force: true })
  }

  requireCore(): StartedCore {
    if (!this.core) throw new Error('CORE_NOT_STARTED')
    return this.core
  }
}

export function once(work: () => void | Promise<void>): () => Promise<void> {
  let pending = true
  return async () => {
    if (!pending) return
    pending = false
    await work()
  }
}

export type { CoreRequest, SessionLedger }
