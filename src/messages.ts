// src/messages.ts
// Persisted chat history for the web dashboard. Both directions are stored:
// user-typed messages (role='user') and Claude/autopilot/escalation messages
// rendered into the chat (role='claude'). Lets a hard refresh of the
// dashboard restore the visible conversation.

import { Database } from 'bun:sqlite'

export type MessageRole = 'user' | 'claude'

export type MessageEntry = {
  id?: number
  ts: number              // epoch ms
  sessionName: string
  role: MessageRole
  text: string
  files?: string[]
}

type Row = {
  id: number
  ts: number
  session_name: string
  role: string
  text: string
  files_json: string | null
}

function rowToEntry(r: Row): MessageEntry {
  let files: string[] | undefined
  if (r.files_json) {
    try {
      const parsed = JSON.parse(r.files_json)
      if (Array.isArray(parsed)) files = parsed.map(String)
    } catch {
      // malformed JSON in files_json — treat as no attachments
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    sessionName: r.session_name,
    role: r.role as MessageRole,
    text: r.text,
    files,
  }
}

export class Messages {
  constructor(private db: Database) {}

  record(e: MessageEntry): number {
    const filesJson = e.files && e.files.length > 0 ? JSON.stringify(e.files) : null
    const r = this.db.prepare(
      `INSERT INTO messages (ts, session_name, role, text, files_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(e.ts, e.sessionName, e.role, e.text, filesJson)
    return Number(r.lastInsertRowid)
  }

  recent(opts: { session: string; limit?: number }): MessageEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_name = ? ORDER BY ts DESC LIMIT ?`)
      .all(opts.session, limit) as Row[]
    return rows.map(rowToEntry)
  }

  // Bound storage at N per session so chatty sessions don't push out the
  // forensic data from quiet ones. Daemon calls hourly.
  purgeKeepLastPerSession(keep: number): void {
    const k = Math.max(0, Math.floor(keep))
    this.db.exec(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY session_name ORDER BY ts DESC) AS rn
          FROM messages
        ) WHERE rn > ${k}
      )
    `)
  }
}
