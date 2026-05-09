// src/rubika-invites.ts
// One-time invite codes that bind a Rubika sender_id to a Claude session.
// An owner mints a code, shares it out-of-band, the future guest texts the
// code to the bot, and the bot pins their senderId → session. Pins persist
// across daemon restarts via rubika-invites.json next to the rest of hub
// state. Codes are 6-char A-Z0-9, expire after 24h, and consumed on claim.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

export type RubikaInvite = {
  code: string
  sessionName: string
  createdAt: number
  expiresAt: number
}

export type RubikaPin = {
  sessionName: string
  claimedAt: number
}

type StoreFile = {
  pendingInvites: Record<string, { sessionName: string; createdAt: number; expiresAt: number }>
  pins: Record<string, RubikaPin>
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const FILENAME = 'rubika-invites.json'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // strip 0/O/1/I for legibility
const CODE_LEN = 6

export type RubikaInviteStoreOpts = {
  dir: string
  now?: () => number
  ttlMs?: number
}

export class RubikaInviteStore {
  private readonly path: string
  private readonly now: () => number
  private readonly ttlMs: number
  private pendingInvites: Map<string, { sessionName: string; createdAt: number; expiresAt: number }> = new Map()
  private pins: Map<string, RubikaPin> = new Map()

  constructor(opts: RubikaInviteStoreOpts) {
    this.path = join(opts.dir, FILENAME)
    this.now = opts.now ?? (() => Date.now())
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    this.load()
  }

  private load(): void {
    let raw: StoreFile | null = null
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
    } catch {
      raw = null
    }
    if (!raw || typeof raw !== 'object') return
    if (raw.pendingInvites) {
      for (const [code, inv] of Object.entries(raw.pendingInvites)) {
        if (inv && typeof inv.sessionName === 'string') {
          this.pendingInvites.set(code, {
            sessionName: inv.sessionName,
            createdAt: typeof inv.createdAt === 'number' ? inv.createdAt : 0,
            expiresAt: typeof inv.expiresAt === 'number' ? inv.expiresAt : 0,
          })
        }
      }
    }
    if (raw.pins) {
      for (const [sid, pin] of Object.entries(raw.pins)) {
        if (pin && typeof pin.sessionName === 'string') {
          this.pins.set(sid, {
            sessionName: pin.sessionName,
            claimedAt: typeof pin.claimedAt === 'number' ? pin.claimedAt : 0,
          })
        }
      }
    }
  }

  private save(): void {
    const data: StoreFile = {
      pendingInvites: Object.fromEntries(this.pendingInvites),
      pins: Object.fromEntries(this.pins),
    }
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private generateCode(): string {
    while (true) {
      const buf = randomBytes(CODE_LEN)
      let code = ''
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length]
      }
      if (!this.pendingInvites.has(code)) return code
    }
  }

  mintInvite(sessionName: string, ttlMsOverride?: number): string {
    const code = this.generateCode()
    const createdAt = this.now()
    const ttl = ttlMsOverride ?? this.ttlMs
    this.pendingInvites.set(code, {
      sessionName,
      createdAt,
      expiresAt: createdAt + ttl,
    })
    this.save()
    return code
  }

  // Returns the session name the sender is now pinned to, or null if the code
  // was unknown, expired, or already consumed.
  claim(code: string, senderId: string): string | null {
    const upper = code.trim().toUpperCase()
    const inv = this.pendingInvites.get(upper)
    if (!inv) return null
    if (inv.expiresAt < this.now()) {
      // Expired — clean it up.
      this.pendingInvites.delete(upper)
      this.save()
      return null
    }
    this.pendingInvites.delete(upper)
    this.pins.set(senderId, { sessionName: inv.sessionName, claimedAt: this.now() })
    this.save()
    return inv.sessionName
  }

  getPin(senderId: string): string | null {
    return this.pins.get(senderId)?.sessionName ?? null
  }

  unpin(senderId: string): boolean {
    if (!this.pins.has(senderId)) return false
    this.pins.delete(senderId)
    this.save()
    return true
  }

  peekInvite(code: string): RubikaInvite | null {
    const upper = code.trim().toUpperCase()
    const inv = this.pendingInvites.get(upper)
    if (!inv) return null
    return { code: upper, ...inv }
  }

  listPendingInvites(): RubikaInvite[] {
    const now = this.now()
    const out: RubikaInvite[] = []
    for (const [code, inv] of this.pendingInvites) {
      if (inv.expiresAt < now) continue
      out.push({ code, ...inv })
    }
    return out
  }

  listPins(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [sid, pin] of this.pins) out[sid] = pin.sessionName
    return out
  }
}
