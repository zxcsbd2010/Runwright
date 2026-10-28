import type {
  AttachRunInput,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeRunRef,
  RunSnapshot,
  StartRunInput,
} from '@runwright/contracts'

interface Subscription {
  events: RuntimeEvent[]
  waiting: (() => void) | undefined
  closed: boolean
}

export class FakeRuntime implements RuntimeDriver {
  readonly runtimeId = 'next-local'
  readonly startCalls: StartRunInput[] = []
  readonly attachCalls: AttachRunInput[] = []
  readonly cancelCalls: RuntimeRunRef[] = []
  readonly subscribeCalls: RuntimeRunRef[] = []
  readonly operations: string[] = []
  startGate?: Promise<void>
  cancelError?: Error
  attachResult?: RuntimeRunRef
  onStart?: (input: StartRunInput) => void | Promise<void>
  onSubscribe?: (ref: RuntimeRunRef) => void
  private readonly subscriptions = new Map<string, Subscription>()

  async startRun(input: StartRunInput): Promise<RuntimeRunRef> {
    this.startCalls.push(input)
    this.operations.push(`start:${input.runId}`)
    await this.onStart?.(input)
    await this.startGate
    return { runtimeId: this.runtimeId, runId: input.runId, sessionId: `session-${input.runId}` }
  }

  async attachRun(input: AttachRunInput): Promise<RuntimeRunRef> {
    this.attachCalls.push(input)
    this.operations.push(`attach:${input.runId}`)
    return this.attachResult ?? { runtimeId: this.runtimeId, runId: input.runId, sessionId: input.sessionId }
  }

  async cancelRun(ref: RuntimeRunRef): Promise<void> {
    this.cancelCalls.push(ref)
    this.operations.push(`cancel:${ref.runId}`)
    if (this.cancelError) throw this.cancelError
  }

  async getRunSnapshot(ref: RuntimeRunRef): Promise<RunSnapshot> {
    return { ref, status: 'running', events: [] }
  }

  subscribe(ref: RuntimeRunRef): AsyncIterable<RuntimeEvent> {
    this.subscribeCalls.push(ref)
    this.operations.push(`subscribe:${ref.runId}`)
    this.onSubscribe?.(ref)
    const subscription: Subscription = { events: [], waiting: undefined, closed: false }
    this.subscriptions.set(ref.runId, subscription)
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<RuntimeEvent>> => {
          for (;;) {
            const event = subscription.events.shift()
            if (event) return { value: event, done: false }
            if (subscription.closed) return { value: undefined, done: true }
            await new Promise<void>((resolve) => { subscription.waiting = resolve })
            subscription.waiting = undefined
          }
        },
        return: async (): Promise<IteratorResult<RuntimeEvent>> => {
          subscription.closed = true
          subscription.waiting?.()
          return { value: undefined, done: true }
        },
      }),
    }
  }

  emit(runId: string, event: RuntimeEvent): void {
    const subscription = this.subscriptions.get(runId)
    if (!subscription) throw new Error('NO_SUBSCRIPTION')
    subscription.events.push(event)
    subscription.waiting?.()
  }

  close(runId: string): void {
    const subscription = this.subscriptions.get(runId)
    if (!subscription) return
    subscription.closed = true
    subscription.waiting?.()
  }

  closeAll(): void {
    for (const runId of this.subscriptions.keys()) this.close(runId)
  }
}
