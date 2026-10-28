import type { RuntimeEvent, RuntimeRunRef } from '@runwright/contracts'
import { translateSessionEvent } from './event-translator.js'
import type { DshSessionEvent } from './event-translator.js'
import type { SessionLedger } from './session-ledger.js'

export interface SessionFollowRequest {
  address: { kind: 'session'; sessionId: string }
}

export type SessionFollowFrame =
  | {
    type: 'snapshot'
    header: unknown
    cursor: number
    records: readonly SessionHistoryRecord[]
    hasMore: boolean
    projections: unknown
  }
  | { type: 'event'; event: DshSessionEvent }

export type SessionHistoryRecord =
  | { type: 'event'; event: DshSessionEvent }
  | { type: 'chunks'; event: DshChunkRowEvent }

export interface DshChunkRowEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export interface ReconcilerHost {
  sessionController: {
    follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  }
}

interface ReconcilerOptions {
  ledger: SessionLedger
  publish(ref: RuntimeRunRef, event: RuntimeEvent): void | Promise<void>
}

interface Worker {
  controller: AbortController
  nextCoreSeq: number
  lastSessionCursor: number
  ready: Promise<void>
  markReady: () => void
}

interface EventStream {
  events: RuntimeEvent[]
  waiting: (() => void) | undefined
  closed: boolean
}

class PublicationFailure extends Error {}

export class Reconciler {
  private readonly workers = new Map<string, Worker>()
  private readonly streams = new Map<string, EventStream>()
  private disposed = false

  constructor(
    private readonly host: ReconcilerHost,
    private readonly options: ReconcilerOptions,
  ) {}

  async attach(ref: RuntimeRunRef, afterSeq = 0): Promise<void> {
    if (this.disposed) throw new Error('RECONCILER_CLOSED')
    const existing = this.workers.get(ref.runId)
    if (existing) return await existing.ready
    let markReady!: () => void
    const ready = new Promise<void>(resolve => { markReady = resolve })
    const worker: Worker = {
      controller: new AbortController(),
      nextCoreSeq: afterSeq + 1,
      lastSessionCursor: this.options.ledger.get(ref.runId)?.lastSessionCursor ?? -1,
      ready,
      markReady,
    }
    this.workers.set(ref.runId, worker)
    void this.consume(ref, worker).finally(() => {
      worker.markReady()
      if (this.workers.get(ref.runId) === worker) this.workers.delete(ref.runId)
    })
    await ready
  }

  subscribe(ref: RuntimeRunRef): AsyncIterable<RuntimeEvent> {
    let stream = this.streams.get(ref.runId)
    if (!stream || stream.closed) {
      stream = { events: [], waiting: undefined, closed: false }
      this.streams.set(ref.runId, stream)
    }
    const current = stream
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<RuntimeEvent>> => {
          for (;;) {
            const event = current.events.shift()
            if (event) return { value: event, done: false }
            if (current.closed) return { value: undefined, done: true }
            await new Promise<void>(resolve => { current.waiting = resolve })
            current.waiting = undefined
          }
        },
        return: async (): Promise<IteratorResult<RuntimeEvent>> => {
          current.closed = true
          current.waiting?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const worker of this.workers.values()) worker.controller.abort()
    this.workers.clear()
    for (const stream of this.streams.values()) {
      stream.closed = true
      stream.waiting?.()
    }
  }

  private async consume(ref: RuntimeRunRef, worker: Worker): Promise<void> {
    const { signal } = worker.controller
    try {
      const frames = this.host.sessionController.follow({
        address: { kind: 'session', sessionId: ref.sessionId },
      }, signal)
      for await (const frame of frames) {
        if (signal.aborted) return
        if (frame.type === 'snapshot') {
          const applying = this.applySnapshot(ref, worker, frame)
          worker.markReady()
          if (!await applying) return
        } else if (!await this.applyLiveEvent(ref, worker, frame.event)) return
      }
    } catch (error) {
      if (signal.aborted || error instanceof PublicationFailure) return
      try {
        const attention = this.publishAttention(ref, worker, streamErrorCode(error))
        worker.markReady()
        await attention
      } catch (error) {
        if (!(error instanceof PublicationFailure)) throw error
      }
    }
  }

