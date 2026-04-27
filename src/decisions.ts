// src/decisions.ts
// Audit trail of successful autopilot answers. Pairs with src/error-log.ts
// (which captures failures) — together they record every /btw outcome with
// enough context to reconstruct what was decided, by whom (which
// personality), how long it took, and what the question was.

import { Database } from 'bun:sqlite'

export type DecisionEntry = {
  id?: number
  ts: number              // epoch ms
  sessionName: string
  sessionPath: string
  personalityId?: number
  personalityName?: string
  rawQuestion: string
  answer: string
  durationMs: number
}

type Row = {
  id: number
  ts: number
  session_name: string
  session_path: string
  personality_id: number | null
  personality_name: string | null
  raw_question: string
  answer: string
  duration_ms: number
}

function rowToEntry(r: Row): DecisionEntry {
  return {
    id: r.id,
    ts: r.ts,
    sessionName: r.session_name,
    sessionPath: r.session_path,
    personalityId: r.personality_id ?? undefined,
    personalityName: r.personality_name ?? undefined,
    rawQuestion: r.raw_question,
    answer: r.answer,
    durationMs: r.duration_ms,
  }
}

export class Decisions {
  constructor(private db: Database) {}

  record(e: DecisionEntry): void {
    this.db.prepare(
      `INSERT INTO autopilot_decisions
       (ts, session_name, session_path, personality_id, personality_name, raw_question, answer, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.ts,
      e.sessionName,
      e.sessionPath,
      e.personalityId ?? null,
      e.personalityName ?? null,
      e.rawQuestion,
      e.answer,
      e.durationMs,
    )
  }

  recent(opts?: { session?: string; personalityId?: number; limit?: number }): DecisionEntry[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000))
    const conds: string[] = []
    const params: (string | number)[] = []
    if (opts?.session) { conds.push('session_name = ?'); params.push(opts.session) }
    if (opts?.personalityId !== undefined) { conds.push('personality_id = ?'); params.push(opts.personalityId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_decisions ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as Row[]
    return rows.map(rowToEntry)
  }

  // Storage hygiene — bound per-session history to N rows so chatty
  // sessions don't push the DB into hundreds of MB. Call from the daemon
  // on a schedule.
  purgeKeepLastPerSession(keep: number): void {
    const k = Math.max(0, Math.floor(keep))
    this.db.exec(`
      DELETE FROM autopilot_decisions
      WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY session_name ORDER BY ts DESC) AS rn
          FROM autopilot_decisions
        ) WHERE rn > ${k}
      )
    `)
  }
}
