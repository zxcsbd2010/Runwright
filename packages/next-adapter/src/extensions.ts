import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CoreMethod, CoreRequest, CoreResponse, RuntimeEvent, RuntimeRunRef } from '@runwright/contracts'
import { CoreConnection } from './host/core-connection.js'
import { RunwrightRemoteFacade } from './host/remote-facade.js'
import type { CoreConnectionOptions } from './host/core-connection.js'
import { createRuntimeHello, readPackageManifest, requiredRuntimeCapabilities } from './host/capabilities.js'
import { createHostRuntime } from './host/host-runtime.js'
import type { HostRuntime, HostRuntimeHost } from './host/host-runtime.js'
import { DesktopSerializer } from './host/desktop-serializer.js'
import type { DesktopSerializerContext } from './host/desktop-serializer.js'
import { ExecutionGuard } from './host/execution-guard.js'
import type { ExecutionGuardContext } from './host/execution-guard.js'

export const name = 'runwright-next-adapter'
export const inject = ['sessionController', 'sessionQuery']

export interface HostConnection {
  readonly events?: AsyncIterable<CoreRequest>
  start(): Promise<void>
  call?<T>(method: CoreMethod, params: unknown, signal?: AbortSignal): Promise<T>
  publish?(ref: RuntimeRunRef, event: RuntimeEvent): Promise<void>
  respond?(response: CoreResponse): void
  dispose(): void
}

export interface HostContext extends HostRuntimeHost {
  readonly logger: {
    error: (...args: unknown[]) => void
  }
  on(event: 'tools/pre-execute', listener: Parameters<ExecutionGuardContext['on']>[1]): (() => void) | void
  on(event: 'tools/execute', listener: Parameters<DesktopSerializerContext['on']>[1]): (() => void) | void
  effect(effect: () => void | (() => void), description?: string): unknown
}

export function apply(
  ctx: HostContext,
  createConnection: () => HostConnection = () => new CoreConnection(loadCoreConnectionOptions()),
): void {
  let connection: HostConnection
  try {
    connection = createConnection()
  } catch {
    ctx.logger.error('runwright-next-adapter: initialization failed')
    return
  }

  ctx.effect(() => {
    let guard: ExecutionGuard | undefined
    let desktop: DesktopSerializer | undefined
    let runtime: HostRuntime | undefined
    try {
      if (hasCoreCalls(connection)) new RunwrightRemoteFacade(ctx as unknown as Context, connection)
      guard = new ExecutionGuard()
      desktop = new DesktopSerializer(desktopToolNames())
      runtime = isRuntimeConnection(connection)
        ? createHostRuntime(ctx, connection, guard, ledgerPath())
        : undefined
      guard.install(ctx)
      desktop.install(ctx)
    } catch {
      disposeAll(runtime?.dispose.bind(runtime), guard?.dispose.bind(guard), desktop?.dispose.bind(desktop), () => connection.dispose())
      ctx.logger.error('runwright-next-adapter: initialization failed')
      return
    }
    void Promise.resolve()
      .then(() => connection.start())
      .catch(() => ctx.logger.error('runwright-next-adapter: startup failed'))
    if (runtime) {
      void runRequests(runtime).catch(() => ctx.logger.error('runwright-next-adapter: request loop failed'))
    }
    return () => disposeAll(runtime?.dispose.bind(runtime), guard?.dispose.bind(guard), desktop?.dispose.bind(desktop), () => connection.dispose())
  }, 'Runwright Core connection')
}

function disposeAll(...disposers: Array<(() => void) | undefined>): void {
  for (const dispose of disposers) {
    try {
      dispose?.()
    } catch {}
  }
}

function hasCoreCalls(connection: HostConnection): connection is HostConnection & {
  call<T>(method: CoreMethod, params: unknown, signal?: AbortSignal): Promise<T>
} {
  return connection.call !== undefined
}

function isRuntimeConnection(connection: HostConnection): connection is HostConnection & {
  events: AsyncIterable<CoreRequest>
  publish(ref: RuntimeRunRef, event: RuntimeEvent): Promise<void>
  respond(response: CoreResponse): void
} {
  return connection.events !== undefined && connection.publish !== undefined && connection.respond !== undefined
}

async function runRequests(runtime: HostRuntime): Promise<void> {
  await runtime.runRequests()
}

function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNWRIGHT_SESSION_LEDGER ?? join(homedir(), '.runwright', 'next-sessions.json')
}

function desktopToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RUNWRIGHT_DESKTOP_TOOLS ?? '').split(',').map(name => name.trim()).filter(Boolean)
}

export function loadCoreConnectionOptions(env: NodeJS.ProcessEnv = process.env): CoreConnectionOptions {
  const tokenFile = requiredPath(env.RUNWRIGHT_TOKEN_FILE, 'TOKEN_FILE_REQUIRED')
  const nextManifest = requiredPath(env.RUNWRIGHT_NEXT_MANIFEST, 'NEXT_MANIFEST_REQUIRED')
  const dshManifest = requiredPath(env.RUNWRIGHT_DSH_MANIFEST, 'DSH_MANIFEST_REQUIRED')
  return {
    url: env.RUNWRIGHT_CORE_URL ?? 'ws://127.0.0.1:47832',
    tokenFile,
    hello: createRuntimeHello({
      adapterManifest: readPackageManifest(new URL('../package.json', import.meta.url)),
      nextManifest: readPackageManifest(nextManifest),
      dshManifest: readPackageManifest(dshManifest),
      runtimeId: 'next-local',
      capabilities: requiredRuntimeCapabilities,
    }),
  }
}

function requiredPath(value: string | undefined, code: string): string {
  if (!value) throw new Error(code)
  return value
}
