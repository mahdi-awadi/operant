// src/frontends/telegram.ts
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { SessionState, PermissionRequest, TrustLevel, Profile } from '../types'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { ScreenManager } from '../screen-manager'
import type { SocketServer } from '../socket-server'
import type { TaskMonitor } from '../task-monitor'
import { getProfile } from '../profiles'
import { loadProfilesForHub, saveProfilesForHub, saveSessions } from '../config'
import type { VerificationRunner, VerificationResult } from '../verification'
import type { VetoController } from '../veto-controller'

// ── Pure helper functions ────────────────────────────────────────────────────

export function formatSessionList(sessions: SessionState[], activeSession: string | null): string {
  if (sessions.length === 0) {
    return 'No sessions connected.'
  }

  const lines = sessions.map((s) => {
    const icon =
      s.status === 'active'
        ? '🟢'
        : s.status === 'respawning'
          ? '🟡'
          : '🔴'
    const trustLabel = s.trust === 'auto' ? ' [auto]' : ''
    const activeMarker = s.name === activeSession ? ' ← active' : ''
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    return `${icon} ${s.name}${trustLabel}${activeMarker}${autopilotBadge}`
  })

  return lines.join('\n')
}

export function formatStatus(sessions: SessionState[]): string {
  if (sessions.length === 0) {
    return 'No sessions connected.'
  }

  const lines = sessions.map((s) => {
    const icon =
      s.status === 'active'
        ? '🟢'
        : s.status === 'respawning'
          ? '🟡'
          : '🔴'
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    const parts = [`${icon} <b>${s.name}</b>${autopilotBadge} (${s.status})`]
    parts.push(`  path: ${s.path}`)
    parts.push(`  trust: ${s.trust}`)
    if (s.prefix) parts.push(`  prefix: ${s.prefix}`)
    return parts.join('\n')
  })

  return lines.join('\n\n')
}

export function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1).filter((a) => a.length > 0)
  return { command, args }
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    // Try to find a newline boundary within the limit
    const slice = remaining.slice(0, limit)
    const lastNewline = slice.lastIndexOf('\n')
    const cutAt = lastNewline > 0 ? lastNewline + 1 : limit
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

export async function renderVerificationResult(
  reply: (text: string, opts?: any) => Promise<any>,
  sessionName: string,
  result: VerificationResult,
): Promise<void> {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  switch (result.status) {
    case 'pass':
      await reply('✅')
      return
    case 'fail': {
      const text =
        `❌ <b>${escapeHtml(sessionName)}</b> — ` +
        `<code>${escapeHtml(result.failedCommand)}</code> (exit ${result.exitCode})\n\n` +
        `<pre>${escapeHtml(result.tail.join('\n'))}</pre>`
      await reply(text, { parse_mode: 'HTML' })
      return
    }
    case 'error':
      switch (result.reason) {
        case 'timeout':
          await reply(`⏱ ${sessionName} — "${result.details}" exceeded 120s`)
          return
        case 'no-commands':
          await reply(
            `⚠️ ${sessionName} has no verification commands. ` +
            `Set them on the profile or add scripts to package.json.`,
          )
          return
        case 'already-running':
          await reply(`⏳ Verification already running for ${sessionName}`)
          return
        case 'spawn-failed':
          await reply(`⚠️ ${sessionName}: ${result.details}`)
          return
      }
  }
}

// ── TelegramFrontend class ───────────────────────────────────────────────────

export type TelegramFrontendDeps = {
  token: string
  registry: SessionRegistry
  router: MessageRouter
  permissions: PermissionEngine
  screenManager: ScreenManager
  socketServer: SocketServer
  allowFrom: string[]
  taskMonitor: TaskMonitor | null
  verificationRunner: VerificationRunner
  vetoController?: VetoController
}

export class TelegramFrontend {
  private bot: Bot
  private registry: SessionRegistry
  private router: MessageRouter
  private permissions: PermissionEngine
  private screenManager: ScreenManager
  private socketServer: SocketServer
  private allowFrom: string[]
  private taskMonitor: TaskMonitor | null
  private verificationRunner: VerificationRunner
  private vetoController: VetoController | undefined

