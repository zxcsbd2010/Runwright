import { createHash } from 'node:crypto'
import type { AttachRunInput, RuntimeRunRef, StartRunInput } from '@runwright/contracts'
import type { SessionLedger } from './session-ledger.js'

const SESSION_NAMESPACE = '2a4bd4e6-159c-4f1f-a9f2-b6b1877c26a1'
const PROMPT_NAMESPACE = '2a4bd4e6-159c-4f1f-a9f2-b6b1877c26a2'

interface SessionController {
  create(request: { sessionId: string; cwd: string }): Promise<{ sessionId: string }>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue'
    content: Array<{ type: 'text'; text: string }>
  }, signal: AbortSignal): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): void | Promise<void>
}

interface SessionObservation extends Disposable {
  header: { cwd?: string }
  events: readonly SessionEvent[]
  cursor: number
}

interface SessionQuery {
  observeSession(
    sessionId: string,
    options: { projectionMode: 'none' },
  ): Promise<SessionObservation>
}

export interface SessionBridgeHost {
  sessionController: SessionController
  sessionQuery: SessionQuery
}

export interface SessionEvent {
  type: string
  data: unknown
}

export interface SessionSnapshot {
  ref: RuntimeRunRef
  events: readonly SessionEvent[]
  cursor: number
}

interface ObservedSession {
  events: readonly SessionEvent[]
  cursor: number
  cwd: string | undefined
}

export class SessionBridgeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SessionBridgeError'
  }
}

export function sessionIdForRun(runId: string): string {
  return uuidV5(SESSION_NAMESPACE, runId)
}

export function requestIdForRun(runId: string): string {
  return uuidV5(PROMPT_NAMESPACE, runId)
}

export class SessionBridge {
  private readonly locks = new Map<string, Promise<RuntimeRunRef>>()
  private readonly runtimeId: string

  constructor(
    private readonly host: SessionBridgeHost,
    private readonly options: { ledger: SessionLedger; runtimeId?: string },
  ) {
    this.runtimeId = options.runtimeId ?? 'next-local'
  }

  start(input: StartRunInput, signal: AbortSignal = new AbortController().signal): Promise<RuntimeRunRef> {
    const pending = this.locks.get(input.runId)
    if (pending !== undefined) return pending
    const work = this.startCurrent(input, signal).finally(() => {
      if (this.locks.get(input.runId) === work) this.locks.delete(input.runId)
    })
    this.locks.set(input.runId, work)
    return work
  }

  async attach(input: AttachRunInput): Promise<RuntimeRunRef> {
    const expected = sessionIdForRun(input.runId)
    if (input.sessionId !== expected) throw new SessionBridgeError('SESSION_ID_MISMATCH')
    const entry = this.options.ledger.get(input.runId)
    if (entry !== undefined && entry.sessionId !== input.sessionId) {
      throw new SessionBridgeError('SESSION_ID_MISMATCH')
    }
    await this.observe(input.sessionId)
    return { runtimeId: this.runtimeId, runId: input.runId, sessionId: input.sessionId }
  }

  async cancel(ref: RuntimeRunRef): Promise<void> {
    this.assertRef(ref)
    await this.host.sessionController.cancel({ sessionId: ref.sessionId })
  }

  async snapshot(ref: RuntimeRunRef): Promise<SessionSnapshot> {
    this.assertRef(ref)
    const observed = await this.observe(ref.sessionId)
    return { ref, events: observed.events, cursor: observed.cursor }
  }

  private async startCurrent(input: StartRunInput, signal: AbortSignal): Promise<RuntimeRunRef> {
    signal.throwIfAborted()
    const sessionId = sessionIdForRun(input.runId)
    const requestId = requestIdForRun(input.runId)
    const ref = { runtimeId: this.runtimeId, runId: input.runId, sessionId }
    const entry = this.options.ledger.get(input.runId)
    if (entry !== undefined && entry.sessionId !== sessionId) {
      throw new SessionBridgeError('SESSION_ID_MISMATCH')
    }

    let observed = await this.observeOrMissing(sessionId)
    if (observed !== undefined && observed.cwd !== input.project.rootPath) {
      throw new SessionBridgeError('SESSION_CWD_MISMATCH')
    }
    if (observed !== undefined && hasRequestId(observed.events, requestId)) {
      if (entry === undefined) this.options.ledger.recordPromptIntent(input.runId, sessionId)
      this.options.ledger.markAccepted(input.runId, observed.cursor)
      return ref
    }
    if (entry?.promptIntent) throw new SessionBridgeError('SESSION_START_UNKNOWN')

    if (observed === undefined) {
      const created = await this.host.sessionController.create({ sessionId, cwd: input.project.rootPath })
      if (created.sessionId !== sessionId) throw new SessionBridgeError('SESSION_ID_MISMATCH')
    }
    signal.throwIfAborted()
    this.options.ledger.recordPromptIntent(input.runId, sessionId)
    await this.host.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: input.prompt }],
    }, signal)
    observed = await this.observe(sessionId)
    this.options.ledger.markAccepted(input.runId, observed.cursor)
    return ref
  }

  private assertRef(ref: RuntimeRunRef): void {
    if (ref.sessionId !== sessionIdForRun(ref.runId)) throw new SessionBridgeError('SESSION_ID_MISMATCH')
  }

  private async observe(sessionId: string): Promise<ObservedSession> {
    using observation = await this.host.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    return { events: observation.events, cursor: observation.cursor, cwd: observation.header.cwd }
  }

  private async observeOrMissing(sessionId: string): Promise<ObservedSession | undefined> {
    try {
      return await this.observe(sessionId)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
  }
}

function hasRequestId(events: readonly SessionEvent[], requestId: string): boolean {
  return events.some(event => {
    if (event.type === 'user/message') return messageRequestId(event.data) === requestId
    if (event.type !== 'agent/inbox/spliced' || typeof event.data !== 'object' || event.data === null
      || !('inserted' in event.data) || !Array.isArray(event.data.inserted)) return false
    return event.data.inserted.some(message => messageRequestId(message) === requestId)
  })
}

function messageRequestId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('source' in message)
    || typeof message.source !== 'object' || message.source === null || !('rpcId' in message.source)) {
    return undefined
  }
  return typeof message.source.rpcId === 'string' ? message.source.rpcId : undefined
}

function uuidV5(namespace: string, value: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')
  const hash = createHash('sha1').update(namespaceBytes).update(value, 'utf8').digest().subarray(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
