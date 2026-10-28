import type { CoreRequest, CoreResponse, RuntimeEvent, RuntimeRunRef } from '@runwright/contracts'
import type { ExecutionGuard } from './execution-guard.js'
import { Reconciler } from './reconciler.js'
import type { ReconcilerHost } from './reconciler.js'
import { RuntimeEndpoint } from './runtime-endpoint.js'
import { SessionBridge } from './session-bridge.js'
import type { SessionBridgeHost } from './session-bridge.js'
import { SessionLedger } from './session-ledger.js'

export type HostRuntimeHost = SessionBridgeHost & ReconcilerHost

export interface HostRuntimeConnection {
  readonly events: AsyncIterable<CoreRequest>
  publish(ref: RuntimeRunRef, event: RuntimeEvent): Promise<void>
  respond(response: CoreResponse): void
}

export interface HostRuntime {
  runRequests(): Promise<void>
  dispose(): void
}

export function createHostRuntime(
  host: HostRuntimeHost,
  connection: HostRuntimeConnection,
  guard: ExecutionGuard,
  ledgerPath: string,
): HostRuntime {
  const ledger = new SessionLedger(ledgerPath)
  for (const entry of ledger.list()) guard.block(entry.sessionId)
  const bridge = new SessionBridge(host, { ledger })
  const reconciler = new Reconciler(host, {
    ledger,
    publish: (ref, event) => connection.publish(ref, event),
  })
  const endpoint = new RuntimeEndpoint(bridge, reconciler, guard)
  return {
    async runRequests() {
      for await (const request of connection.events) {
        const response = await endpoint.handle(request)
        try {
          connection.respond(response)
        } catch {}
      }
    },
    dispose() {
      reconciler.dispose()
    },
  }
}
