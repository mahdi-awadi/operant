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
  async deliverToUser(sessionName: string, text: string, files?: string[]): Promise<void> {
    if (this.deps.allowFrom.length === 0) return
    const fullText = `[${sessionName}] ${text}`
    for (const senderId of this.deps.allowFrom) {
      const chatId = this.chatIdByUser.get(senderId)
      if (!chatId) continue
      try {
        if (files && files.length > 0) {
          for (let i = 0; i < files.length; i++) {
            try {
              const mime = await guessMime(files[i]!)
              const meta = await this.uploadFile(files[i]!, mime)
              await this.send('sendMessage', {
                chat_id: chatId,
                text: i === 0 ? fullText : '',
                file_inline: meta,
              })
            } catch (err) {
              await this.send('sendMessage', {
                chat_id: chatId,
                text: `[file too big to upload: ${files[i]}]\n${i === 0 ? fullText : ''}`,
              })
            }
          }
        } else {
          await this.send('sendMessage', { chat_id: chatId, text: fullText })
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

  private async uploadFile(filePath: string, mime: string): Promise<{ file_id: string; file_name: string; size: number; type: string }> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const buf = await fs.readFile(filePath)
    const fileName = path.basename(filePath)
    const type = mimeToType(mime)
    const r1 = (await this.send('requestSendFile', { type })) as { upload_url: string }
    const upload = await fetch(r1.upload_url, { method: 'POST', body: buf })
    if (!upload.ok) throw new Error(`upload HTTP ${upload.status}`)
    const j = await upload.json() as { file_id: string }
    return { file_id: j.file_id, file_name: fileName, size: buf.byteLength, type }
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
