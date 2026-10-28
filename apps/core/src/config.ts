import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CORE_HOST = '127.0.0.1'
export const DEFAULT_CORE_PORT = 47832

export interface CoreConfig {
  tokenFile?: string
  databasePath?: string
  host?: string
  port?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  handleSignals?: boolean
}

export interface ResolvedCoreConfig {
  token: string
  databasePath: string
  host: typeof DEFAULT_CORE_HOST
  port: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  handleSignals: boolean
}

export function resolveCoreConfig(config: CoreConfig = {}): ResolvedCoreConfig {
  const host = config.host ?? DEFAULT_CORE_HOST
  if (host !== DEFAULT_CORE_HOST) throw new Error('NON_LOOPBACK_HOST')

  const port = config.port ?? DEFAULT_CORE_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT')
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 5_000
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('INVALID_REQUEST_TIMEOUT')
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new Error('INVALID_SHUTDOWN_TIMEOUT')

  return {
    token: readToken(config.tokenFile ?? process.env.RUNWRIGHT_TOKEN_FILE),
    databasePath: config.databasePath ?? join(homedir(), '.runwright', 'core.db'),
    host,
    port,
    requestTimeoutMs,
    shutdownTimeoutMs,
    handleSignals: config.handleSignals ?? true,
  }
}

function readToken(path: string | undefined): string {
  if (!path) throw new Error('TOKEN_FILE_REQUIRED')
  const descriptor = openSync(path, 'r')
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('TOKEN_FILE_PERMISSIONS')
    const token = readFileSync(descriptor, 'utf8').trim()
    if (!token) throw new Error('TOKEN_FILE_EMPTY')
    return token
  } finally {
    closeSync(descriptor)
  }
}
