// src/error-log.ts
// SQLite-backed log of autopilot failures (timeout, parse_error, escalate).
// Lets the user inspect what /btw actually returned when an answer didn't
// reach Claude — the captured pane is the smoking gun in most cases.
//
// Schema lives in src/operant-db.ts — this class only knows how to read/write
// the autopilot_errors table over a Database the caller already opened.

import { Database } from 'bun:sqlite'
import { openOperantDb } from './operant-db'
import { dirname } from 'path'

export type ErrorStatus = 'parse_error' | 'timeout' | 'escalate' | 'risk' | 'other'

export type ErrorEntry = {
  id?: number
  ts: number              // epoch ms
  sessionName: string
  sessionPath: string
  status: ErrorStatus
  reason?: string
  rawQuestion?: string
  wrappedQuestion?: string
  capturedPane?: string
  durationMs: number
}

type Row = {
  id: number
  ts: number
  session_name: string
  session_path: string
  status: string
  reason: string | null
  raw_question: string | null
  wrapped_question: string | null
  captured_pane: string | null
  duration_ms: number
}

export class ErrorLog {
  private db: Database
  private ownsDb: boolean

  constructor(dbOrPath: Database | string) {
    if (typeof dbOrPath === 'string') {
      // Backward-compatible path-string form: spin up a operant-db in the
      // file's directory. Used by older tests that pass a path directly.
      const handle = openOperantDb(dirname(dbOrPath))
      this.db = handle.db
      this.ownsDb = true
    } else {
      this.db = dbOrPath
      this.ownsDb = false
    }
  }

  record(e: ErrorEntry): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_errors
         (ts, session_name, session_path, status, reason, raw_question, wrapped_question, captured_pane, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ts,
        e.sessionName,
        e.sessionPath,
        e.status,
        e.reason ?? null,
        e.rawQuestion ?? null,
        e.wrappedQuestion ?? null,
        e.capturedPane ?? null,
        e.durationMs,
      )
  }

  recent(opts?: { session?: string; limit?: number }): ErrorEntry[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500))
    let rows: Row[]
    if (opts?.session) {
      rows = this.db
        .prepare(`SELECT * FROM autopilot_errors WHERE session_name = ? ORDER BY ts DESC LIMIT ?`)
        .all(opts.session, limit) as Row[]
    } else {
      rows = this.db
        .prepare(`SELECT * FROM autopilot_errors ORDER BY ts DESC LIMIT ?`)
        .all(limit) as Row[]
    }
    return rows.map(rowToEntry)
  }

  // Keep storage bounded — the captured pane field can run hundreds of KB per
  // entry, and a stuck autopilot can produce many errors quickly. Call this
  // on a schedule from the daemon.
  purgeKeepLast(keep: number): void {
    this.db.exec(
      `DELETE FROM autopilot_errors WHERE id NOT IN (SELECT id FROM autopilot_errors ORDER BY ts DESC LIMIT ${Math.max(0, Math.floor(keep))})`,
    )
  }

  close(): void {
    if (this.ownsDb) this.db.close()
  }
}

function rowToEntry(r: Row): ErrorEntry {
  return {
    id: r.id,
    ts: r.ts,
    sessionName: r.session_name,
    sessionPath: r.session_path,
    status: r.status as ErrorStatus,
    reason: r.reason ?? undefined,
    rawQuestion: r.raw_question ?? undefined,
    wrappedQuestion: r.wrapped_question ?? undefined,
    capturedPane: r.captured_pane ?? undefined,
    durationMs: r.duration_ms,
  }
}
