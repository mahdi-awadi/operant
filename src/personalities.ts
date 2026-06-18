// src/personalities.ts
// DAO over the personalities + project_personalities tables in operant.sqlite.
// Schema is owned by src/operant-db.ts; this module only does CRUD + seeding.
//
// On construction we upsert the five built-in personalities (matched by
// name). User-created personalities are never touched. Editing a built-in's
// system prompt in this file and restarting the daemon propagates the new
// prompt to existing builtins without disturbing user-created entries.

import { Database } from 'bun:sqlite'

export type ReplyStyle = 'terse' | 'balanced' | 'verbose'
export type RiskTolerance = 'low' | 'medium' | 'high'
export type DefaultWhenUnclear = 'pick_first' | 'pick_safer' | 'escalate'

export type Personality = {
  id: number
  name: string
  description?: string
  systemPrompt: string
  replyStyle?: ReplyStyle
  riskTolerance?: RiskTolerance
  defaultWhenUnclear?: DefaultWhenUnclear
  builtin: boolean
  createdAt: number
  updatedAt: number
}

export type PersonalityInput = {
  name: string
  description?: string
  systemPrompt: string
  replyStyle?: ReplyStyle
  riskTolerance?: RiskTolerance
  defaultWhenUnclear?: DefaultWhenUnclear
}

type Row = {
  id: number
  name: string
  description: string | null
  system_prompt: string
  reply_style: string | null
  risk_tolerance: string | null
  default_when_unclear: string | null
  builtin: number
  created_at: number
  updated_at: number
}

// The 5 starter personalities. Each system_prompt is a SELF-CONTAINED
// constraint block — wrapQuestion splices it in place of the default block.
// The risk-keyword backstop and ESCALATE rule are applied independently
// upstream and DO NOT need to be repeated here.
export const BUILTIN_NAMES = [
  'Senior Engineer',
  'Pragmatist',
  'Architect',
  'Safety-First',
  'Researcher',
] as const