  private async applySnapshot(
    ref: RuntimeRunRef,
    worker: Worker,
    frame: Extract<SessionFollowFrame, { type: 'snapshot' }>,
  ): Promise<boolean> {
    let events: DshSessionEvent[]
    try {
      events = frame.records.flatMap(expandRecord)
    } catch {
      await this.publishAttention(ref, worker, 'EVENT_GAP')
      return false
    }
    const fresh = events.filter(event => event.seq > worker.lastSessionCursor)
    if (frame.cursor > worker.lastSessionCursor && fresh.length === 0) {
      await this.publishAttention(ref, worker, 'EVENT_GAP')
      return false
    }
    for (const event of fresh) {
      if (event.seq !== worker.lastSessionCursor + 1) {
        await this.publishAttention(ref, worker, 'EVENT_GAP')
        return false
      }
      if (!await this.applyEvent(ref, worker, event)) return false
    }
    if (worker.lastSessionCursor !== frame.cursor && frame.cursor >= 0) {
      await this.publishAttention(ref, worker, 'EVENT_GAP')
      return false
    }
    return true
  }

  private async applyLiveEvent(ref: RuntimeRunRef, worker: Worker, event: DshSessionEvent): Promise<boolean> {
    if (event.seq <= worker.lastSessionCursor) return true
    if (event.seq !== worker.lastSessionCursor + 1) {
      await this.publishAttention(ref, worker, 'EVENT_STREAM_GAP')
      return false
    }
    return await this.applyEvent(ref, worker, event)
  }

  private async applyEvent(ref: RuntimeRunRef, worker: Worker, event: DshSessionEvent): Promise<boolean> {
    const translated = translateSessionEvent(event, worker.nextCoreSeq)
    for (const [index, item] of translated.entries()) {
      const pending = this.options.ledger.get(ref.runId)?.pendingPublication
      const coreSeq = pending?.sessionCursor === event.seq ? pending.coreSeq : worker.nextCoreSeq
      const publication = { ...item, seq: coreSeq }
      this.options.ledger.beginPublication(ref.runId, coreSeq, event.seq)
      try {
        await this.options.publish(ref, publication)
      } catch {
        throw new PublicationFailure()
      }
      this.emit(ref.runId, publication)
      worker.nextCoreSeq = coreSeq + 1
      if (index < translated.length - 1) this.options.ledger.clearPublication(ref.runId)
    }
    worker.lastSessionCursor = event.seq
    this.options.ledger.updateCursor(ref.runId, event.seq)
    return true
  }

  private async publishAttention(ref: RuntimeRunRef, worker: Worker, reason: string): Promise<void> {
    const pending = this.options.ledger.get(ref.runId)?.pendingPublication
    const coreSeq = pending?.coreSeq ?? worker.nextCoreSeq
    const event: RuntimeEvent = { seq: coreSeq, type: 'run.attention', reason }
    this.options.ledger.beginPublication(ref.runId, coreSeq, null)
    try {
      await this.options.publish(ref, event)
    } catch {
      throw new PublicationFailure()
    }
    this.emit(ref.runId, event)
    worker.nextCoreSeq = coreSeq + 1
    this.options.ledger.clearPublication(ref.runId)
  }

  private emit(runId: string, event: RuntimeEvent): void {
    let stream = this.streams.get(runId)
    if (!stream || stream.closed) {
      stream = { events: [], waiting: undefined, closed: false }
      this.streams.set(runId, stream)
    }
    stream.events.push(event)
    stream.waiting?.()
  }
}

function expandRecord(record: SessionHistoryRecord): DshSessionEvent[] {
  if (record.type === 'event') return [record.event]
  const length = chunkLength(record.event)
  return Array.from({ length }, (_, index) => ({
    type: 'assistant/chunk',
    seq: record.event.seq + index,
    time: record.event.time,
    data: null,
  }))
}

function chunkLength(event: DshChunkRowEvent): number {
  const data = typeof event.data === 'object' && event.data !== null
    ? event.data as Record<string, unknown>
    : {}
  const values = event.type === 'chunkrow/tool-call-chunks' ? data.args : data.texts
  if (!Array.isArray(values) || values.length === 0) throw new Error('INVALID_CHUNK_RUN')
  return values.length
}

function streamErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'session-not-found' || error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')) {
    return 'SESSION_NOT_FOUND'
  }
  if (error instanceof Error && error.message.includes('skipped seq')) return 'EVENT_STREAM_GAP'
  return 'EVENT_STREAM_UNKNOWN'
}