  // Per-user active session: telegram user id → session name
  private userActiveSessions = new Map<string, string>()
  // Track all users who have messaged the bot (for delivering replies when allowFrom is empty)
  private knownUsers = new Set<string>()

  constructor(deps: TelegramFrontendDeps) {
    this.bot = new Bot(deps.token)
    this.bot.catch(err => {
      process.stderr.write(`hub telegram: handler error: ${err.error}\n`)
    })
    this.registry = deps.registry
    this.router = deps.router
    this.permissions = deps.permissions
    this.screenManager = deps.screenManager
    this.socketServer = deps.socketServer
    this.allowFrom = deps.allowFrom
    this.taskMonitor = deps.taskMonitor
    this.verificationRunner = deps.verificationRunner
    this.vetoController = deps.vetoController

    this.registerHandlers()
  }

  private isAllowed(ctx: { from?: { id: number } }): boolean {
    if (this.allowFrom.length === 0) return true
    if (!ctx.from) return false
    return this.allowFrom.includes(String(ctx.from.id))
  }

  private getUserId(ctx: { from?: { id: number } }): string {
    return String(ctx.from?.id ?? 'unknown')
  }

  private getActiveSession(userId: string): string | null {
    return this.userActiveSessions.get(userId) ?? null
  }

  private registerHandlers(): void {
    const bot = this.bot

    // /list — show sessions with inline buttons to select active
    bot.command('list', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.registry.list()
      const userId = this.getUserId(ctx)
      const activeSession = this.getActiveSession(userId)
      const text = formatSessionList(sessions, activeSession)

      if (sessions.length === 0) {
        await ctx.reply(text)
        return
      }

      const keyboard = new InlineKeyboard()
      for (const s of sessions) {
        keyboard.text(s.name, `select:${s.name}`).row()
      }
      await ctx.reply(text, { reply_markup: keyboard })
    })

