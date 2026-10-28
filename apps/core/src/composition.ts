import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Database } from 'better-sqlite3'
import { resolveCoreConfig } from './config.js'
import type { CoreConfig } from './config.js'
import { openDatabase } from './database.js'
import { Orchestrator } from './orchestrator.js'
import { RemoteRuntimeDriver, RuntimeServer } from './runtime-server.js'
import { RuntimeRegistry } from './runtime-registry.js'
import { CoreStore } from './store.js'

export interface StartedCore {
  server: RuntimeServer
  store: CoreStore
  orchestrator: Orchestrator
  registry: RuntimeRegistry
  runtime: RemoteRuntimeDriver
  close(): Promise<void>
}

export async function startCore(config: CoreConfig = {}): Promise<StartedCore> {
  const resolved = resolveCoreConfig(config)
  mkdirSync(dirname(resolved.databasePath), { recursive: true, mode: 0o700 })
  const database = openDatabase(resolved.databasePath)
  const store = new CoreStore(database)
  const runtime = new RemoteRuntimeDriver()
  const registry = new RuntimeRegistry(runtime)
  const orchestrator = new Orchestrator(store, registry)
  const server = new RuntimeServer({
    host: resolved.host,
    port: resolved.port,
    token: resolved.token,
    requestTimeoutMs: resolved.requestTimeoutMs,
    shutdownTimeoutMs: resolved.shutdownTimeoutMs,
    store,
    orchestrator,
    registry,
    runtime,
  })

  try {
    await server.start()
    await orchestrator.recover()
  } catch (error) {
    await server.close()
    database.close()
    throw error
  }

  let closePromise: Promise<void> | undefined
  const removeSignalHandlers = () => {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        removeSignalHandlers()
        try {
          await server.close()
        } finally {
          closeDatabase(database)
        }
      })()
    }
    return closePromise
  }
  const onSigterm = () => { void close() }
  const onSigint = () => { void close() }
  if (resolved.handleSignals) {
    process.once('SIGTERM', onSigterm)
    process.once('SIGINT', onSigint)
  }

  return { server, store, orchestrator, registry, runtime, close }
}

function closeDatabase(database: Database): void {
  if (database.open) database.close()
}
