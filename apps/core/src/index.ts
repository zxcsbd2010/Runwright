import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCore } from './composition.js'

export { openDatabase } from './database.js'
export { CoreStore } from './store.js'
export { Orchestrator } from './orchestrator.js'
export { RuntimeRegistry } from './runtime-registry.js'
export { RemoteRuntimeDriver, RuntimeServer } from './runtime-server.js'
export { startCore } from './composition.js'
export type { StartedCore } from './composition.js'
export { DEFAULT_CORE_HOST, DEFAULT_CORE_PORT, resolveCoreConfig } from './config.js'
export type { CoreConfig, ResolvedCoreConfig } from './config.js'

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await startCore()
  } catch {
    console.error('Core failed to start')
    process.exitCode = 1
  }
}
