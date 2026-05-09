// src/frontends/rubika.ts
// Rubika bot frontend — webhook-based MVP.
//
// Rubika's bot product is shaped like Telegram's but the wire format is
// different (different base URL, message envelope, button system, no public
// SDK). This module hand-rolls a small HTTP client + webhook handler that
// translates Rubika's `NewMessage` updates into channelhub's
// `MessageRouter.routeToSession` calls.
//
// Auth model:
//   - Webhook URL contains an HMAC-derived secret segment so the URL itself
//     is unguessable. Rubika has no native secret-token header (Telegram
//     does), so the secret in the path is our only proof-of-origin.
//   - Every inbound message is also checked against `rubikaAllowFrom` —
//     same trust boundary as Telegram. Empty allowFrom = deny-all.
//
// Scope (MVP, day-1):
//   - sendMessage fan-out via deliverToUser after inbound chat_id discovery
//   - inbound NewMessage routing to the user's active session
//   - per-user activeSession map, defaulting to the first active session
//   - NO commands, permission UI, autopilot draft buttons, file uploads —
//     those layer on in a follow-up PR per the agreed staged-rollout.

import { createHmac } from 'node:crypto'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { SessionState } from '../types'
import type { PermissionEngine } from '../permission-engine'
import type { ScreenManager, ResumeSpec } from '../screen-manager'
import type { SocketServer } from '../socket-server'
import type { TaskMonitor } from '../task-monitor'
import type { VerificationRunner } from '../verification'
import type { VetoController } from '../veto-controller'
import type { AutopilotRunner } from '../autopilot'
// Type-only imports below are reserved for later tasks (Tasks 7-17).
import type { PermissionRequest, TrustLevel, Profile } from '../types'
import type { VerificationResult } from '../verification'
import { getProfile } from '../profiles' // used in Task 7
import { loadProfilesForHub, saveProfilesForHub, saveSessions } from '../config' // used in Tasks 7-12
import { stripAnsi, tailToCharLimit, parsePeekArgs } from '../peek-helpers'

const DEFAULT_API_BASE = 'https://botapi.rubika.ir/v3'

// ── Pure helpers (exported for testability) ─────────────────────────────────

export function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+/)
  const command = parts[0] ?? ''
  const args = parts.slice(1).filter((a) => a.length > 0)
  return { command, args }
}

export function formatSessionList(sessions: SessionState[], activeSession: string | null): string {
  if (sessions.length === 0) return 'No sessions connected.'
  return sessions.map((s) => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const trustLabel = s.trust === 'auto' ? ' [auto]' : ''
    const activeMarker = s.name === activeSession ? ' ← active' : ''
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    return `${icon} ${s.name}${trustLabel}${activeMarker}${autopilotBadge}`
  }).join('\n')
}

export function formatStatus(sessions: SessionState[]): string {
  if (sessions.length === 0) return 'No sessions connected.'
  return sessions.map((s) => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    const parts = [`${icon} ${s.name}${autopilotBadge} (${s.status})`]
    parts.push(`  path: ${s.path}`)
    parts.push(`  trust: ${s.trust}`)
    if (s.prefix) parts.push(`  prefix: ${s.prefix}`)
    return parts.join('\n')
  }).join('\n\n')
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit)
    const lastNewline = slice.lastIndexOf('\n')
    const cutAt = lastNewline > 0 ? lastNewline + 1 : limit
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export function deriveInlineWebhookSecret(token: string): string {
  return createHmac('sha256', 'channelhub-rubika-inline-webhook')
    .update(token)
    .digest('base64url')
}

// ── Types ────────────────────────────────────────────────────────────────────

export type RubikaSendFn = (method: string, body: unknown) => Promise<unknown>

export type RubikaFrontendDeps = {
  token: string
  allowFrom: string[]
  // sender_id → pinned session name. Guests bypass allowFrom, are always
  // routed to their pinned session, and may not run any /command.
  guests?: Record<string, string>
  registry: SessionRegistry
  router: MessageRouter
  // New deps for command parity:
  permissions?: PermissionEngine
  screenManager?: ScreenManager
  socketServer?: SocketServer
  taskMonitor?: TaskMonitor | null
  verificationRunner?: VerificationRunner
  vetoController?: VetoController
  autopilotRunner?: AutopilotRunner
  apiBase?: string
  webhookBase?: string
  sender?: RubikaSendFn
  /** getUpdates polling interval in ms. Default 2000. Set to 0 to disable. Min 1000 (enforced). */
  pollingIntervalMs?: number
}

// Inbound payload shape per the Rubika docs. We only extract what we need.
export type RubikaUpdateBody = {
  update?: {
    type: string
    chat_id: string
    new_message?: {
      message_id: string
      text: string
      time: string
      is_edited: boolean
      sender_type: 'User' | 'Bot'
      sender_id: string
      aux_data?: { start_id: string | null; button_id: string | null }
      // TODO: field name unverified — no file messages in live queue at implementation
      // time. `file_inline` matches the outbound field name used by Rubika for
      // sendMessage; `file` is a possible legacy alias. Adjust if the live API
      // returns a different key when a user sends a photo/document.
      file_inline?: { file_id: string; file_name: string; size?: number; type?: string }
      // Reply-to fields. Rubika's actual key is unverified at coding time;
      // both shapes are checked at runtime so the feature degrades gracefully
      // if the wire format differs.
      reply_to_message_id?: string
      reply_to_message?: { message_id?: string }
    }
  } | null
  // Rubika delivers inline-button clicks on a separate endpoint; we ignore
  // them in MVP. Type defined for forward compat.
  inline_message?: unknown
}

export type RubikaInlineMessageBody = {
  inline_message?: {
    chat_id: string
    sender_id: string
    message_id: string
    aux_data?: { button_id?: string; start_id?: string | null }
  } | null
}

// ── Secret derivation ────────────────────────────────────────────────────────

// HMAC the bot token under a static label. Result is base64url so it's safe
// in a URL path. The token itself never leaves config.json.
export function deriveWebhookSecret(token: string): string {
  return createHmac('sha256', 'channelhub-rubika-webhook')
    .update(token)
    .digest('base64url')
}

// ── Frontend ─────────────────────────────────────────────────────────────────

export class RubikaFrontend {
  readonly webhookPath: string
  readonly inlineWebhookPath: string
  private deps: RubikaFrontendDeps
  private apiBase: string
  private send: RubikaSendFn
  private activeSessionByUser = new Map<string, string>()
  private chatIdByUser = new Map<string, string>()
  // Frozen snapshot of rubikaGuests at construction. Guests are pinned: they
  // bypass allowFrom, route only to their session, and cannot run commands.
  private readonly guests: Map<string, string>
  // Per-chat ring buffer of outgoing-message → session mappings. When the
  // user replies to a bot message, we look up the original session here and
  // route there instead of the active one. Capped per-chat; oldest evicted.
  private messageMap = new Map<string, Array<{ messageId: string; sessionName: string }>>()
  private static readonly MESSAGE_MAP_CAP = 200
  // Updates captured at bootstrap time, awaiting the user's Drain/Keep choice.
  // Keyed by sender_id — each entry holds the inbound updates that landed in
  // Rubika's queue while the daemon was offline. We do NOT process them until
  // the user answers the restart prompt.
  private pendingRestartBacklog = new Map<string, RubikaUpdateBody[]>()
  private started = false
  private permissions?: PermissionEngine
  private screenManager?: ScreenManager
  private socketServer?: SocketServer
  private taskMonitor: TaskMonitor | null
  private verificationRunner?: VerificationRunner
  private vetoController?: VetoController
  private autopilotRunner?: AutopilotRunner
  // Polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private nextOffsetId: string | null = null
  private polling = false
  private readonly pollingIntervalMs: number

