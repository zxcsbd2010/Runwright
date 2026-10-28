import type { RuntimeDriver, RuntimeRunRef } from '@runwright/contracts'
import type { RuntimeRegistry } from './runtime-registry.js'
import type { CoreStore, RunContext } from './store.js'

const executionPolicy = {
  allowedTools: [],
  requireApprovalFor: ['commit', 'push', 'deploy', 'external_message', 'outside_project'] as const,
}

export class Orchestrator {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly subscriptions = new Map<string, Promise<void>>()
  private recovering = false
  private recoveryPromise: Promise<void> | undefined

  constructor(
    private readonly store: CoreStore,
    private readonly registry: RuntimeRegistry,
  ) {}

  async dispatch(runId: string): Promise<void> {
    await this.exclusive(runId, async () => {
      if (this.recovering) return
      const runtime = this.registry.resolve()
      const context = await this.store.getRunContext(runId)
      await this.dispatchCurrent(context, runtime.runtimeId, runtime.driver)
    }).catch(async (error: unknown) => {
      if (error instanceof Error && error.message === 'RUNTIME_UNAVAILABLE') return
      await this.store.markAttention(runId, 'START_UNKNOWN')
    })
  }

  async cancel(taskId: string): Promise<void> {
    const detail = await this.store.getDetail(taskId)
    const runId = detail.task.activeRunId
    if (!runId) return
    await this.store.requestCancel(taskId)
    try {
      const runtime = this.registry.resolve()
      const context = await this.store.getRunContext(runId)
      if (!context.run.sessionId) throw new Error('CANCEL_UNKNOWN')
      await runtime.driver.cancelRun({
        runtimeId: runtime.runtimeId,
        runId,
        sessionId: context.run.sessionId,
      })
    } catch {
      await this.store.markAttention(runId, 'CANCEL_UNKNOWN')
    }
  }

  async recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.performRecovery().finally(() => {
      this.recoveryPromise = undefined
    })
    return this.recoveryPromise
  }

  private async performRecovery(): Promise<void> {
    this.recovering = true
    try {
      const runtime = this.registry.resolve()
      const contexts = await this.store.listRecoveryRuns()
      for (const context of contexts.filter((item) => !item.run.sessionId)) {
        await this.exclusive(context.run.id, () => this.recoverStart(context.run.id))
      }
      for (const context of contexts.filter((item) => item.run.sessionId)) {
        await this.exclusive(context.run.id, () => this.recoverAttach(context.run.id))
      }
    } catch (error) {
      if (!(error instanceof Error && error.message === 'RUNTIME_UNAVAILABLE')) throw error
    } finally {
      this.recovering = false
    }
  }

  private async recoverStart(runId: string): Promise<void> {
    const runtime = this.registry.resolve()
    try {
      const context = await this.store.getRunContext(runId)
      await this.dispatchCurrent(context, runtime.runtimeId, runtime.driver)
    } catch {
      await this.store.markAttention(runId, 'START_UNKNOWN')
    }
  }

  private async recoverAttach(runId: string): Promise<void> {
    const runtime = this.registry.resolve()
    try {
      const context = await this.store.getRunContext(runId)
      if (context.run.sessionId) await this.attachCurrent(context, runtime.runtimeId, runtime.driver)
    } catch {
      await this.store.markAttention(runId, 'ATTACH_UNKNOWN')
    }
  }

  private async dispatchCurrent(
    context: RunContext,
    runtimeId: string,
    driver: RuntimeDriver,
  ): Promise<void> {
    if (context.run.endedAt) return
    if (context.run.status === 'attention' && (!context.cancelRequested || context.run.sessionId)) return
    if (context.run.sessionId) {
      await this.attachCurrent(context, runtimeId, driver)
      return
    }
    if (!context.dispatchRequested && !(await this.store.recordDispatch(context.run.id))) return
    const ref = await driver.startRun({
      runId: context.run.id,
      project: context.project,
      prompt: context.task.prompt,
      policy: { allowedTools: [], requireApprovalFor: [...executionPolicy.requireApprovalFor] },
    })
    if (ref.runId !== context.run.id) {
      await this.store.markAttention(context.run.id, 'RUN_ID_MISMATCH')
      return
    }
    await this.store.attachRuntime(context.run.id, ref.runtimeId || runtimeId, ref.sessionId)
    this.subscribe(ref)
  }

  private async attachCurrent(
    context: RunContext,
    runtimeId: string,
    driver: RuntimeDriver,
  ): Promise<void> {
    if (!context.run.sessionId) return
    const ref = await driver.attachRun({
      runId: context.run.id,
      sessionId: context.run.sessionId,
      afterSeq: context.run.lastEventSeq ?? 0,
      project: context.project,
      policy: { allowedTools: [], requireApprovalFor: [...executionPolicy.requireApprovalFor] },
    })
    if (ref.runId !== context.run.id) {
      await this.store.markAttention(context.run.id, 'RUN_ID_MISMATCH')
      return
    }
    if (ref.sessionId !== context.run.sessionId) {
      await this.store.markAttention(context.run.id, 'SESSION_MISMATCH')
      return
    }
    await this.store.attachRuntime(context.run.id, ref.runtimeId || runtimeId, ref.sessionId)
    this.subscribe(ref)
  }

  private subscribe(ref: RuntimeRunRef): void {
    if (this.subscriptions.has(ref.runId)) return
    const runtime = this.registry.resolve()
    const subscription = this.consume(runtime.driver, ref).catch(async () => {
      await this.store.markAttention(ref.runId, 'EVENT_STREAM_UNKNOWN')
    }).finally(() => {
      this.subscriptions.delete(ref.runId)
    })
    this.subscriptions.set(ref.runId, subscription)
  }

  private async consume(driver: RuntimeDriver, ref: RuntimeRunRef): Promise<void> {
    for await (const event of driver.subscribe(ref)) {
      try {
        await this.store.applyRuntimeEvent(ref.runId, event)
      } catch (error) {
        await driver.acknowledge?.(ref, event, error)
        throw error
      }
      await driver.acknowledge?.(ref, event)
    }
  }

  private async exclusive(runId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(runId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    this.locks.set(runId, current)
    try {
      await current
    } finally {
      if (this.locks.get(runId) === current) this.locks.delete(runId)
    }
  }
}