const BUILTIN_DEFINITIONS: PersonalityInput[] = [
  {
    name: 'Senior Engineer',
    description: 'Balanced, conventional, decisive. The default voice — pick the canonical option, explain briefly, escalate only on truly irreversible calls.',
    replyStyle: 'terse',
    riskTolerance: 'medium',
    defaultWhenUnclear: 'pick_safer',
    systemPrompt: [
      'Constraints:',
      '- Reply in ENGLISH ONLY. No emojis or pictographic symbols. Plain text.',
      '- Be decisive: pick one option clearly. State the decision in the first sentence.',
      '- Be concise: explain the chosen option in 2-3 short sentences citing project context.',
      '- Total reply under 600 characters / 100 words.',
      '- Default to canonical, well-established conventions over quick hacks.',
      '- If the choice is irreversible (delete data, force push, prod deploy, paid service, billing, remove auth), reply EXACTLY: ESCALATE: <one-sentence reason>',
      '- Answer as the user, not about the user. No preamble. No "Based on...".',
    ].join('\n'),
  },
  {
    name: 'Pragmatist',
    description: 'Picks the option that ships fastest. Accepts technical debt for velocity. Use for prototypes, throwaway projects, or when the user explicitly wants speed.',
    replyStyle: 'terse',
    riskTolerance: 'high',
    defaultWhenUnclear: 'pick_first',
    systemPrompt: [
      'Constraints:',
      '- Reply in ENGLISH ONLY. No emojis. Plain text.',
      '- Be decisive: pick the option that ships sooner. Note the trade-off in one short clause.',
      '- Total reply under 400 characters / 70 words.',
      '- Optimize for VELOCITY. Accept tech debt that can be paid down later. The cleaner option only wins when speed is roughly tied.',
      '- If the choice is irreversible (delete data, force push, prod deploy, paid service, billing, remove auth), reply EXACTLY: ESCALATE: <one-sentence reason>',
      '- Answer as the user, not about the user. No preamble.',
    ].join('\n'),
  },
  {
    name: 'Architect',
    description: 'Optimizes for long-term maintainability and extensibility. Willing to do more upfront work for cleaner shape. Use on libraries, public APIs, or core infrastructure.',
    replyStyle: 'verbose',
    riskTolerance: 'low',
    defaultWhenUnclear: 'pick_safer',
    systemPrompt: [
      'Constraints:',
      '- Reply in ENGLISH ONLY. No emojis. Plain text.',
      '- Be decisive: pick the option with the cleaner long-term shape. Explain the architectural trade-off in 3-5 sentences.',
      '- Total reply under 600 characters / 100 words.',
      '- Optimize for MAINTAINABILITY, EXTENSIBILITY, and consistency with how the wider community/framework solves the same problem.',
      '- Accept upfront work in exchange for a cleaner seam, easier testing, or fewer breaking changes later.',
      '- If neither option is ideal but one is closer to canonical, lean toward it; briefly note the stronger improvement only when obvious.',
      '- If the choice is irreversible (delete data, force push, prod deploy, paid service, billing, remove auth), reply EXACTLY: ESCALATE: <one-sentence reason>',
      '- Answer as the user, not about the user. No preamble.',
    ].join('\n'),
  },
  {
    name: 'Safety-First',
    description: 'Conservative. Escalates on any non-trivial risk, prefers the safer option, never auto-approves anything paid or destructive. Use on production-touching projects.',
    replyStyle: 'balanced',
    riskTolerance: 'low',
    defaultWhenUnclear: 'escalate',
    systemPrompt: [
      'Constraints:',
      '- Reply in ENGLISH ONLY. No emojis. Plain text.',
      '- Total reply under 500 characters / 80 words.',
      '- Default position: WHEN IN DOUBT, ESCALATE. The user can override; do not assume that authority yourself.',
      '- Pick the safer option. "Safer" means: smaller blast radius, easier to undo, fewer external dependencies, less data exposure.',
      '- Reply EXACTLY: ESCALATE: <one-sentence reason> for ANY of: irreversible action (delete, force push, drop, prod deploy, remove auth, change billing), adding a paid service, third-party integration with new credentials, or a choice you are less than ~80% confident on.',
      '- When you do answer, state the safer option in the first sentence and the risk it avoids in the second.',
      '- Answer as the user, not about the user. No preamble.',
    ].join('\n'),
  },
  {
    name: 'Researcher',
    description: 'RFC-style. Verbose, comparative, lays out the trade-offs. Use during spec writing, architecture discussions, or open-ended exploration.',
    replyStyle: 'verbose',
    riskTolerance: 'medium',
    defaultWhenUnclear: 'pick_safer',
    systemPrompt: [
      'Constraints:',
      '- Reply in ENGLISH ONLY. No emojis. Plain text.',
      '- Total reply under 600 characters / 100 words. Stay decisive — this is a recommendation, not a survey.',
      '- Structure: (1) the chosen option in the first sentence, (2) the strongest alternative and why it lost in 1-2 sentences, (3) the key open question worth tracking if it ever does.',
      '- Cite project context, prior decisions, autopilot.md preferences where they map. Be concrete.',
      '- If the choice is irreversible (delete data, force push, prod deploy, paid service, billing, remove auth), reply EXACTLY: ESCALATE: <one-sentence reason>',
      '- Answer as the user, not about the user. No preamble.',
    ].join('\n'),
  },
]

