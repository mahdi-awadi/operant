// src/hub-db.ts
// Single SQLite file backing the hub: autopilot errors + personalities +
// per-session personality assignment. Built to grow into decision history
// and any other forensic / config state that doesn't belong in JSON.
//
// Migration policy: if an old errors.sqlite is found in the same directory
// AND no hub.sqlite exists yet, we copy errors.sqlite → hub.sqlite, then
// rename the old file to errors.sqlite.bak. The schema migrations run in
// a single transaction afterwards so the new tables (personalities, etc.)
// are added atomically.

import { Database } from 'bun:sqlite'
import { existsSync, copyFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { COMPANY_SCHEMA_STATEMENTS } from './company/schema'

export type HubDbHandle = {
  db: Database
  close(): void
}

const SCHEMA_STATEMENTS = [
  // Existing — the autopilot error log we shipped earlier.
  `CREATE TABLE IF NOT EXISTS autopilot_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_name TEXT NOT NULL,
    session_path TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    raw_question TEXT,
    wrapped_question TEXT,
    captured_pane TEXT,
    duration_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_errors_ts ON autopilot_errors(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_errors_session ON autopilot_errors(session_name, ts DESC)`,

  // Autopilot personalities — replaceable system prompts that override the
  // default constraint block in wrapQuestion.
  `CREATE TABLE IF NOT EXISTS personalities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    system_prompt TEXT NOT NULL,
    reply_style TEXT,
    risk_tolerance TEXT,
    default_when_unclear TEXT,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_personalities_name ON personalities(name)`,

  // Per-session assignment. One personality per session. ON DELETE SET NULL
  // so removing a personality reverts assigned sessions to the default
  // wrapQuestion behavior instead of error-ing.
  `CREATE TABLE IF NOT EXISTS project_personalities (
    session_path TEXT PRIMARY KEY,
    personality_id INTEGER REFERENCES personalities(id) ON DELETE SET NULL
  )`,

  // Successful autopilot answers — the audit trail. Pairs with the error log
  // (which captures failures) to give a complete picture of what /btw said
  // and on whose behalf. personality_id uses ON DELETE SET NULL so the row
  // survives a personality being removed; personality_name is denormalized
  // at write time so the display stays meaningful in that case.
  `CREATE TABLE IF NOT EXISTS autopilot_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_name TEXT NOT NULL,
    session_path TEXT NOT NULL,
    personality_id INTEGER REFERENCES personalities(id) ON DELETE SET NULL,
    personality_name TEXT,
    raw_question TEXT NOT NULL,
    answer TEXT NOT NULL,
    duration_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_ts ON autopilot_decisions(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_session ON autopilot_decisions(session_name, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_personality ON autopilot_decisions(personality_id, ts DESC)`,

  // Per-decision feedback — captured when the user vetoes ("cancel") or
  // overrides ("edit") an autopilot draft inside the veto window. Lets
  // personalities evolve from real corrections without ML. ON DELETE
  // CASCADE: if the decision row is purged, its feedback goes with it.
  `CREATE TABLE IF NOT EXISTS decision_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL REFERENCES autopilot_decisions(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    edited_answer TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decision_feedback_decision ON decision_feedback(decision_id)`,

  // Web-visible chat history. Persisted per session so reloading the
  // dashboard does not wipe context. Bounded by a per-session purge run
  // hourly. files_json holds attachment paths/URLs as a JSON array string.
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_name TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    files_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_name, ts DESC)`,
]

export function openHubDb(dir: string): HubDbHandle {
  const newPath = join(dir, 'hub.sqlite')
  const oldPath = join(dir, 'errors.sqlite')

  // Migration step — only if the new file does NOT yet exist AND the old
  // file is a real (non-empty) file. Empty/stub files are left alone.
  if (!existsSync(newPath) && existsSync(oldPath)) {
    let oldIsRealFile = false
    try {
      const s = statSync(oldPath)
      oldIsRealFile = s.isFile() && s.size > 0
    } catch {
      // ignore
    }
    if (oldIsRealFile) {
      copyFileSync(oldPath, newPath)
      renameSync(oldPath, oldPath + '.bak')
    }
  }

  const db = new Database(newPath, { create: true })
  // ON DELETE SET NULL on project_personalities.personality_id only fires
  // when foreign-key enforcement is on. SQLite defaults this OFF.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('BEGIN')
  try {
    for (const stmt of [...SCHEMA_STATEMENTS, ...COMPANY_SCHEMA_STATEMENTS]) {
      db.exec(stmt)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    db,
    close: () => db.close(),
  }
}
