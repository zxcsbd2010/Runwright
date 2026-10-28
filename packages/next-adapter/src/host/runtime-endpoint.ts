import {
  attachRunInputSchema,
  runtimeRunRefSchema,
  startRunInputSchema,
} from '@runwright/contracts'
import type {
  AttachRunInput,
  CoreRequest,
  CoreResponse,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeRunRef,
  RunSnapshot,
  StartRunInput,
  TaskStatus,
} from '@runwright/contracts'
import { translateSessionEvent } from './event-translator.js'
import type { DshSessionEvent } from './event-translator.js'
import type { ExecutionGuardSession } from './execution-guard.js'
import type { Reconciler } from './reconciler.js'
import { sessionIdForRun } from './session-bridge.js'
import type { SessionBridge } from './session-bridge.js'

export class RuntimeEndpoint implements RuntimeDriver {
  constructor(
    private readonly bridge: SessionBridge,
    private readonly reconciler: Reconciler,
    private readonly guard?: {
      register(session: ExecutionGuardSession): void
      block(sessionId: string): void
    },
  ) {}

  async startRun(input: StartRunInput): Promise<RuntimeRunRef> {
    this.guard?.register({
      sessionId: sessionIdForRun(input.runId),
      rootPath: input.project.rootPath,
      policy: input.policy,
    })
    const ref = await this.bridge.start(input)
    await this.reconciler.attach(ref, 0)
    return ref
  }

  async attachRun(input: AttachRunInput): Promise<RuntimeRunRef> {
    this.guard?.block(input.sessionId)
    const ref = await this.bridge.attach(input)
    if (input.project && input.policy) {
      this.guard?.register({ sessionId: ref.sessionId, rootPath: input.project.rootPath, policy: input.policy })
    } else {
      this.guard?.block(ref.sessionId)
    }
    await this.reconciler.attach(ref, input.afterSeq ?? 0)
    return ref
  }

  async cancelRun(ref: RuntimeRunRef): Promise<void> {
    await this.bridge.cancel(ref)
  }

  async getRunSnapshot(ref: RuntimeRunRef): Promise<RunSnapshot> {
    const snapshot = await this.bridge.snapshot(ref)
    const events: RuntimeEvent[] = []
    for (const event of snapshot.events) {
      if (!isDshEvent(event)) throw new Error('SESSION_EVENT_INVALID')
      for (const translated of translateSessionEvent(event, events.length + 1)) events.push(translated)
    }
    return { ref, status: statusAfter(events), events }
  }

  subscribe(ref: RuntimeRunRef): AsyncIterable<RuntimeEvent> {
    return this.reconciler.subscribe(ref)
  }

  async handle(request: CoreRequest): Promise<CoreResponse> {
    const schema = request.method === 'runtime.start'
      ? startRunInputSchema
      : request.method === 'runtime.attach'
        ? attachRunInputSchema
        : request.method === 'runtime.cancel' || request.method === 'runtime.snapshot'
          ? runtimeRunRefSchema
          : undefined
    if (!schema) return errorResponse(request.id, 'INVALID_REQUEST', 'Invalid request')
    const params = schema.safeParse(request.params)
    if (!params.success) return errorResponse(request.id, 'INVALID_REQUEST', 'Invalid request')
    try {
      switch (request.method) {
        case 'runtime.start':
          return { id: request.id, result: await this.startRun(params.data as StartRunInput) }
        case 'runtime.attach':
          return { id: request.id, result: await this.attachRun(params.data as AttachRunInput) }
        case 'runtime.cancel':
          await this.cancelRun(params.data as RuntimeRunRef)
          return { id: request.id, result: null }
        case 'runtime.snapshot':
          return { id: request.id, result: await this.getRunSnapshot(params.data as RuntimeRunRef) }
        default:
          return errorResponse(request.id, 'INVALID_REQUEST', 'Invalid request')
      }
    } catch {
      const code = request.method === 'runtime.start'
        ? 'START_UNKNOWN'
        : request.method === 'runtime.attach'
          ? 'ATTACH_UNKNOWN'
          : request.method === 'runtime.cancel' ? 'CANCEL_UNKNOWN' : 'SNAPSHOT_UNKNOWN'
      const message = request.method === 'runtime.cancel' ? 'Cancellation outcome unknown' : 'Runtime request failed'
      return errorResponse(request.id, code, message)
    }
  }
}

function statusAfter(events: readonly RuntimeEvent[]): TaskStatus {
  let status: TaskStatus = 'queued'
  for (const event of events) {
    if (['succeeded', 'failed', 'cancelled'].includes(status)) continue
    switch (event.type) {
      case 'run.started':
      case 'approval.resolved':
        status = 'running'
        break
      case 'run.progress':
        if (status !== 'waiting_approval') status = 'running'
        break
      case 'approval.requested':
        status = 'waiting_approval'
        break
      case 'run.succeeded':
        status = 'succeeded'
        break
      case 'run.failed':
        status = 'failed'
        break
      case 'run.cancelled':
        status = 'cancelled'
        break
      case 'run.attention':
        status = 'attention'
        break
      case 'validation.completed':
        break
    }
  }
  return status
}

function isDshEvent(event: unknown): event is DshSessionEvent {
  return typeof event === 'object' && event !== null && 'seq' in event
    && typeof event.seq === 'number' && 'time' in event && typeof event.time === 'number'
}

function errorResponse(id: string, code: string, message: string): CoreResponse {
  return { id, error: { code, message } }
}