function rowToPersonality(r: Row): Personality {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    systemPrompt: r.system_prompt,
    replyStyle: (r.reply_style as ReplyStyle | null) ?? undefined,
    riskTolerance: (r.risk_tolerance as RiskTolerance | null) ?? undefined,
    defaultWhenUnclear: (r.default_when_unclear as DefaultWhenUnclear | null) ?? undefined,
    builtin: r.builtin === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class Personalities {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.seedBuiltins()
  }

  private seedBuiltins(): void {
    const now = Date.now()
    const existing = this.db.prepare(`SELECT name FROM personalities WHERE builtin = 1`).all() as { name: string }[]
    const existingByName = new Map(existing.map((r) => [r.name, true]))
    for (const def of BUILTIN_DEFINITIONS) {
      if (existingByName.has(def.name)) {
        // Refresh the prompt + meta fields in case the definitions in this
        // file evolved since first seed. Don't bump createdAt.
        this.db.prepare(
          `UPDATE personalities
           SET description = ?, system_prompt = ?, reply_style = ?, risk_tolerance = ?, default_when_unclear = ?, updated_at = ?
           WHERE name = ? AND builtin = 1`,
        ).run(
          def.description ?? null,
          def.systemPrompt,
          def.replyStyle ?? null,
          def.riskTolerance ?? null,
          def.defaultWhenUnclear ?? null,
          now,
          def.name,
        )
      } else {
        this.db.prepare(
          `INSERT INTO personalities
           (name, description, system_prompt, reply_style, risk_tolerance, default_when_unclear, builtin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          def.name,
          def.description ?? null,
          def.systemPrompt,
          def.replyStyle ?? null,
          def.riskTolerance ?? null,
          def.defaultWhenUnclear ?? null,
          now,
          now,
        )
      }
    }
  }

  listAll(): Personality[] {
    const rows = this.db.prepare(
      `SELECT * FROM personalities ORDER BY builtin DESC, name COLLATE NOCASE ASC`,
    ).all() as Row[]
    return rows.map(rowToPersonality)
  }

  getById(id: number): Personality | undefined {
    const r = this.db.prepare(`SELECT * FROM personalities WHERE id = ?`).get(id) as Row | undefined
    return r ? rowToPersonality(r) : undefined
  }

  getByName(name: string): Personality | undefined {
    const r = this.db.prepare(`SELECT * FROM personalities WHERE name = ? COLLATE NOCASE`).get(name) as Row | undefined
    return r ? rowToPersonality(r) : undefined
  }

  create(input: PersonalityInput): Personality {
    const now = Date.now()
    const result = this.db.prepare(
      `INSERT INTO personalities
       (name, description, system_prompt, reply_style, risk_tolerance, default_when_unclear, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      input.name,
      input.description ?? null,
      input.systemPrompt,
      input.replyStyle ?? null,
      input.riskTolerance ?? null,
      input.defaultWhenUnclear ?? null,
      now,
      now,
    )
    return this.getById(Number(result.lastInsertRowid))!
  }

  update(id: number, partial: Partial<PersonalityInput>): Personality {
    if ('builtin' in partial) {
      throw new Error('Cannot change the builtin flag through update()')
    }
    const existing = this.getById(id)
    if (!existing) throw new Error(`No personality with id ${id}`)
    const merged = { ...existing, ...partial }
    this.db.prepare(
      `UPDATE personalities
       SET name = ?, description = ?, system_prompt = ?, reply_style = ?, risk_tolerance = ?, default_when_unclear = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      merged.name,
      merged.description ?? null,
      merged.systemPrompt,
      merged.replyStyle ?? null,
      merged.riskTolerance ?? null,
      merged.defaultWhenUnclear ?? null,
      Date.now(),
      id,
    )
    return this.getById(id)!
  }

  deleteById(id: number): void {
    const p = this.getById(id)
    if (!p) return
    if (p.builtin) {
      throw new Error(`Cannot delete a built-in personality (${p.name})`)
    }
    // ON DELETE SET NULL on project_personalities.personality_id handles the
    // cascade — sessions with this personality revert to the default.
    this.db.prepare(`DELETE FROM personalities WHERE id = ?`).run(id)
  }

  assignToSession(sessionPath: string, personalityId: number): void {
    this.db.prepare(
      `INSERT INTO project_personalities (session_path, personality_id)
       VALUES (?, ?)
       ON CONFLICT(session_path) DO UPDATE SET personality_id = excluded.personality_id`,
    ).run(sessionPath, personalityId)
  }

  removeFromSession(sessionPath: string): void {
    this.db.prepare(`DELETE FROM project_personalities WHERE session_path = ?`).run(sessionPath)
  }

  getForSession(sessionPath: string): Personality | undefined {
    const r = this.db.prepare(
      `SELECT p.*
       FROM project_personalities pp
       JOIN personalities p ON p.id = pp.personality_id
       WHERE pp.session_path = ?`,
    ).get(sessionPath) as Row | undefined
    return r ? rowToPersonality(r) : undefined
  }
}
