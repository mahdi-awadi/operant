// src/decisions.ts
// Audit trail of successful autopilot answers. Pairs with src/error-log.ts
// (which captures failures) — together they record every /btw outcome with
// enough context to reconstruct what was decided, by whom (which
// personality), how long it took, and what the question was.

import { Database } from 'bun:sqlite'

export type FeedbackAction = 'cancel' | 'edit'

export type FeedbackEntry = {
  id?: number
  decisionId: number
  ts: number
  action: FeedbackAction
  reason?: string
  editedAnswer?: string
}

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
  feedback?: FeedbackEntry[]   // attached when recent({ withFeedback: true })
}

type FeedbackRow = {
  id: number
  decision_id: number
  ts: number
  action: string
  reason: string | null
  edited_answer: string | null
}

function feedbackRowToEntry(r: FeedbackRow): FeedbackEntry {
  return {
    id: r.id,
    decisionId: r.decision_id,
    ts: r.ts,
    action: r.action as FeedbackAction,
    reason: r.reason ?? undefined,
    editedAnswer: r.edited_answer ?? undefined,
  }
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

  record(e: DecisionEntry): number {
    const result = this.db.prepare(
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
    return Number(result.lastInsertRowid)
  }

  getById(id: number): DecisionEntry | undefined {
    const r = this.db.prepare(`SELECT * FROM autopilot_decisions WHERE id = ?`).get(id) as Row | undefined
    return r ? rowToEntry(r) : undefined
  }

  // Capture user feedback when an autopilot draft is vetoed or edited.
  // Pairs the user's free-text reason with the original decision row so
  // personalities can later be tuned from real corrections.
  recordFeedback(decisionId: number, f: Omit<FeedbackEntry, 'decisionId' | 'id'>): number {
    const result = this.db.prepare(
      `INSERT INTO decision_feedback (decision_id, ts, action, reason, edited_answer)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      decisionId,
      f.ts,
      f.action,
      f.reason ?? null,
      f.editedAnswer ?? null,
    )
    return Number(result.lastInsertRowid)
  }

  recent(opts?: { session?: string; personalityId?: number; limit?: number; withFeedback?: boolean }): DecisionEntry[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000))
    const conds: string[] = []
    const params: (string | number)[] = []
    if (opts?.session) { conds.push('session_name = ?'); params.push(opts.session) }
    if (opts?.personalityId !== undefined) { conds.push('personality_id = ?'); params.push(opts.personalityId) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_decisions ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as Row[]
    const entries = rows.map(rowToEntry)
    if (opts?.withFeedback) {
      // Attach feedback newest-first per decision. One round-trip across all
      // decision ids in this batch — avoids the N+1 select-per-row pattern.
      const ids = entries.map((e) => e.id!).filter(Boolean)
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        const fbRows = this.db
          .prepare(`SELECT * FROM decision_feedback WHERE decision_id IN (${placeholders}) ORDER BY ts DESC`)
          .all(...ids) as FeedbackRow[]
        const byDecision = new Map<number, FeedbackEntry[]>()
        for (const r of fbRows) {
          const e = feedbackRowToEntry(r)
          if (!byDecision.has(e.decisionId)) byDecision.set(e.decisionId, [])
          byDecision.get(e.decisionId)!.push(e)
        }
        for (const e of entries) {
          e.feedback = byDecision.get(e.id!) ?? []
        }
      } else {
        for (const e of entries) e.feedback = []
      }
    }
    return entries
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
