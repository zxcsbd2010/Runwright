import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export interface SessionLedgerEntry {
  runId: string
  sessionId: string
  promptIntent: boolean
  promptAccepted: boolean
  lastSessionCursor: number
  pendingPublication?: {
    coreSeq: number
    sessionCursor: number | null
  }
}

export class SessionLedger {
  private readonly entries: Map<string, SessionLedgerEntry>

  constructor(private readonly path: string) {
    this.entries = this.read()
  }

  get(runId: string): SessionLedgerEntry | undefined {
    const entry = this.entries.get(runId)
    return entry === undefined ? undefined : { ...entry }
  }

  list(): SessionLedgerEntry[] {
    return [...this.entries.values()].map(entry => ({ ...entry }))
  }

  recordPromptIntent(runId: string, sessionId: string): void {
    const current = this.entries.get(runId)
    if (current !== undefined && current.sessionId !== sessionId) {
      throw new Error('LEDGER_SESSION_MISMATCH')
    }
    this.entries.set(runId, {
      runId,
      sessionId,
      promptIntent: true,
      promptAccepted: current?.promptAccepted ?? false,
      lastSessionCursor: current?.lastSessionCursor ?? -1,
    })
    this.write()
  }

  markAccepted(runId: string, cursor: number): void {
    const current = this.entries.get(runId)
    if (current === undefined || !current.promptIntent) throw new Error('LEDGER_PROMPT_INTENT_MISSING')
    this.entries.set(runId, {
      ...current,
      promptAccepted: true,
      lastSessionCursor: current.lastSessionCursor,
    })
    this.write()
  }

  beginPublication(runId: string, coreSeq: number, sessionCursor: number | null): void {
    const current = this.entries.get(runId)
    if (current === undefined) return
    this.entries.set(runId, { ...current, pendingPublication: { coreSeq, sessionCursor } })
    this.write()
  }

  clearPublication(runId: string): void {
    const current = this.entries.get(runId)
    if (current === undefined || current.pendingPublication === undefined) return
    const { pendingPublication: _, ...entry } = current
    this.entries.set(runId, entry)
    this.write()
  }

  updateCursor(runId: string, cursor: number): void {
    const current = this.entries.get(runId)
    if (current === undefined || cursor <= current.lastSessionCursor) return
    const { pendingPublication: _, ...entry } = current
    this.entries.set(runId, { ...entry, lastSessionCursor: cursor })
    this.write()
  }

  private read(): Map<string, SessionLedgerEntry> {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)) {
      throw new Error('INVALID_SESSION_LEDGER')
    }
    const entries = value.entries.map(entry => this.validateEntry(entry))
    if (new Set(entries.map(entry => entry.runId)).size !== entries.length) {
      throw new Error('INVALID_SESSION_LEDGER')
    }
    return new Map(entries.map(entry => [entry.runId, entry]))
  }

  private validateEntry(value: unknown): SessionLedgerEntry {
    if (typeof value !== 'object' || value === null) throw new Error('INVALID_SESSION_LEDGER')
    const entry = value as Partial<SessionLedgerEntry>
    if (typeof entry.runId !== 'string' || typeof entry.sessionId !== 'string'
      || typeof entry.promptIntent !== 'boolean' || typeof entry.promptAccepted !== 'boolean'
      || !Number.isSafeInteger(entry.lastSessionCursor) || (entry.lastSessionCursor ?? -2) < -1) {
      throw new Error('INVALID_SESSION_LEDGER')
    }
    if (entry.pendingPublication !== undefined
      && (!Number.isSafeInteger(entry.pendingPublication.coreSeq) || entry.pendingPublication.coreSeq < 1
        || (entry.pendingPublication.sessionCursor !== null
          && (!Number.isSafeInteger(entry.pendingPublication.sessionCursor) || entry.pendingPublication.sessionCursor < -1)))) {
      throw new Error('INVALID_SESSION_LEDGER')
    }
    return { ...entry } as SessionLedgerEntry
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify({ entries: [...this.entries.values()] })}\n`, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, this.path)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      rmSync(temp, { force: true })
      throw error
    }
  }
}