  constructor(deps: RubikaFrontendDeps) {
    this.deps = deps
    this.apiBase = deps.apiBase ?? DEFAULT_API_BASE
    this.send = deps.sender ?? this.realSend.bind(this)
    this.webhookPath = `/api/rubika/webhook/${deriveWebhookSecret(deps.token)}`
    this.permissions = deps.permissions
    this.screenManager = deps.screenManager
    this.socketServer = deps.socketServer
    this.taskMonitor = deps.taskMonitor ?? null
    this.verificationRunner = deps.verificationRunner
    this.vetoController = deps.vetoController
    this.autopilotRunner = deps.autopilotRunner
    this.inlineWebhookPath = `/api/rubika/inline-webhook/${deriveInlineWebhookSecret(deps.token)}`
    this.guests = new Map(Object.entries(deps.guests ?? {}))
    // pollingIntervalMs: 0 = disabled; otherwise enforce min 1000ms, default 2000ms
    const raw = deps.pollingIntervalMs
    if (raw === 0) {
      this.pollingIntervalMs = 0
    } else if (raw === undefined) {
      this.pollingIntervalMs = 2000
    } else {
      this.pollingIntervalMs = Math.max(1000, raw)
    }
  }

  // Tell Rubika where to POST updates. Idempotent — safe to call on each
  // daemon boot. Logs but does not throw on failure so a temporarily
  // unreachable Rubika doesn't block daemon startup.
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.deps.webhookBase) {
      const base = this.deps.webhookBase.replace(/\/$/, '')
      const updateUrl = `${base}${this.webhookPath}`
      const inlineUrl = `${base}${this.inlineWebhookPath}`
      await this.registerEndpoint('ReceiveUpdate', updateUrl)
      await this.registerEndpoint('ReceiveInlineMessage', inlineUrl)
    } else {
      process.stderr.write('rubika: rubikaWebhookBase not configured — webhooks NOT registered\n')
    }

    if (this.pollingIntervalMs > 0) {
      // Bootstrap: pull every queued update from while the daemon was offline,
      // harvest chat_ids, and capture the updates per sender. We do NOT
      // dispatch them yet — the user gets a Drain/Keep prompt and decides.
      // Loop until Rubika says the queue is empty (updates < limit) so we
      // never leave stale messages behind to be replayed on the first poll.
      try {
        let drained = 0
        for (let guard = 0; guard < 20; guard++) {
          const resp = (await this.send('getUpdates', { limit: 50, offset_id: this.nextOffsetId ?? '' })) as { updates?: unknown[]; next_offset_id?: string }
          const updates = (resp?.updates ?? []) as RubikaUpdateBody['update'][]
          for (const u of updates) {
            if (!u) continue
            const senderId = u.new_message?.sender_id
            const chatId = u.chat_id
            if (senderId && chatId && this.deps.allowFrom.includes(senderId)) {
              this.chatIdByUser.set(senderId, chatId)
              const list = this.pendingRestartBacklog.get(senderId) ?? []
              list.push({ update: u })
              this.pendingRestartBacklog.set(senderId, list)
            }
          }
          if (resp?.next_offset_id !== undefined) {
            this.nextOffsetId = resp.next_offset_id
          }
          drained += updates.length
          if (updates.length < 50) break
        }
        process.stderr.write(`rubika: bootstrap drained ${drained}; pending for ${this.pendingRestartBacklog.size} sender(s)\n`)
        for (const [senderId, list] of this.pendingRestartBacklog) {
          await this.sendRestartPrompt(senderId, list).catch((err) => {
            process.stderr.write(`rubika: sendRestartPrompt failed for ${senderId}: ${err}\n`)
          })
        }
      } catch (err) {
        process.stderr.write(`rubika: bootstrap getUpdates failed (will retry on first poll): ${err}\n`)
      }
      this.pollTimer = setInterval(() => { this.pollOnce().catch(() => {}) }, this.pollingIntervalMs)
    }
  }

  private async sendRestartPrompt(senderId: string, list: RubikaUpdateBody[]): Promise<void> {
    const chatId = this.chatIdByUser.get(senderId)
    if (!chatId) return
    const lines = list.map((b, i) => {
      const text = b.update?.new_message?.text ?? '(non-text update)'
      const trimmed = text.length > 80 ? text.slice(0, 77) + '...' : text
      return `${i + 1}. ${trimmed}`
    })
    const text =
      `⚠️ ${list.length} message${list.length === 1 ? '' : 's'} arrived while I was offline:\n\n` +
      lines.join('\n') +
      `\n\nDrain (drop everything) or Keep (process them as if fresh)?`
    await this.sendButtons(chatId, text, [[
      { id: `restart:keep:${senderId}`, label: 'Keep & process' },
      { id: `restart:drain:${senderId}`, label: 'Drain' },
    ]])
  }

  private async registerEndpoint(type: 'ReceiveUpdate' | 'ReceiveInlineMessage', url: string): Promise<void> {
    try {
      await this.send('updateBotEndpoints', { type, url })
      process.stderr.write(`rubika: ${type} webhook registered → ${url}\n`)
    } catch (err) {
      process.stderr.write(`rubika: failed to register ${type} (${err})\n`)
    }
  }

  async refreshEndpoints(): Promise<void> {
    if (!this.deps.webhookBase) return
    const base = this.deps.webhookBase.replace(/\/$/, '')
    await this.registerEndpoint('ReceiveUpdate', `${base}${this.webhookPath}`)
    await this.registerEndpoint('ReceiveInlineMessage', `${base}${this.inlineWebhookPath}`)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.polling = false
    // Webhook mode: Rubika keeps the registered endpoint until we change it.
    // We don't deregister on stop — a daemon restart should not drop messages
    // mid-flight.
  }

  // ── Polling (getUpdates fallback) ────────────────────────────────────────

  /** Public for tests — runs one poll cycle immediately. */
  async pollNow(): Promise<void> {
    return this.pollOnce()
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const resp = (await this.send('getUpdates', {
        limit: 50,
        offset_id: this.nextOffsetId ?? '',
      })) as { updates?: unknown[]; next_offset_id?: string }
      const updates = resp?.updates ?? []
      if (updates.length > 0) {
        process.stderr.write(`rubika: poll delivered ${updates.length} update(s)\n`)
        for (const update of updates) {
          const u = update as { type?: string; chat_id?: string; new_message?: unknown }
          if (u.type === 'NewMessage') {
            // Rubika delivers inline-button clicks through getUpdates as a
            // NewMessage with `aux_data.button_id` set. The webhook path uses
            // separate ReceiveInlineMessage envelopes, but in polling mode we
            // see them mixed in here. Detect and route to handleInlineWebhook
            // so command/permission/veto/drift buttons all work.
            const inner = u as { chat_id?: string; new_message?: { text?: string; sender_id?: string; message_id?: string; aux_data?: { button_id?: string } } }
            const buttonId = inner.new_message?.aux_data?.button_id
            if (buttonId && /^(select:|perm:|ap-|drift:|restart:)/.test(buttonId)) {
              this.handleInlineWebhook({
                inline_message: {
                  chat_id: inner.chat_id ?? '',
                  sender_id: inner.new_message?.sender_id ?? '',
                  message_id: inner.new_message?.message_id ?? '',
                  aux_data: { button_id: buttonId },
                },
              })
              continue
            }
            const body: RubikaUpdateBody = { update: u as RubikaUpdateBody['update'] }
            this.handleWebhook(body)
          }
        }
      }
      if (resp?.next_offset_id !== undefined) {
        this.nextOffsetId = resp.next_offset_id
      }
    } catch (err) {
      process.stderr.write(`rubika: poll failed: ${err}\n`)
    } finally {
      this.polling = false
    }
  }

  // ── Reply-to-message routing ─────────────────────────────────────────────

  /** Pull a Rubika message_id out of a sendMessage/sendFile/sendButtons response.
   * Rubika's response shape varies by method and isn't fully documented in our
   * codebase; defensive across the two known variants. Returns null if the
   * response shape doesn't carry one — caller logs and moves on.
   */
  private extractMessageId(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null
    const r = response as { message_update?: { message_id?: unknown }; message_id?: unknown }
    if (typeof r.message_id === 'string' && r.message_id.length > 0) return r.message_id
    if (r.message_update && typeof r.message_update.message_id === 'string' && r.message_update.message_id.length > 0) {
      return r.message_update.message_id
    }
    return null
  }

  /** Record an outgoing message_id ↔ sessionName for this chat so a future
   * reply-to-message inbound update can be routed back to the right session.
   */
  private recordOutgoing(chatId: string, sessionName: string, response: unknown): void {
    const messageId = this.extractMessageId(response)
    if (!messageId) return
    const list = this.messageMap.get(chatId) ?? []
    list.push({ messageId, sessionName })
    if (list.length > RubikaFrontend.MESSAGE_MAP_CAP) {
      list.splice(0, list.length - RubikaFrontend.MESSAGE_MAP_CAP)
    }
    this.messageMap.set(chatId, list)
  }

  /** Look up the session a given inbound reply-to message originally came from. */
  private lookupReplyTarget(chatId: string, replyToMessageId: string): string | null {
    const list = this.messageMap.get(chatId)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.messageId === replyToMessageId) return list[i]!.sessionName
    }
    return null
  }

  // ── Outbound (Claude → user) ─────────────────────────────────────────────
  async deliverPermissionRequest(req: PermissionRequest): Promise<void> {
    if (this.deps.allowFrom.length === 0) return
    const text = `🔒 ${req.sessionName} wants to use *${req.toolName}*\n\n${req.inputPreview ?? ''}`
    for (const senderId of this.deps.allowFrom) {
      const chatId = this.chatIdByUser.get(senderId)
      if (!chatId) continue
      const resp = await this.sendButtons(chatId, text, [[
        { id: `perm:allow:${req.requestId}`, label: 'Allow' },
        { id: `perm:deny:${req.requestId}`, label: 'Deny' },
      ]])
      this.recordOutgoing(chatId, req.sessionName, resp)
    }
  }

  async deliverToUser(sessionName: string, text: string, files?: string[]): Promise<void> {
    // Recipients = allowFrom owners + guests pinned to this session.
    // Either set may be empty; we still proceed if the other has chat_ids.
    const recipientSenderIds = new Set<string>(this.deps.allowFrom)
    for (const [guestId, pinned] of this.guests) {
      if (pinned === sessionName) recipientSenderIds.add(guestId)
    }
    if (recipientSenderIds.size === 0) return
    const fullText = `[${sessionName}] ${text}`
    for (const senderId of recipientSenderIds) {
      const chatId = this.chatIdByUser.get(senderId)
      if (!chatId) continue
      try {
        if (files && files.length > 0) {
          for (let i = 0; i < files.length; i++) {
            try {
              const mime = await guessMime(files[i]!)
              const meta = await this.uploadFile(files[i]!, mime)
              // Rubika delivers attached files via sendFile with a flat body
              // (chat_id, file_id, type, file_name, size, text). sendMessage
              // with file_inline returns OK but the photo never renders for
              // the recipient — verified 2026-05-02 against the live server.
              const resp = await this.send('sendFile', {
                chat_id: chatId,
                file_id: meta.file_id,
                type: meta.type,
                file_name: meta.file_name,
                size: meta.size,
                text: i === 0 ? fullText : '',
              })
              this.recordOutgoing(chatId, sessionName, resp)
            } catch (err) {
              process.stderr.write(`rubika: upload failed for ${files[i]}: ${err}\n`)
              const reason = err instanceof Error ? err.message : String(err)
              const resp = await this.send('sendMessage', {
                chat_id: chatId,
                text: `[upload failed: ${files[i]} — ${reason}]\n${i === 0 ? fullText : ''}`,
              })
              this.recordOutgoing(chatId, sessionName, resp)
            }
          }
        } else {
          const resp = await this.send('sendMessage', { chat_id: chatId, text: fullText })
          this.recordOutgoing(chatId, sessionName, resp)
        }
      } catch (err) {
        process.stderr.write(`rubika: deliverToUser to ${chatId} failed: ${err}\n`)
      }
    }
  }

  // ── Inbound (user → daemon) ──────────────────────────────────────────────
  // Called from the WebFrontend route handler when Rubika POSTs to the
  // webhook URL. Synchronous in spirit — we route immediately and respond
  // 200 to Rubika.
  handleWebhook(body: RubikaUpdateBody): void {
    const inner = body?.update
    if (!inner || inner.type !== 'NewMessage' || !inner.new_message) return
    const m = inner.new_message
    if (m.sender_type !== 'User') return
    const senderId = m.sender_id
    const guestSession = this.guests.get(senderId)
    if (!guestSession && !this.deps.allowFrom.includes(senderId)) {
      process.stderr.write(`rubika: rejecting message from non-allowed sender ${senderId}\n`)
      return
    }
    this.chatIdByUser.set(senderId, inner.chat_id)

    // ── Inbound file (photo / document) ─────────────────────────────────────
    // Rubika uses `file` for inbound (verified 2026-05-02 via real photo); the
    // outbound shape is `file_inline`. Accept both — the old guess is harmless.
    const inboundFile =
      ((m as any).file ?? (m as any).file_inline) as { file_id: string; file_name: string; type?: string } | undefined
    if (inboundFile) {
      const target = guestSession ?? this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
      if (!target) {
        this.send('sendMessage', { chat_id: inner.chat_id, text: 'No active session.' }).catch(() => {})
        return
      }
      const sessionPath = this.deps.registry.findByName(target)
      const sess = sessionPath ? this.deps.registry.get(sessionPath) : null
      if (!sessionPath || !sess) return
      const folderPath = this.deps.registry.folderPath(sessionPath)
      const caption = (m.text || '').trim()
      this.saveInboundFile(senderId, inner.chat_id, sessionPath, target, folderPath, sess.uploadDir, inboundFile, caption).catch((err) => {
        this.send('sendMessage', { chat_id: inner.chat_id, text: `⚠️ Could not save file: ${err}` }).catch(() => {})
      })
      return
    }

    const text = (m.text || '').trim()
    if (text.length === 0) return

    // Guests are locked to their pinned session: every command (/list, /spawn,
    // /<other-session>, even /<their-own-session>) is rejected; reply-to
    // routing is ignored; text always goes to the pinned session.
    if (guestSession) {
      if (text.startsWith('/')) {
        this.send('sendMessage', { chat_id: inner.chat_id, text: 'Not available.' })
          .catch((err) => process.stderr.write(`rubika: guest reject ack failed: ${err}\n`))
        return
      }
      if (!this.deps.registry.findByName(guestSession)) {
        this.send('sendMessage', { chat_id: inner.chat_id, text: 'Session offline. Try later.' })
          .catch(() => {})
        return
      }
      this.deps.router.routeToSession(guestSession, text, 'rubika', senderId)
      return
    }

    const parsed = parseCommand(text)
    if (parsed) {
      this.dispatchCommand(senderId, inner.chat_id, parsed.command, parsed.args).catch(err =>
        process.stderr.write(`rubika: command "${parsed.command}" failed: ${err}\n`),
      )
      return
    }

    // Reply-to-message routing: if the user replied to a bot message we
    // captured earlier, route to that message's source session — even if
    // it's not the active one. Rubika's wire format for the reply field is
    // unverified, so check both shapes we expect.
    const replyToId = m.reply_to_message_id ?? m.reply_to_message?.message_id
    if (replyToId) {
      const mapped = this.lookupReplyTarget(inner.chat_id, replyToId)
      if (mapped) {
        if (this.deps.registry.findByName(mapped)) {
          this.deps.router.routeToSession(mapped, text, 'rubika', senderId)
        } else {
          this.send('sendMessage', { chat_id: inner.chat_id, text: `🪦 Session "${mapped}" is gone — pick another with /list.` })
            .catch((err) => process.stderr.write(`rubika: stale-reply notice failed: ${err}\n`))
        }
        return
      }
      // No mapping found (likely the user replied to their own prior
      // message, or to a system message we didn't capture) — fall through
      // to the active-session path below.
    }

    const target = this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
    if (!target) {
      // No session to route to — surface that to the user instead of
      // silently dropping. Fire-and-forget; we still return 200 to Rubika.
      this.send('sendMessage', { chat_id: inner.chat_id, text: 'No active session.' })
        .catch((err) => process.stderr.write(`rubika: ack-send failed: ${err}\n`))
      return
    }
    this.deps.router.routeToSession(target, text, 'rubika', senderId)
  }

  handleInlineWebhook(body: RubikaInlineMessageBody): void {
    const im = body?.inline_message
    if (!im || !im.aux_data?.button_id) return
    const senderId = im.sender_id
    if (this.guests.has(senderId)) {
      process.stderr.write(`rubika: inline dropping guest tap from ${senderId}\n`)
      return
    }
    if (!this.deps.allowFrom.includes(senderId)) {
      process.stderr.write(`rubika: inline rejecting non-allowed sender ${senderId}\n`)
      return
    }
    this.chatIdByUser.set(senderId, im.chat_id)
    const buttonId = im.aux_data.button_id

    try {
      if (buttonId.startsWith('select:')) {
        const sessionName = buttonId.slice('select:'.length)
        this.activeSessionByUser.set(senderId, sessionName)
        // ack and clear the persistent picker keypad
        this.send('sendMessage', {
          chat_id: im.chat_id,
          text: `✅ Active session: ${sessionName}`,
          chat_keypad_type: 'Remove',
        }).catch(() => {})
        return
      }
      if (buttonId.startsWith('perm:allow:') || buttonId.startsWith('perm:deny:')) {
        const isAllow = buttonId.startsWith('perm:allow:')
        const requestId = buttonId.slice(isAllow ? 'perm:allow:'.length : 'perm:deny:'.length)
        if (!this.permissions || !this.socketServer) return
        const result = this.permissions.resolve(requestId, isAllow ? 'allow' : 'deny')
        if (result) {
          this.socketServer.sendToSession(result.sessionPath, {
            type: 'permission_response',
            requestId: result.response.requestId,
            behavior: result.response.behavior,
          })
        }
        return
      }
      const apMatch = buttonId.match(/^ap-(send|cancel):(.+)$/)
      if (apMatch) {
        const [, action, sessionName] = apMatch
        const path = this.deps.registry.findByName(sessionName)
        if (!path || !this.vetoController) return
        const pending = this.vetoController.cancel(path)
        if (!pending) return
        if (action === 'send' && this.socketServer) {
          this.socketServer.sendToSession(path, {
            type: 'channel_message',
            content: pending.draft,
            meta: { source: 'autopilot', frontend: 'rubika' },
          })
        }
        return
      }
      const driftMatch = buttonId.match(/^drift:(ignore|remind):(.+)$/)
      if (driftMatch) {
        const [, action, sessionName] = driftMatch
        if (action === 'ignore') return
        const path = this.deps.registry.findByName(sessionName)
        if (!path || !this.socketServer) return
        const profiles = loadProfilesForHub()
        const rules = this.deps.registry.getEffectiveRules(path, profiles)
        const reminder =
          `⚠️ Project rule reminder: ${rules.slice(0, 2).join('; ')}. ` +
          `Please re-do your last action without shortcuts, root-causing the issue instead.`
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: reminder,
          meta: { source: 'hub', frontend: 'rubika', user: 'drift-check', session: sessionName },
        })
        return
      }
      const restartMatch = buttonId.match(/^restart:(drain|keep):(.+)$/)
      if (restartMatch) {
        const [, action, targetSenderId] = restartMatch
        const captured = this.pendingRestartBacklog.get(targetSenderId)
        this.pendingRestartBacklog.delete(targetSenderId)
        // Always ack — clears the chat_keypad so the user isn't stuck looking
        // at stale Drain/Keep buttons.
        const ackText = action === 'keep'
          ? `✅ Replaying ${captured?.length ?? 0} message(s)...`
          : '🗑 Dropped pending messages.'
        this.send('sendMessage', {
          chat_id: im.chat_id,
          text: ackText,
          chat_keypad_type: 'Remove',
        }).catch(() => {})
        if (action === 'keep' && captured) {
          for (const body of captured) {
            try { this.handleWebhook(body) } catch (err) {
              process.stderr.write(`rubika: replay error: ${err}\n`)
            }
          }
        }
        return
      }
      process.stderr.write(`rubika: unknown inline button id "${buttonId}"\n`)
    } catch (err) {
      process.stderr.write(`rubika: inline handler error for "${buttonId}": ${err}\n`)
    }
  }

  private async replyTo(_senderId: string, chatId: string, text: string): Promise<void> {
    try {
      await this.send('sendMessage', { chat_id: chatId, text })
    } catch (err) {
      process.stderr.write(`rubika: replyTo failed: ${err}\n`)
    }
  }

  private async sendButtons(chatId: string, text: string, buttons: { id: string; label: string }[][]): Promise<unknown> {
    // Rubika strips aux_data.button_id from inline_keypad taps in polling mode
    // and never POSTs them to the registered ReceiveInlineMessage webhook in
    // practice — taps just disappear. chat_keypad (persistent reply keyboard)
    // is the only delivery shape that actually reaches the daemon, so we use
    // it for every button-driven flow (perm, autopilot, drift, restart).
    try {
      return await this.send('sendMessage', {
        chat_id: chatId,
        text,
        chat_keypad_type: 'New',
        chat_keypad: {
          rows: buttons.map(row => ({
            buttons: row.map(b => ({ id: b.id, type: 'Simple', button_text: b.label })),
          })),
        },
      })
    } catch (err) {
      process.stderr.write(`rubika: sendButtons failed: ${err}\n`)
      return null
    }
  }

  private async dispatchCommand(senderId: string, chatId: string, command: string, args: string[]): Promise<void> {
    switch (command) {
      case 'start':    return this.cmdStart(senderId, chatId)
      case 'list':     return this.cmdList(senderId, chatId)
      case 'status':   return this.cmdStatus(chatId)
      case 'profiles': return this.cmdProfiles(chatId)
      case 'profile':  return this.cmdProfile(chatId, args)
      case 'spawn':    return this.cmdSpawn(senderId, chatId, args)
      case 'resume':   return this.cmdResume(senderId, chatId, args)
      case 'team':     return this.cmdTeam(chatId, args)
      case 'kill':     return this.cmdKill(chatId, args)
      case 'remove':   return this.cmdRemove(chatId, args)
      case 'rename':   return this.cmdRename(chatId, args)
      case 'trust':    return this.cmdTrust(chatId, args)
      case 'autopilot':return this.cmdAutopilot(chatId, args)
      case 'rules':    return this.cmdRules(chatId, args)
      case 'fact':     return this.cmdFact(chatId, args)
      case 'facts':    return this.cmdFacts(chatId, args)
      case 'channel':  return this.cmdChannel(chatId, args)
      case 'verify':   return this.cmdVerify(chatId, args)
      case 'btw':      return this.cmdBtw(senderId, chatId, args)
      case 'peek':     return this.cmdPeek(senderId, chatId, args)
      case 'prefix':   return this.cmdPrefix(chatId, args)
      case 'all':      return this.cmdAll(senderId, chatId, args)
      case 'select':   return this.cmdSelect(senderId, chatId, args)
      default:
        return this.replyTo(senderId, chatId, `Unknown command "/${command}". Try /list or /status.`)
    }
  }

  private async cmdStart(senderId: string, chatId: string): Promise<void> {
    await this.replyTo(senderId, chatId,
      '👋 Connected to Claude Code Hub. Use /list to pick a session or send any message to talk to the active one.')
  }

  private async cmdList(senderId: string, chatId: string): Promise<void> {
    const sessions = this.deps.registry.list()
    const active = this.activeSessionByUser.get(senderId) ?? null
    const text = formatSessionList(sessions, active)
    if (sessions.length === 0) {
      await this.replyTo(senderId, chatId, text)
      return
    }
    // Use chat_keypad (persistent reply keyboard). On Rubika, taps on
    // chat_keypad buttons deliver `aux_data.button_id` via getUpdates;
    // taps on inline_keypad do NOT. We clear this keypad when the user
    // selects (in handleInlineWebhook).
    try {
      await this.send('sendMessage', {
        chat_id: chatId,
        text,
        chat_keypad_type: 'New',
        chat_keypad: {
          rows: sessions.map(s => ({
            buttons: [{ id: `select:${s.name}`, type: 'Simple', button_text: s.name }],
          })),
        },
      })
    } catch (err) {
      process.stderr.write(`rubika: cmdList sendMessage failed: ${err}\n`)
    }
  }

  private async cmdSelect(senderId: string, chatId: string, args: string[]): Promise<void> {
    const name = args[0]
    if (!name) {
      await this.replyTo(senderId, chatId, 'Usage: /select <session-name>')
      return
    }
    const path = this.deps.registry.findByName(name)
    if (!path) {
      await this.replyTo(senderId, chatId, `Session "${name}" not found`)
      return
    }
    this.activeSessionByUser.set(senderId, name)
    await this.replyTo(senderId, chatId, `✅ Active session: ${name}`)
  }
  private async cmdStatus(chatId: string): Promise<void> {
    const sessions = this.deps.registry.list()
    await this.replyTo('', chatId, formatStatus(sessions))
  }

  private async cmdProfiles(chatId: string): Promise<void> {
    const profiles = loadProfilesForHub()
    if (profiles.length === 0) {
      await this.replyTo('', chatId, 'No profiles defined.')
      return
    }
    const lines = profiles.map(p => {
      const desc = p.description ? ` — ${p.description}` : ''
      return `• ${p.name} (${p.trust})${desc}`
    })
    await this.replyTo('', chatId, `Profiles:\n${lines.join('\n')}`)
  }

  private async cmdProfile(chatId: string, args: string[]): Promise<void> {
    if (args.length === 0 || !args[0]) {
      await this.replyTo('', chatId, 'Usage: /profile <name> | /profile create <name> | /profile delete <name>')
      return
    }
    const action = args[0]
    const profiles = loadProfilesForHub()

    if (action === 'create' && args[1]) {
      const name = args[1]
      if (getProfile(name, profiles)) {
        await this.replyTo('', chatId, `Profile "${name}" already exists`)
        return
      }
      const newProfile: Profile = {
        name,
        description: 'User-created profile',
        trust: 'ask',
        rules: [],
        facts: [],
        prefix: '',
      }
      saveProfilesForHub([...profiles, newProfile])
      await this.replyTo('', chatId, `Created profile "${name}"`)
      return
    }

    if (action === 'delete' && args[1]) {
      const name = args[1]
      const filtered = profiles.filter(p => p.name !== name)
      saveProfilesForHub(filtered)
      await this.replyTo('', chatId, `Deleted profile "${name}"`)
      return
    }

    // Show profile details
    const profile = getProfile(action, profiles)
    if (!profile) {
      await this.replyTo('', chatId, `Profile "${action}" not found`)
      return
    }
    const lines = [
      `Profile: ${profile.name}`,
      profile.description ? profile.description : '',
      `Trust: ${profile.trust}`,
      `Rules (${profile.rules.length}):`,
      ...profile.rules.map(r => `  • ${r}`),
      `Facts (${profile.facts.length}):`,
      ...profile.facts.map(f => `  • ${f}`),
    ].filter(Boolean)
    await this.replyTo('', chatId, lines.join('\n'))
  }
  private async cmdResume(senderId: string, chatId: string, rawArgs: string[]): Promise<void> {
    if (rawArgs.length < 2 || !rawArgs[0] || !rawArgs[1]) {
      await this.replyTo(senderId, chatId, 'Usage: /resume <name> <path> [--profile <name>]')
      return
    }

    let profileName: string | undefined
    const args: string[] = []
    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === '--profile' && rawArgs[i + 1]) {
        profileName = rawArgs[i + 1]
        i++
      } else {
        args.push(rawArgs[i])
      }
    }

    const [name, projectPath] = args

    if (profileName) {
      const profiles = loadProfilesForHub()
      if (!getProfile(profileName, profiles)) {
        await this.replyTo(senderId, chatId, `Profile "${profileName}" not found. Use /profiles to see available.`)
        return
      }
    }

    try {
      const resume: ResumeSpec = { mode: 'continue' }
      await this.screenManager!.spawn(name, projectPath, undefined, profileName, resume)
      this.activeSessionByUser.set(senderId, name)
      await this.replyTo(senderId, chatId, `Resumed ${name} at ${projectPath} (latest session)${profileName ? ` with profile ${profileName}` : ''} — now active`)
    } catch (err) {
      await this.replyTo(senderId, chatId, `Failed to resume: ${err}`)
    }
  }

  private async cmdSpawn(senderId: string, chatId: string, rawArgs: string[]): Promise<void> {
    if (rawArgs.length < 2) {
      await this.replyTo(senderId, chatId, 'Usage: /spawn <name> <path> [--profile <name>] [team-size]')
      return
    }

    // Parse --profile flag
    let profileName: string | undefined
    const args: string[] = []
    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === '--profile' && rawArgs[i + 1]) {
        profileName = rawArgs[i + 1]
        i++
      } else {
        args.push(rawArgs[i])
      }
    }

    const [name, projectPath, sizeStr] = args
    const teamSize = sizeStr ? parseInt(sizeStr) : 1

    if (profileName) {
      const profiles = loadProfilesForHub()
      if (!getProfile(profileName, profiles)) {
        await this.replyTo(senderId, chatId, `Profile "${profileName}" not found. Use /profiles to see available.`)
        return
      }
    }

    try {
      if (teamSize > 1) {
        await this.screenManager!.spawnTeam(name, projectPath, teamSize, undefined, profileName)
        this.activeSessionByUser.set(senderId, name)
        await this.replyTo(senderId, chatId, `Spawned team ${name} (${teamSize} agents) at ${projectPath}${profileName ? ` with profile ${profileName}` : ''} — now active`)
      } else {
        await this.screenManager!.spawn(name, projectPath, undefined, profileName)
        this.activeSessionByUser.set(senderId, name)
        await this.replyTo(senderId, chatId, `Spawned ${name} at ${projectPath}${profileName ? ` with profile ${profileName}` : ''} — now active`)
      }
    } catch (err) {
      await this.replyTo(senderId, chatId, `Failed to spawn: ${err}`)
    }
  }

  private async cmdTeam(chatId: string, args: string[]): Promise<void> {
    if (args.length === 0 || !args[0]) {
      await this.replyTo('', chatId, 'Usage: /team <name> [add]')
      return
    }
    const teamName = args[0]
    const action = args[1]

    if (action === 'add') {
      const newName = await this.screenManager!.addTeammate(teamName)
      if (newName) {
        await this.replyTo('', chatId, `Added teammate: ${newName}`)
      } else {
        await this.replyTo('', chatId, `Team lead "${teamName}" not found`)
      }
      return
    }

    // Show team status
    const path = this.deps.registry.findByName(teamName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${teamName}" not found`)
      return
    }
    const folder = path.replace(/:\d+$/, '')
    const team = this.deps.registry.getTeam(folder)
    if (team.length <= 1) {
      await this.replyTo('', chatId, `${teamName} is a solo session, not a team`)
      return
    }

    const lines = team.map((s, i) => {
      const icon = s.status === 'active' ? '🟢' : '🔴'
      const role = i === 0 ? '👑 ' : '  ├ '
      return `${role}${s.name} ${icon}`
    })

    await this.replyTo('', chatId, lines.join('\n'))
  }

  private async cmdKill(chatId: string, args: string[]): Promise<void> {
    const name = args[0]
    if (!name) {
      await this.replyTo('', chatId, 'Usage: /kill <name>')
      return
    }
    const path = this.deps.registry.findByName(name)
    if (!path) {
      await this.replyTo('', chatId, `Session not found: ${name}`)
      return
    }
    if (this.screenManager!.isManaged(name)) {
      await this.screenManager!.gracefulKill(name)
    } else {
      this.socketServer!.disconnectSession(path)
    }
    this.deps.registry.unregister(path)
    await this.replyTo('', chatId, `Killed session ${name}`)
  }

  private async cmdRemove(chatId: string, args: string[]): Promise<void> {
    const name = args[0]
    if (!name) {
      await this.replyTo('', chatId, 'Usage: /remove <name>')
      return
    }
    const path = this.deps.registry.findByName(name)
    if (!path) {
      await this.replyTo('', chatId, `Session not found: ${name}`)
      return
    }
    const state = this.deps.registry.get(path)
    if (state && state.status !== 'disconnected') {
      await this.replyTo('', chatId, `Session ${name} is still connected. Use /kill to close it first.`)
      return
    }
    this.screenManager!.forgetManaged(name)
    this.socketServer!.disconnectSession(path)
    this.deps.registry.unregister(path)
    saveSessions(this.deps.registry.toSaveFormat())
    await this.replyTo('', chatId, `Removed ${name} from the list`)
  }

  private async cmdRename(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2 || !args[0] || !args[1]) {
      await this.replyTo('', chatId, 'Usage: /rename <old> <new>')
      return
    }
    const [oldName, newName] = args
    const path = this.deps.registry.findByName(oldName)
    if (!path) {
      await this.replyTo('', chatId, `Session not found: ${oldName}`)
      return
    }
    this.deps.registry.rename(path, newName)
    await this.replyTo('', chatId, `Renamed ${oldName} → ${newName}`)
  }
  private async cmdTrust(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2) {
      await this.replyTo('', chatId, 'Usage: /trust <session-name> <strict|ask|auto|yolo>')
      return
    }
    const [sessionName, level] = args
    const validLevels = ['strict', 'ask', 'auto', 'yolo']
    if (!validLevels.includes(level)) {
      await this.replyTo('', chatId, `Invalid trust level. Must be one of: ${validLevels.join(', ')}`)
      return
    }
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }
    this.deps.registry.setTrust(path, level as TrustLevel)
    await this.replyTo('', chatId, `Set ${sessionName} trust to ${level}`)
  }

  private async cmdPrefix(chatId: string, args: string[]): Promise<void> {
    // args is already split on whitespace; rejoin to reconstruct the raw match,
    // then re-split on the first space so the prefix text may contain spaces.
    const match = args.join(' ')
    const spaceIdx = match.indexOf(' ')
    if (spaceIdx === -1) {
      await this.replyTo('', chatId, 'Usage: /prefix <name> <text>')
      return
    }
    const name = match.slice(0, spaceIdx)
    const prefixText = match.slice(spaceIdx + 1)
    const path = this.deps.registry.findByName(name)
    if (!path) {
      await this.replyTo('', chatId, `Session not found: ${name}`)
      return
    }
    this.deps.registry.setPrefix(path, prefixText)
    await this.replyTo('', chatId, `Prefix for ${name} set to: ${prefixText}`)
  }

  private async cmdAll(senderId: string, chatId: string, args: string[]): Promise<void> {
    const message = args.join(' ').trim()
    if (!message) {
      await this.replyTo('', chatId, 'Usage: /all <message>')
      return
    }
    this.deps.router.broadcast(message, 'rubika', senderId)
    await this.replyTo('', chatId, 'Broadcast sent to all active sessions.')
  }

  private async cmdAutopilot(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2 || !args[0] || (args[1] !== 'on' && args[1] !== 'off')) {
      await this.replyTo('', chatId, 'Usage: /autopilot <name> on|off')
      return
    }
    const name = args[0]
    const enabled = args[1] === 'on'
    const path = this.deps.registry.findByName(name)
    if (!path) {
      await this.replyTo('', chatId, `Session not found: ${name}`)
      return
    }
    if (enabled) {
      const runner = this.autopilotRunner
      const managed = this.screenManager?.getManagedByPath(this.deps.registry.folderPath(path))
      const tmuxName = managed?.sessionName ?? `hub-${name}`
      if (runner) {
        const quick = await runner.quickProbe(tmuxName)
        if (!quick.ok) {
          await this.replyTo('', chatId, `Autopilot precheck failed: ${quick.reason}`)
          return
        }
      }
      const existing = this.deps.registry.getAutopilot(path)
      const current = this.deps.registry.get(path)
      const prior = current?.trust
      const priorTrust = existing?.priorTrust ?? prior
      this.deps.registry.setTrust(path, 'auto')
      this.deps.registry.setAutopilot(path, {
        ...existing,
        enabled: true,
        priorTrust,
        startedAt: existing?.startedAt ?? Date.now(),
      })
      saveSessions(this.deps.registry.toSaveFormat())
      if (runner) {
        runner.probe(tmuxName, 20_000).then(res => {
          if (!res.ok) {
            this.deliverToUser(name, `⚠️ Autopilot on but /btw confirmation failed: ${res.reason}`)
          } else {
            this.deliverToUser(name, `✅ Autopilot ready — /btw confirmed reachable.`)
          }
        }).catch(err => {
          process.stderr.write(`rubika: autopilot bg probe error for ${name}: ${err}\n`)
        })
      }
    } else {
      const ap = this.deps.registry.getAutopilot(path)
      if (ap?.priorTrust) this.deps.registry.setTrust(path, ap.priorTrust)
      this.deps.registry.setAutopilot(path, {
        ...ap,
        enabled: false,
        priorTrust: undefined,
        startedAt: undefined,
      })
      saveSessions(this.deps.registry.toSaveFormat())
    }
    await this.replyTo('', chatId, `🤖 Autopilot ${enabled ? 'ON' : 'OFF'} for ${name}`)
  }

  private async cmdRules(chatId: string, args: string[]): Promise<void> {
    if (args.length < 1) {
      await this.replyTo('', chatId, 'Usage: /rules <session> [clear|<new rule text>]')
      return
    }
    const sessionName = args[0]
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }

    const profiles = loadProfilesForHub()

    if (args.length === 1) {
      const rules = this.deps.registry.getEffectiveRules(path, profiles)
      if (rules.length === 0) {
        await this.replyTo('', chatId, `No rules for ${sessionName}`)
        return
      }
      const text = rules.map((r, i) => `${i + 1}. ${r}`).join('\n')
      await this.replyTo('', chatId, `Rules for ${sessionName}:\n${text}`)
      return
    }

    if (args[1] === 'clear') {
      this.deps.registry.clearRules(path)
      await this.replyTo('', chatId, `🗑 Cleared rules for ${sessionName}`)
      return
    }

    const newRule = args.slice(1).join(' ')
    this.deps.registry.addRule(path, newRule, profiles)
    await this.replyTo('', chatId, `✅ Added rule to ${sessionName}: "${newRule}"`)
  }

  private async cmdFact(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2) {
      await this.replyTo('', chatId, 'Usage: /fact <session> <fact text>')
      return
    }
    const sessionName = args[0]
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }
    const profiles = loadProfilesForHub()
    const factText = args.slice(1).join(' ')
    this.deps.registry.addFact(path, factText, profiles)
    await this.replyTo('', chatId, `✅ Added fact to ${sessionName}: "${factText}"`)
  }

  private async cmdFacts(chatId: string, args: string[]): Promise<void> {
    if (args.length < 1) {
      await this.replyTo('', chatId, 'Usage: /facts <session> [clear]')
      return
    }
    const sessionName = args[0]
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }

    if (args[1] === 'clear') {
      this.deps.registry.clearFacts(path)
      await this.replyTo('', chatId, `🗑 Cleared facts for ${sessionName}`)
      return
    }

    const profiles = loadProfilesForHub()
    const facts = this.deps.registry.getEffectiveFacts(path, profiles)
    if (facts.length === 0) {
      await this.replyTo('', chatId, `No facts for ${sessionName}`)
      return
    }
    const text = facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
    await this.replyTo('', chatId, `Facts for ${sessionName}:\n${text}`)
  }

  private async cmdChannel(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2) {
      await this.replyTo('', chatId, 'Usage: /channel <session> <reset|instruction text>')
      return
    }
    const sessionName = args[0]
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }
    if (args[1] === 'reset') {
      this.deps.registry.clearChannelOverride(path, 'rubika')
      await this.replyTo('', chatId, `✅ Reset channel instructions for ${sessionName} (using default)`)
      return
    }
    const text = args.slice(1).join(' ')
    this.deps.registry.setChannelOverride(path, 'rubika', text)
    await this.replyTo('', chatId, `✅ Channel instructions for ${sessionName} updated`)
  }

  private async cmdVerify(chatId: string, args: string[]): Promise<void> {
    const sessionName = args[0]
    if (!sessionName) {
      await this.replyTo('', chatId, 'Usage: /verify <session>')
      return
    }
    const path = this.deps.registry.findByName(sessionName)
    if (!path) {
      await this.replyTo('', chatId, `Session "${sessionName}" not found`)
      return
    }
    if (!this.verificationRunner) {
      await this.replyTo('', chatId, 'Verification runner not available.')
      return
    }
    const result = await this.verificationRunner.run(path)
    await this.renderVerificationResult('', chatId, sessionName, result)
  }

  private async cmdBtw(senderId: string, chatId: string, args: string[]): Promise<void> {
    const question = args.join(' ').trim()
    if (!question) {
      await this.replyTo(senderId, chatId, 'Usage: /btw <question>')
      return
    }
    if (!this.autopilotRunner) {
      await this.replyTo(senderId, chatId, 'Autopilot runner not available.')
      return
    }
    const target = this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
    if (!target) {
      await this.replyTo(senderId, chatId, 'No active session.')
      return
    }
    const path = this.deps.registry.findByName(target)
    if (!path) {
      await this.replyTo(senderId, chatId, `Session "${target}" not found`)
      return
    }
    const managed = this.screenManager?.getManagedByPath(this.deps.registry.folderPath(path))
    const tmuxName = managed?.sessionName ?? `hub-${target}`

    const quick = await this.autopilotRunner.quickProbe(tmuxName)
    if (!quick.ok) {
      await this.replyTo(senderId, chatId, `/btw precheck failed: ${quick.reason}`)
      return
    }

    const result = await this.autopilotRunner.runBtw(tmuxName, question)
    switch (result.status) {
      case 'answered':
        await this.replyTo(senderId, chatId, `💬 ${target}:\n\n${result.answer}`)
        return
      case 'escalate':
        await this.replyTo(senderId, chatId, `⚠️ /btw escalated: ${result.reason}`)
        return
      case 'parse_error':
        await this.replyTo(senderId, chatId, `⚠️ Could not parse /btw response from ${target}`)
        return
      case 'timeout':
        await this.replyTo(senderId, chatId, `⏱ /btw timed out — ${target} did not respond in 30s`)
        return
    }
  }

  // /peek [name] [lines] — capture the live tmux pane (incl. scrollback) and
  // return it as plain text. Mirrors Telegram /peek; no buttons because Rubika
  // can't render code blocks reliably and the user is on text-only mobile.
  private async cmdPeek(senderId: string, chatId: string, args: string[]): Promise<void> {
    const { name: argName, lines } = parsePeekArgs(args.join(' '))
    const target = argName ?? this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
    if (!target) {
      await this.replyTo(senderId, chatId, 'No active session. Use /list to pick one, or /peek <name>.')
      return
    }
    const path = this.deps.registry.findByName(target)
    const managed = path ? this.screenManager?.getManagedByPath(this.deps.registry.folderPath(path)) : undefined
    const tmuxName = managed?.sessionName ?? `hub-${target}`
    try {
      const raw = await this.screenManager!.capturePaneWithScrollback(tmuxName, lines)
      const stripped = stripAnsi(raw).trimEnd()
      if (stripped.length === 0) {
        await this.replyTo(senderId, chatId, `(empty pane for ${target})`)
        return
      }
      const trimmed = tailToCharLimit(stripped, 3500)
      await this.replyTo(senderId, chatId, `📺 ${target}\n\n${trimmed}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.replyTo(senderId, chatId, `Could not peek ${target}: ${msg}`)
    }
  }

  private async renderVerificationResult(
    _senderId: string,
    chatId: string,
    sessionName: string,
    result: VerificationResult,
  ): Promise<void> {
    switch (result.status) {
      case 'pass':
        await this.replyTo('', chatId, '✅')
        return
      case 'fail': {
        const tail = result.tail.join('\n')
        const text =
          `❌ ${sessionName} — ${result.failedCommand} (exit ${result.exitCode})\n\n` +
          `\`\`\`\n${tail}\n\`\`\``
        await this.replyTo('', chatId, text)
        return
      }
      case 'error':
        switch (result.reason) {
          case 'timeout':
            await this.replyTo('', chatId, `⏱ ${sessionName} — "${result.details}" exceeded 120s`)
            return
          case 'no-commands':
            await this.replyTo(
              '',
              chatId,
              `⚠️ ${sessionName} has no verification commands. ` +
              `Set them on the profile or add scripts to package.json.`,
            )
            return
          case 'already-running':
            await this.replyTo('', chatId, `⏳ Verification already running for ${sessionName}`)
            return
          case 'spawn-failed':
            await this.replyTo('', chatId, `⚠️ ${sessionName}: ${result.details}`)
            return
        }
    }
  }

  private firstActiveSessionName(): string | null {
    const list = this.deps.registry.list()
    return list.find((s) => s.status === 'active')?.name ?? null
  }

  private async saveInboundFile(
    senderId: string,
    chatId: string,
    registryKey: string,
    sessionName: string,
    folderPath: string,
    uploadDir: string,
    file: { file_id: string; file_name: string; type?: string },
    caption: string,
  ): Promise<void> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.resolve(folderPath, uploadDir)
    await fs.mkdir(dir, { recursive: true })
    // `getFile` is confirmed as a recognized Rubika bot API method (returns
    // INVALID_INPUT on a bad file_id, not "Invalid Method"). Expected to return
    // { download_url: string } for a valid file_id.
    const r1 = (await this.send('getFile', { file_id: file.file_id })) as { download_url: string }
    const res = await fetch(r1.download_url)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const target = path.join(dir, file.file_name)
    await fs.writeFile(target, buf)

    const isImage = file.type === 'Image'
    const label = isImage ? 'Photo uploaded' : 'File uploaded'
    const content = caption ? `${caption}\n\n[${label}: ${target}]` : `[${label}: ${target}]`
    const meta: Record<string, string> = {
      source: 'hub',
      frontend: 'rubika',
      user: senderId,
      session: sessionName,
    }
    if (isImage) meta.image_path = target
    this.socketServer?.sendToSession(registryKey, { type: 'channel_message', content, meta })

    await this.send('sendMessage', { chat_id: chatId, text: `📎 Saved ${path.relative(folderPath, target)}` })
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────
  private async realSend(method: string, body: unknown): Promise<unknown> {
    const url = `${this.apiBase}/${this.deps.token}/${method}`
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 30_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) {
        throw new Error(`rubika ${method} HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
      const j = (await res.json()) as { status?: string; data?: unknown }
      // Rubika returns HTTP 200 even for application-level failures, with
      // status: "INVALID_INPUT" / "INVALID_AUTH" / etc. Treat anything other
      // than "OK" as a thrown error so callers see real failures instead of
      // silently no-op'ing.
      if (j && typeof j === 'object' && j.status && j.status !== 'OK') {
        throw new Error(`rubika ${method} ${j.status}: ${JSON.stringify(j)}`)
      }
      if (j && typeof j === 'object' && 'data' in j) return j.data
      return j
    } finally {
      clearTimeout(t)
    }
  }

  async deliverAutopilotDraft(sessionName: string, draft: string): Promise<void> {
    if (this.deps.allowFrom.length === 0) return
    const text = `📝 ${sessionName} draft:\n\n${draft}`
    for (const senderId of this.deps.allowFrom) {
      const chatId = this.chatIdByUser.get(senderId)
      if (!chatId) continue
      try {
        const resp = await this.sendButtons(chatId, text, [[
          { id: `ap-send:${sessionName}`, label: '✅ Send' },
          { id: `ap-cancel:${sessionName}`, label: '❌ Cancel' },
        ]])
        this.recordOutgoing(chatId, sessionName, resp)
      } catch (err) {
        process.stderr.write(`rubika: deliverAutopilotDraft failed: ${err}\n`)
      }
    }
  }

  // Rubika's upload edge (messengerg2f1.rubika.ir) returns persistent 5xx
  // bursts that can last 10–20s. 5 attempts with these backoffs = up to ~23s
  // before fail. Field (not const) so tests can override to [0,0,0,0].
  private uploadBackoffsMs = [2000, 4000, 7000, 10000]

  private async uploadFile(filePath: string, mime: string): Promise<{ file_id: string; file_name: string; size: number; type: string }> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const buf = await fs.readFile(filePath)
    const fileName = path.basename(filePath)
    const type = mimeToType(mime)
    // Each requestSendFile yields a one-shot upload_url, so retries must request a fresh slot.
    let lastErr: unknown
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const r1 = (await this.send('requestSendFile', { type })) as { upload_url: string }
        // Rubika expects multipart form-data (verified 2026-05-02). Raw body POST
        // returns {"status":"SERVER_ERROR"}.
        const fd = new FormData()
        fd.append('file', new Blob([new Uint8Array(buf)], { type: mime }), fileName)
        const upload = await fetch(r1.upload_url, { method: 'POST', body: fd })
        if (!upload.ok) throw new Error(`upload HTTP ${upload.status}`)
        const j = (await upload.json()) as { status?: string; data?: { file_id?: string } }
        if (j.status !== 'OK' || !j.data?.file_id) {
          throw new Error(`upload failed: ${JSON.stringify(j)}`)
        }
        return { file_id: j.data.file_id, file_name: fileName, size: buf.byteLength, type }
      } catch (err) {
        lastErr = err
        if (attempt < 5) await new Promise(r => setTimeout(r, this.uploadBackoffsMs[attempt - 1]))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export async function guessMime(filePath: string): Promise<string> {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function mimeToType(mime: string): 'Image' | 'Video' | 'Voice' | 'Music' | 'Gif' | 'File' {
  if (mime.startsWith('image/gif')) return 'Gif'
  if (mime.startsWith('image/')) return 'Image'
  if (mime.startsWith('video/')) return 'Video'
  if (mime.startsWith('audio/ogg') || mime.startsWith('audio/opus')) return 'Voice'
  if (mime.startsWith('audio/')) return 'Music'
  return 'File'
}
