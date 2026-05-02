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
import type { ScreenManager } from '../screen-manager'
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
  private started = false
  private permissions?: PermissionEngine
  private screenManager?: ScreenManager
  private socketServer?: SocketServer
  private taskMonitor: TaskMonitor | null
  private verificationRunner?: VerificationRunner
  private vetoController?: VetoController
  private autopilotRunner?: AutopilotRunner

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
  }

  // Tell Rubika where to POST updates. Idempotent — safe to call on each
  // daemon boot. Logs but does not throw on failure so a temporarily
  // unreachable Rubika doesn't block daemon startup.
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (!this.deps.webhookBase) {
      process.stderr.write('rubika: rubikaWebhookBase not configured — webhooks NOT registered\n')
      return
    }
    const base = this.deps.webhookBase.replace(/\/$/, '')
    const updateUrl = `${base}${this.webhookPath}`
    const inlineUrl = `${base}${this.inlineWebhookPath}`
    await this.registerEndpoint('ReceiveUpdate', updateUrl)
    await this.registerEndpoint('ReceiveInlineMessage', inlineUrl)
  }

  private async registerEndpoint(type: 'ReceiveUpdate' | 'ReceiveInlineMessage', url: string): Promise<void> {
    try {
      await this.send('updateBotEndpoints', { type, url })
      process.stderr.write(`rubika: ${type} webhook registered → ${url}\n`)
    } catch (err) {
      process.stderr.write(`rubika: failed to register ${type} (${err})\n`)
    }
  }

  async stop(): Promise<void> {
    this.started = false
    // No-op for webhook mode; Rubika keeps the registered endpoint until we
    // change it. We don't deregister on stop — a daemon restart should not
    // drop messages mid-flight.
  }

  // ── Outbound (Claude → user) ─────────────────────────────────────────────
  async deliverToUser(sessionName: string, text: string, _files?: string[]): Promise<void> {
    if (this.deps.allowFrom.length === 0) return       // deny-all guard
    const fullText = `[${sessionName}] ${text}`
    for (const senderId of this.deps.allowFrom) {
      const chatId = this.chatIdByUser.get(senderId)
      if (!chatId) continue
      try {
        await this.send('sendMessage', { chat_id: chatId, text: fullText })
      } catch (err) {
        process.stderr.write(`rubika: sendMessage to ${chatId} failed: ${err}\n`)
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
    if (!this.deps.allowFrom.includes(senderId)) {
      process.stderr.write(`rubika: rejecting message from non-allowed sender ${senderId}\n`)
      return
    }
    this.chatIdByUser.set(senderId, inner.chat_id)
    const text = (m.text || '').trim()
    if (text.length === 0) return

    const parsed = parseCommand(text)
    if (parsed) {
      this.dispatchCommand(senderId, inner.chat_id, parsed.command, parsed.args).catch(err =>
        process.stderr.write(`rubika: command "${parsed.command}" failed: ${err}\n`),
      )
      return
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

  private async sendButtons(chatId: string, text: string, buttons: { id: string; label: string }[][]): Promise<void> {
    try {
      await this.send('sendMessage', {
        chat_id: chatId,
        text,
        inline_keypad: {
          rows: buttons.map(row => ({
            buttons: row.map(b => ({ id: b.id, type: 'Simple', button_text: b.label })),
          })),
        },
      })
    } catch (err) {
      process.stderr.write(`rubika: sendButtons failed: ${err}\n`)
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
      case 'prefix':   return this.cmdPrefix(chatId, args)
      case 'all':      return this.cmdAll(senderId, chatId, args)
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
    await this.sendButtons(chatId, text, sessions.map(s => [{ id: `select:${s.name}`, label: s.name }]))
  }
  private async cmdStatus(c: string): Promise<void> { await this.replyTo('', c, 'todo: status') }
  private async cmdProfiles(c: string): Promise<void> { await this.replyTo('', c, 'todo: profiles') }
  private async cmdProfile(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: profile') }
  private async cmdSpawn(_s: string, c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: spawn') }
  private async cmdTeam(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: team') }
  private async cmdKill(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: kill') }
  private async cmdRemove(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: remove') }
  private async cmdRename(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: rename') }
  private async cmdTrust(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: trust') }
  private async cmdAutopilot(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: autopilot') }
  private async cmdRules(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: rules') }
  private async cmdFact(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: fact') }
  private async cmdFacts(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: facts') }
  private async cmdChannel(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: channel') }
  private async cmdVerify(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: verify') }
  private async cmdPrefix(c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: prefix') }
  private async cmdAll(_s: string, c: string, _a: string[]): Promise<void> { await this.replyTo('', c, 'todo: all') }

  private firstActiveSessionName(): string | null {
    const list = this.deps.registry.list()
    return list.find((s) => s.status === 'active')?.name ?? null
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────
  private async realSend(method: string, body: unknown): Promise<unknown> {
    const url = `${this.apiBase}/${this.deps.token}/${method}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  }
}
