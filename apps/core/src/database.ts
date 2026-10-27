import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

export function openDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  const migrated = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get()
  if (!migrated) {
    const sql = readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date().toISOString())
    })()
  }

  return db
}