    // /status — dashboard view
    bot.command('status', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.registry.list()
      await ctx.reply(formatStatus(sessions), { parse_mode: 'HTML' })
    })

    // /profiles — list all profiles
    bot.command('profiles', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const profiles = loadProfilesForHub()
      if (profiles.length === 0) {
        await ctx.reply('No profiles defined.')
        return
      }
      const lines = profiles.map(p => {
        const desc = p.description ? ` — ${p.description}` : ''
        return `• <b>${p.name}</b> (${p.trust})${desc}`
      })
      await ctx.reply(`<b>Profiles:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' })
    })

    // /profile <name> | /profile create <name> | /profile delete <name>
    bot.command('profile', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length === 0 || !args[0]) {
        await ctx.reply('Usage: /profile <name> | /profile create <name> | /profile delete <name>')
        return
      }
      const action = args[0]
      const profiles = loadProfilesForHub()

      if (action === 'create' && args[1]) {
        const name = args[1]
        if (getProfile(name, profiles)) {
          await ctx.reply(`Profile "${name}" already exists`)
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
        await ctx.reply(`✅ Created profile "${name}"`)
        return
      }

      if (action === 'delete' && args[1]) {
        const name = args[1]
        const filtered = profiles.filter(p => p.name !== name)
        saveProfilesForHub(filtered)
        await ctx.reply(`🗑 Deleted profile "${name}"`)
        return
      }

      // Show profile details
      const profile = getProfile(action, profiles)
      if (!profile) {
        await ctx.reply(`Profile "${action}" not found`)
        return
      }
      const lines = [
        `<b>Profile: ${profile.name}</b>`,
        profile.description ? `<i>${profile.description}</i>` : '',
        `Trust: <code>${profile.trust}</code>`,
        `Rules (${profile.rules.length}):`,
        ...profile.rules.map(r => `  • ${r}`),
        `Facts (${profile.facts.length}):`,
        ...profile.facts.map(f => `  • ${f}`),
      ].filter(Boolean)
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
    })

    // /spawn <name> <path> [--profile <name>] [teamSize]
    bot.command('spawn', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const rawArgs = ctx.match?.trim().split(/\s+/) ?? []
      if (rawArgs.length < 2) {
        await ctx.reply('Usage: /spawn <name> <path> [--profile <name>] [team-size]')
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
          await ctx.reply(`Profile "${profileName}" not found. Use /profiles to see available.`)
          return
        }
      }

      try {
        const userId = this.getUserId(ctx)
        if (teamSize > 1) {
          await this.screenManager.spawnTeam(name, projectPath, teamSize, undefined, profileName)
          this.userActiveSessions.set(userId, name)
          await ctx.reply(`Spawned team ${name} (${teamSize} agents) at ${projectPath}${profileName ? ` with profile ${profileName}` : ''} — now active`)
        } else {
          await this.screenManager.spawn(name, projectPath, undefined, profileName)
          this.userActiveSessions.set(userId, name)
          await ctx.reply(`Spawned ${name} at ${projectPath}${profileName ? ` with profile ${profileName}` : ''} — now active`)
        }
      } catch (err) {
        await ctx.reply(`Failed to spawn: ${err}`)
      }
    })

    // /team <name> [add]
    bot.command('team', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length === 0 || !args[0]) {
        await ctx.reply('Usage: /team <name> [add]')
        return
      }
      const teamName = args[0]
      const action = args[1]

      if (action === 'add') {
        const newName = await this.screenManager.addTeammate(teamName)
        if (newName) {
          await ctx.reply(`Added teammate: ${newName}`)
        } else {
          await ctx.reply(`Team lead "${teamName}" not found`)
        }
        return
      }

      // Show team status
      const path = this.registry.findByName(teamName)
      if (!path) {
        await ctx.reply(`Session "${teamName}" not found`)
        return
      }
      const folder = path.replace(/:\d+$/, '')
      const team = this.registry.getTeam(folder)
      if (team.length <= 1) {
        await ctx.reply(`${teamName} is a solo session, not a team`)
        return
      }

      const lines = team.map((s, i) => {
        const icon = s.status === 'active' ? '🟢' : '🔴'
        const role = i === 0 ? '👑 ' : '  ├ '
        return `${role}${s.name} ${icon}`
      })

      await ctx.reply(lines.join('\n'))
    })

    // /kill <name>
    bot.command('kill', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const name = ctx.match?.trim()
      if (!name) {
        await ctx.reply('Usage: /kill <name>')
        return
      }
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      if (this.screenManager.isManaged(name)) {
        await this.screenManager.gracefulKill(name)
      } else {
        this.socketServer.disconnectSession(path)
      }
      this.registry.unregister(path)
      await ctx.reply(`Killed session ${name}`)
    })

    // /remove <name> — drop a disconnected session from the list (no tmux ops)
    bot.command('remove', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const name = ctx.match?.trim()
      if (!name) {
        await ctx.reply('Usage: /remove <name>')
        return
      }
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      const state = this.registry.get(path)
      if (state && state.status !== 'disconnected') {
        await ctx.reply(`Session ${name} is still connected. Use /kill to close it first.`)
        return
      }
      this.screenManager.forgetManaged(name)
      this.socketServer.disconnectSession(path)
      this.registry.unregister(path)
      saveSessions(this.registry.toSaveFormat())
      await ctx.reply(`Removed ${name} from the list`)
    })

    // /rename <old> <new>
    bot.command('rename', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length < 2 || !args[0] || !args[1]) {
        await ctx.reply('Usage: /rename <old> <new>')
        return
      }
      const [oldName, newName] = args
      const path = this.registry.findByName(oldName)
      if (!path) {
        await ctx.reply(`Session not found: ${oldName}`)
        return
      }
      this.registry.rename(path, newName)
      await ctx.reply(`Renamed ${oldName} → ${newName}`)
    })

    bot.command('trust', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length < 2) {
        await ctx.reply('Usage: /trust <session-name> <strict|ask|auto|yolo>')
        return
      }
      const [sessionName, level] = args
      const validLevels = ['strict', 'ask', 'auto', 'yolo']
      if (!validLevels.includes(level)) {
        await ctx.reply(`Invalid trust level. Must be one of: ${validLevels.join(', ')}`)
        return
      }
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }
      this.registry.setTrust(path, level as TrustLevel)
      await ctx.reply(`✅ Set ${sessionName} trust to <code>${level}</code>`, { parse_mode: 'HTML' })
    })

    // /autopilot <name> on|off
    bot.command('autopilot', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length < 2 || !args[0] || (args[1] !== 'on' && args[1] !== 'off')) {
        await ctx.reply('Usage: /autopilot <name> on|off')
        return
      }
      const name = args[0]
      const enabled = args[1] === 'on'
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      this.registry.setAutopilot(path, {
        ...this.registry.getAutopilot(path),
        enabled,
      })
      await ctx.reply(`🤖 Autopilot ${enabled ? 'ON' : 'OFF'} for ${name}`)
    })

    // /rules <session> [clear|<new rule text>]
    bot.command('rules', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim() ?? ''
      const parts = args.length > 0 ? args.split(/\s+/) : []
      if (parts.length < 1) {
        await ctx.reply('Usage: /rules <session> [clear|<new rule text>]')
        return
      }
      const sessionName = parts[0]
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }

      const profiles = loadProfilesForHub()

      if (parts.length === 1) {
        const rules = this.registry.getEffectiveRules(path, profiles)
        if (rules.length === 0) {
          await ctx.reply(`No rules for ${sessionName}`)
          return
        }
        const text = rules.map((r, i) => `${i + 1}. ${r}`).join('\n')
        await ctx.reply(`<b>Rules for ${sessionName}:</b>\n${text}`, { parse_mode: 'HTML' })
        return
      }

      if (parts[1] === 'clear') {
        this.registry.clearRules(path)
        await ctx.reply(`🗑 Cleared rules for ${sessionName}`)
        return
      }

      const newRule = parts.slice(1).join(' ')
      this.registry.addRule(path, newRule, profiles)
      await ctx.reply(`✅ Added rule to ${sessionName}: "${newRule}"`)
    })

    // /fact <session> <fact text>
    bot.command('fact', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim() ?? ''
      const parts = args.length > 0 ? args.split(/\s+/) : []
      if (parts.length < 2) {
        await ctx.reply('Usage: /fact <session> <fact text>')
        return
      }
      const sessionName = parts[0]
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }
      const profiles = loadProfilesForHub()
      const factText = parts.slice(1).join(' ')
      this.registry.addFact(path, factText, profiles)
      await ctx.reply(`✅ Added fact to ${sessionName}: "${factText}"`)
    })

    // /channel <session> <reset|instruction text>
    bot.command('channel', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim() ?? ''
      const parts = args.length > 0 ? args.split(/\s+/) : []
      if (parts.length < 2) {
        await ctx.reply('Usage: /channel <session> <reset|instruction text>')
        return
      }
      const sessionName = parts[0]
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }
      if (parts[1] === 'reset') {
        this.registry.clearChannelOverride(path, 'telegram')
        await ctx.reply(`✅ Reset channel instructions for ${sessionName} (using default)`)
        return
      }
      const text = parts.slice(1).join(' ')
      this.registry.setChannelOverride(path, 'telegram', text)
      await ctx.reply(`✅ Channel instructions for ${sessionName} updated`)
    })

    // /verify <session>
    bot.command('verify', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessionName = (ctx.match ?? '').trim()
      if (!sessionName) {
        await ctx.reply('Usage: /verify <session>')
        return
      }
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }

      const result = await this.verificationRunner.run(path)
      await this.sendVerificationResult(ctx, sessionName, result)
    })

    // /facts <session> [clear]
    bot.command('facts', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim() ?? ''
      const parts = args.length > 0 ? args.split(/\s+/) : []
      if (parts.length < 1) {
        await ctx.reply('Usage: /facts <session> [clear]')
        return
      }
      const sessionName = parts[0]
      const path = this.registry.findByName(sessionName)
      if (!path) {
        await ctx.reply(`Session "${sessionName}" not found`)
        return
      }

      if (parts[1] === 'clear') {
        this.registry.clearFacts(path)
        await ctx.reply(`🗑 Cleared facts for ${sessionName}`)
        return
      }

      const profiles = loadProfilesForHub()
      const facts = this.registry.getEffectiveFacts(path, profiles)
      if (facts.length === 0) {
        await ctx.reply(`No facts for ${sessionName}`)
        return
      }
      const text = facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      await ctx.reply(`<b>Facts for ${sessionName}:</b>\n${text}`, { parse_mode: 'HTML' })
    })

    // /prefix <name> <text>
    bot.command('prefix', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const match = ctx.match?.trim() ?? ''
      const spaceIdx = match.indexOf(' ')
      if (spaceIdx === -1) {
        await ctx.reply('Usage: /prefix <name> <text>')
        return
      }
      const name = match.slice(0, spaceIdx)
      const prefixText = match.slice(spaceIdx + 1)
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      this.registry.setPrefix(path, prefixText)
      await ctx.reply(`Prefix for ${name} set to: ${prefixText}`)
    })

    // /all <message>
    bot.command('all', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const message = ctx.match?.trim()
      if (!message) {
        await ctx.reply('Usage: /all <message>')
        return
      }
      const userId = this.getUserId(ctx)
      this.router.broadcast(message, 'telegram', userId)
      await ctx.reply('Broadcast sent to all active sessions.')
    })

    // Callback query handler
    bot.on('callback_query:data', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const data = ctx.callbackQuery.data
      const userId = this.getUserId(ctx)

      if (data.startsWith('select:')) {
        const sessionName = data.slice('select:'.length)
        this.userActiveSessions.set(userId, sessionName)
        await ctx.answerCallbackQuery(`Active session set to: ${sessionName}`)
        await ctx.editMessageText(
          formatSessionList(this.registry.list(), sessionName),
        )
      } else if (data.startsWith('perm:allow:')) {
        const requestId = data.slice('perm:allow:'.length)
        const result = this.permissions.resolve(requestId, 'allow')
        if (result) {
          this.socketServer.sendToSession(result.sessionPath, {
            type: 'permission_response',
            requestId: result.response.requestId,
            behavior: result.response.behavior,
          })
          await ctx.answerCallbackQuery('Permission allowed')
          await ctx.editMessageText(`✅ Allowed: ${requestId}`)
        } else {
          await ctx.answerCallbackQuery('Permission request not found')
        }
      } else if (data.startsWith('perm:deny:')) {
        const requestId = data.slice('perm:deny:'.length)
        const result = this.permissions.resolve(requestId, 'deny')
        if (result) {
          this.socketServer.sendToSession(result.sessionPath, {
            type: 'permission_response',
            requestId: result.response.requestId,
            behavior: result.response.behavior,
          })
          await ctx.answerCallbackQuery('Permission denied')
          await ctx.editMessageText(`❌ Denied: ${requestId}`)
        } else {
          await ctx.answerCallbackQuery('Permission request not found')
        }
      } else {
        const driftMatch = data.match(/^drift:(ignore|remind):(.+)$/)
        if (driftMatch) {
          const [, action, sessionName] = driftMatch
          if (action === 'ignore') {
            await ctx.answerCallbackQuery({ text: 'Ignored' })
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
            return
          }
          const path = this.registry.findByName(sessionName)
          if (path) {
            const profiles = loadProfilesForHub()
            const rules = this.registry.getEffectiveRules(path, profiles)
            const reminder =
              `⚠️ Project rule reminder: ${rules.slice(0, 2).join('; ')}. ` +
              `Please re-do your last action without shortcuts, root-causing the issue instead.`
            this.socketServer.sendToSession(path, {
              type: 'channel_message',
              content: reminder,
              meta: { source: 'hub', frontend: 'telegram', user: 'drift-check', session: sessionName },
            })
            await ctx.answerCallbackQuery({ text: 'Reminder sent' })
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
          }
          return
        }

        const apMatch = data.match(/^ap-(send|cancel):(.+)$/)
        if (apMatch) {
          const [, apAction, sessionName] = apMatch
          const path = this.registry.findByName(sessionName)
          if (!path || !this.vetoController) {
            await ctx.answerCallbackQuery({ text: 'no pending' })
            return
          }
          const pending = this.vetoController.cancel(path)
          if (!pending) {
            await ctx.answerCallbackQuery({ text: 'no pending' })
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
            return
          }
          if (apAction === 'send') {
            this.socketServer.sendToSession(path, {
              type: 'channel_message',
              content: pending.draft,
              meta: { source: 'autopilot', frontend: 'telegram' },
            })
            await ctx.answerCallbackQuery({ text: 'Sent' })
            await ctx.editMessageText(
              `[${sessionName}] ✅ Autopilot draft sent:\n${pending.draft}`,
            ).catch(() => {})
          } else {
            // cancel
            await ctx.answerCallbackQuery({ text: 'cancelled' })
            await ctx.editMessageText(
              `[${sessionName}] ❌ Autopilot draft cancelled — answer yourself.`,
            ).catch(() => {})
          }
        }
      }
    })

    // Message: photo
    bot.on('message:photo', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      const activeName = this.userActiveSessions.get(userId)
      if (!activeName) {
        await ctx.reply('No active session. Use /list to select one.')
        return
      }

      const path = this.registry.findByName(activeName)
      if (!path) { await ctx.reply('Session not found.'); return }
      const session = this.registry.get(path)
      if (!session) return

      const caption = ctx.message.caption ?? ''
      const photos = ctx.message.photo
      const best = photos[photos.length - 1] // largest size

      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) throw new Error('No file path')

        const token = this.bot.token
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())

        const ext = file.file_path.split('.').pop() ?? 'jpg'
        // Photo filename is server-generated so sanitization is light —
        // but we still scope the destination to the session's project root
        // in case session.uploadDir has been crafted to escape.
        const fileName = `photo-${Date.now()}.${ext}`
        const { mkdirSync, writeFileSync } = await import('fs')
        const { join: pathJoin } = await import('path')
        const projectRoot = session.path.replace(/:\d+$/, '')
        const uploadDir = pathJoin(projectRoot, session.uploadDir)
        mkdirSync(uploadDir, { recursive: true })
        const destPath = pathJoin(uploadDir, fileName)
        if (!destPath.startsWith(projectRoot + '/') && destPath !== projectRoot) {
          throw new Error('Upload path escapes project root')
        }
        writeFileSync(destPath, buf)

        // Notify Claude via channel
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: caption ? `${caption}\n\n[Photo uploaded: ${destPath}]` : `[Photo uploaded: ${destPath}]`,
          meta: { source: 'hub', frontend: 'telegram', user: ctx.from!.username ?? String(ctx.from!.id), session: activeName, image_path: destPath },
        })

        await ctx.reply(`📷 Uploaded to ${activeName}:${session.uploadDir}/${fileName}`)
      } catch (err) {
        await ctx.reply(`Failed to upload photo: ${err}`)
      }
    })

    // Message: document (file upload)
    bot.on('message:document', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      const activeName = this.userActiveSessions.get(userId)
      if (!activeName) {
        await ctx.reply('No active session. Use /list to select one.')
        return
      }

      const path = this.registry.findByName(activeName)
      if (!path) { await ctx.reply('Session not found.'); return }
      const session = this.registry.get(path)
      if (!session) return

      const doc = ctx.message.document
      const caption = ctx.message.caption ?? ''

      try {
        const file = await ctx.api.getFile(doc.file_id)
        if (!file.file_path) throw new Error('No file path')

        const token = this.bot.token
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())

        // doc.file_name is attacker-controlled; sanitize and confirm the
        // final path stays inside the session's project root.
        const rawName = doc.file_name ?? `file-${Date.now()}`
        const fileName = rawName
          .split(/[\\/]/).pop()!
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/^\.+/, '_') || `file-${Date.now()}`
        const { mkdirSync, writeFileSync } = await import('fs')
        const { join: pathJoin } = await import('path')
        const projectRoot = session.path.replace(/:\d+$/, '')
        const uploadDir = pathJoin(projectRoot, session.uploadDir)
        mkdirSync(uploadDir, { recursive: true })
        const destPath = pathJoin(uploadDir, fileName)
        if (!destPath.startsWith(projectRoot + '/') && destPath !== projectRoot) {
          throw new Error('Upload path escapes project root')
        }
        writeFileSync(destPath, buf)

        // Notify Claude via channel
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: caption ? `${caption}\n\n[File uploaded: ${destPath}]` : `[File uploaded: ${destPath}]`,
          meta: { source: 'hub', frontend: 'telegram', user: ctx.from!.username ?? String(ctx.from!.id), session: activeName },
        })

        await ctx.reply(`📄 Uploaded ${fileName} to ${activeName}:${session.uploadDir}/`)
      } catch (err) {
        await ctx.reply(`Failed to upload file: ${err}`)
      }
    })

    // Message: text
    bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const text = ctx.message.text
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      // Check for targeted message via router
      const targeted = this.router.parseTargetedMessage(text)
      if (targeted) {
        const sent = this.router.routeToSession(targeted.sessionName, targeted.text, 'telegram', userId)
        if (!sent) {
          await ctx.reply(`Session "${targeted.sessionName}" is not active.`)
        }
        return
      }

      // Send to active session
      const activeSession = this.getActiveSession(userId)
      if (!activeSession) {
        await ctx.reply('No active session selected. Use /list to select one.')
        return
      }
      const sent = this.router.routeToSession(activeSession, text, 'telegram', userId)
      if (!sent) {
        await ctx.reply(`Session "${activeSession}" is not active.`)
      }
    })
  }

  async deliverToUser(sessionName: string, text: string, files?: string[]): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const fullText = `[${sessionName}] ${text}`
    const chunks = chunkText(fullText, 4096)

    for (const userId of recipients) {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(userId, chunk)
      }
      if (files && files.length > 0) {
        for (const filePath of files) {
          await this.bot.api.sendDocument(userId, new InputFile(filePath))
        }
      }
    }
  }

  async deliverFileContent(sessionName: string, filePath: string, content: string): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const maxInline = 3500 // headroom for markdown code-block wrapping
    const filename = filePath.split('/').pop() ?? 'file.txt'

    if (content.length <= maxInline) {
      const text = `[${sessionName}] 📄 \`${filePath}\`:\n\n\`\`\`\n${content}\n\`\`\``
      for (const userId of recipients) {
        await this.bot.api
          .sendMessage(userId, text, { parse_mode: 'Markdown' })
          .catch(() => {})
      }
      return
    }

    const buffer = Buffer.from(content, 'utf8')
    for (const userId of recipients) {
      try {
        await this.bot.api.sendDocument(userId, new InputFile(buffer, filename), {
          caption: `[${sessionName}] 📄 ${filePath} (${content.length} chars)`,
        })
      } catch (err) {
        process.stderr.write(`telegram: failed to send file attachment: ${err}\n`)
      }
    }
  }

  async deliverDriftAlert(sessionName: string, htmlMessage: string, _matches: unknown[]): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const keyboard = new InlineKeyboard()
      .text('🤐 Ignore', `drift:ignore:${sessionName}`)
      .text('📣 Remind Claude', `drift:remind:${sessionName}`)

    for (const userId of recipients) {
      try {
        await this.bot.api.sendMessage(userId, htmlMessage, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
      } catch (err) {
        process.stderr.write(`telegram: drift alert failed: ${err}\n`)
      }
    }
  }

  private async sendVerificationResult(
    ctx: { reply: (text: string, opts?: any) => Promise<any> },
    sessionName: string,
    result: VerificationResult,
  ): Promise<void> {
    await renderVerificationResult(ctx.reply.bind(ctx), sessionName, result)
  }

  async deliverAutopilotDraft(sessionName: string, draft: string, vetoMs: number): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const seconds = Math.round(vetoMs / 1000)
    const text =
      `🤖 <b>Autopilot draft</b> for <b>${sessionName}</b> (auto-sends in ${seconds}s):\n\n` +
      `<blockquote>${draft.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</blockquote>`

    const keyboard = new InlineKeyboard()
      .text('✅ Send', `ap-send:${sessionName}`)
      .text('❌ Cancel', `ap-cancel:${sessionName}`)

    for (const userId of recipients) {
      try {
        await this.bot.api.sendMessage(userId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
      } catch (err) {
        process.stderr.write(`telegram: deliverAutopilotDraft failed: ${err}\n`)
      }
    }
  }

  async deliverPermissionRequest(req: PermissionRequest): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const text =
      `🔐 Permission request from <b>${req.sessionName}</b>\n` +
      `Tool: <code>${req.toolName}</code>\n` +
      `Description: ${req.description}\n` +
      `Preview: <code>${req.inputPreview}</code>`

    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${req.requestId}`)
      .text('❌ Deny', `perm:deny:${req.requestId}`)

    for (const userId of recipients) {
      await this.bot.api.sendMessage(userId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    }
  }

  async start(): Promise<void> {
    // Register the command menu so Telegram shows autocomplete in the chat input.
    const commands = [
      { command: 'list',     description: 'Show all sessions' },
      { command: 'status',   description: 'Dashboard with details' },
      { command: 'spawn',    description: 'Spawn a new session: <name> <path> [--profile <n>] [team-size]' },
      { command: 'kill',     description: 'Gracefully end a session: <name>' },
      { command: 'remove',   description: 'Remove a disconnected session from the list: <name>' },
      { command: 'team',     description: 'Show team or add teammate: <name> [add]' },
      { command: 'trust',    description: 'Set trust: <name> strict|ask|auto|yolo' },
      { command: 'prefix',   description: 'Set message prefix: <name> <text>' },
      { command: 'rename',   description: 'Rename a session: <old> <new>' },
      { command: 'all',      description: 'Broadcast to all sessions: <message>' },
      { command: 'profiles', description: 'List available profiles' },
      { command: 'profile',  description: 'Show/create/delete a profile' },
      { command: 'rules',    description: 'Session rules: <name> [clear|text]' },
      { command: 'fact',     description: 'Add fact to session: <name> <text>' },
      { command: 'facts',    description: 'Show/clear facts: <name> [clear]' },
      { command: 'channel',  description: 'Override channel instructions: <name> <reset|text>' },
      { command: 'verify',   description: 'Run verification commands: <session>' },
      { command: 'autopilot', description: 'Toggle autopilot: <name> on|off' },
    ]
    try {
      // Wipe any stale commands across every scope, then set fresh.
      // Telegram clients cache per-scope; clearing then re-pushing forces a refresh.
      for (const scope of [
        { type: 'default' as const },
        { type: 'all_private_chats' as const },
        { type: 'all_group_chats' as const },
      ]) {
        try { await this.bot.api.deleteMyCommands({ scope }) } catch {}
      }
      await this.bot.api.setMyCommands(commands, { scope: { type: 'default' } })
      await this.bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } })
      await this.bot.api.setChatMenuButton({ menu_button: { type: 'commands' } })
      process.stderr.write(`hub telegram: registered ${commands.length} commands (default + all_private_chats)\n`)
    } catch (err) {
      process.stderr.write(`hub telegram: setMyCommands failed: ${err}\n`)
    }

    // Retry with backoff on 409 Conflict (another bot instance polling)
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({
          onStart: (info) => {
            process.stderr.write(`hub telegram: polling as @${info.username}\n`)
          },
        })
        return
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 409) {
          const delay = Math.min(1000 * attempt, 15000)
          const detail = attempt === 1 ? ' — another instance may still be shutting down' : ''
          process.stderr.write(`hub telegram: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw err
      }
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }
}
