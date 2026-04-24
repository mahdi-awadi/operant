// src/daemon.ts
import { join } from 'path'
import { readFileSync, statSync, existsSync } from 'fs'
import { loadHubConfig, loadSessions, saveSessions, loadProfilesForHub, saveProfilesForHub, HUB_DIR, resolveAutopilotDefaults } from './config'
import { SessionRegistry } from './session-registry'
import { SocketServer } from './socket-server'
import { PermissionEngine } from './permission-engine'
import { MessageRouter } from './message-router'
import { ScreenManager } from './screen-manager'
import { TaskMonitor } from './task-monitor'
import { TelegramFrontend } from './frontends/telegram'
import { WebFrontend } from './frontends/web'
import type { PermissionRequest, Profile, FrontendSource } from './types'
import { getProfile, resolveSession, injectContext } from './profiles'
import { detectDrift } from './analysis'
import { VerificationRunner } from './verification'
import { AutopilotRunner } from './autopilot'
import { wrapQuestion } from './autopilot-risk'
import { VetoController } from './veto-controller'

const DRIFT_RATE_LIMIT_MS = 2 * 60 * 1000 // 2 minutes between alerts per session
const lastDriftNotif = new Map<string, number>()

// Auto-fetch file contents when Claude emits a bare save/write path in a reply.
const FILE_PATH_PATTERNS: RegExp[] = [
  /saved to:?\s+([`'"]?)([\/~][\w\/.\-]+\.(md|json|yaml|yml|ts|tsx|js|jsx|py|go|rs|txt|toml))\1/i,
  /written to:?\s+([`'"]?)([\/~][\w\/.\-]+\.(md|json|yaml|yml|ts|tsx|js|jsx|py|go|rs|txt|toml))\1/i,
  /spec saved:?\s+([`'"]?)([\/~][\w\/.\-]+\.(md|json|yaml|yml|ts|tsx|js|jsx|py|go|rs|txt|toml))\1/i,
]
const MAX_AUTOFETCH_SIZE = 50 * 1024 // 50KB cap
const AUTOFETCH_DEDUP_MS = 10_000
const lastAutoFetch = new Map<string, number>()

function tryAutoFetchPath(reply: string): string | null {
  for (const pattern of FILE_PATH_PATTERNS) {
    const match = pattern.exec(reply)
    if (match) {
      let path = match[2] ?? ''
      if (path.startsWith('~')) {
        path = path.replace('~', process.env.HOME ?? '')
      }
      return path
    }
  }
  return null
}

function readFileSafely(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    if (stat.size > MAX_AUTOFETCH_SIZE) return null
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

const config = loadHubConfig()
const savedSessions = loadSessions()

let profiles: Profile[] = loadProfilesForHub()
process.stderr.write(`hub: loaded ${profiles.length} profiles\n`)

export function getProfiles(): Profile[] {
  return profiles
}

export function reloadProfiles(): void {
  profiles = loadProfilesForHub()
}

const SOCKET_PATH = process.env.HUB_SOCKET ?? join(HUB_DIR, 'hub.sock')

const SHIM_COMMAND = `bun run ${join(import.meta.dir, 'shim.ts')}`

// Session registry
const registry = new SessionRegistry({
  defaultTrust: config.defaultTrust,
  defaultUploadDir: config.defaultUploadDir,
})
registry.restoreFrom(savedSessions)

const verificationRunner = new VerificationRunner({
  registry,
  profiles: getProfiles,
})

// Permission engine
let telegramFrontend: TelegramFrontend | null = null
let webFrontend: WebFrontend | null = null

const permissions = new PermissionEngine(registry, (req: PermissionRequest) => {
  telegramFrontend?.deliverPermissionRequest(req)
  webFrontend?.deliverPermissionRequest(req)
})

// Screen manager
const screenManager = new ScreenManager()

// Autopilot
const autopilotDefaults = resolveAutopilotDefaults(config)
const vetoController = new VetoController()
const autopilotRunner = new AutopilotRunner({
  screenManager,
  btwTimeoutMs: autopilotDefaults.btwTimeoutMs,
})

function loadProjectPreferences(projectPath: string): string {
  const candidates = [
    join(projectPath, 'autopilot.md'),
    join(process.env.HOME ?? '', '.claude', 'autopilot.md'),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch { /* ignore */ }
  }
  return ''
}

// Task monitor
const taskMonitor = new TaskMonitor()
taskMonitor.startPolling(2000)

taskMonitor.on('tasks:updated', () => {
  const grouped = taskMonitor.readAllGrouped()
  webFrontend?.deliverTaskUpdate(grouped)
})

// Socket server
const socketServer = new SocketServer(registry, SOCKET_PATH)

socketServer.onLookupProfile = (folder: string) => {
  const entry = screenManager.getManagedByPath(folder)
  if (!entry) return { managed: false }
  const profile = entry.profileName ? getProfile(entry.profileName, profiles) : undefined
  return { managed: true, profile }
}

// Message router
const router = new MessageRouter(
  registry,
  (path, content, meta) => {
    // Resolve effective session config and inject channel instructions,
    // rules, and facts based on the frontend that sent this message.
    const session = registry.get(path)
    let enrichedContent = content
    if (session) {
      const effective = resolveSession(
        { appliedProfile: session.appliedProfile, profileOverrides: session.profileOverrides },
        profiles,
      )
      const frontend = (meta.frontend ?? 'web') as FrontendSource
      enrichedContent = injectContext(content, frontend, effective)
    }
    return socketServer.sendToSession(path, {
      type: 'channel_message',
      content: enrichedContent,
      meta,
    })
  },
  (sessionName, text, files) => {
    telegramFrontend?.deliverToUser(sessionName, text, files)
    webFrontend?.deliverToUser(sessionName, text, files)
  },
)

// Wire socket server events
socketServer.on('session:connected', (path: string) => {
  process.stderr.write(`hub: session connected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()
})

socketServer.on('session:disconnected', (path: string) => {
  const session = registry.get(path)
  process.stderr.write(`hub: session disconnected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()

  if (session?.managed) {
    const s = registry.get(path)
    if (s) s.status = 'respawning'
    webFrontend?.refreshSessions()
    screenManager.scheduleRespawn(session.name)
  }
})

socketServer.on('tool_call', (path: string, name: string, args: Record<string, unknown>) => {
  const session = registry.get(path)
  if (!session) return

  if (name === 'reply') {
    const text = args.text as string
    const files = args.files as string[] | undefined
    router.routeFromSession(path, text, files)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'reply',
      result: 'sent',
    })

    // Drift detection — advisory notification only, rate-limited per session.
    const effective = resolveSession(
      { appliedProfile: session.appliedProfile, profileOverrides: session.profileOverrides },
      profiles,
    )
    if (effective.driftDetection && effective.rules.length > 0) {
      const lastNotif = lastDriftNotif.get(path) ?? 0
      if (Date.now() - lastNotif >= DRIFT_RATE_LIMIT_MS) {
        const matches = detectDrift(text, effective.rules)
        if (matches.length > 0) {
          lastDriftNotif.set(path, Date.now())
          const notif =
            `⚠️ Possible drift in <b>${session.name}</b>:\n` +
            matches.slice(0, 3).map(m => `• "${m.phrase}" — ${m.context}`).join('\n') +
            `\n\nRules: ${effective.rules.slice(0, 2).join('; ')}`
          telegramFrontend?.deliverDriftAlert(session.name, notif, matches)
        }
      }
    }

    // Auto-fetch file content when Claude emits a bare save/write path.
    // Scope strictly to the session's project root so a prompt-injected
    // reply can't trick us into reading /home/you/.ssh/id_rsa and forwarding
    // it to the user's Telegram.
    const fetchedPath = tryAutoFetchPath(text)
    if (fetchedPath) {
      const projectRoot = registry.folderPath(session.path)
      const inside =
        fetchedPath === projectRoot ||
        fetchedPath.startsWith(projectRoot + '/')
      if (inside) {
        const lastFetch = lastAutoFetch.get(fetchedPath) ?? 0
        if (Date.now() - lastFetch > AUTOFETCH_DEDUP_MS) {
          lastAutoFetch.set(fetchedPath, Date.now())
          const content = readFileSafely(fetchedPath)
          if (content) {
            telegramFrontend?.deliverFileContent(session.name, fetchedPath, content)
            webFrontend?.deliverToUser(
              session.name,
              `📄 Contents of \`${fetchedPath}\`:\n\n\`\`\`\n${content}\n\`\`\``,
            )
          }
        }
      }
    }
    // Autopilot: if this session is in autopilot mode, proxy the user's answer
    // via /btw instead of waiting for a human.
    const ap = registry.getAutopilot(path)
    if (ap?.enabled) {
      // Duration cap: if autopilot has run longer than maxDurationMinutes, escalate
      // and turn it off instead of firing /btw.
      if (ap.startedAt) {
        const maxMin = ap.maxDurationMinutes ?? autopilotDefaults.maxDurationMinutes
        if (Date.now() - ap.startedAt > maxMin * 60_000) {
          const prompt = `Autopilot has been running on "${session.name}" for ${maxMin}+ min. Reply "/autopilot ${session.name} on" to extend, or just answer the question directly to take over.`
          telegramFrontend?.deliverToUser(session.name, `🟡 ${prompt}`)
          webFrontend?.deliverToUser(session.name, `🟡 ${prompt}`)
          if (ap.priorTrust) registry.setTrust(path, ap.priorTrust)
          registry.setAutopilot(path, { ...ap, enabled: false, priorTrust: undefined, startedAt: undefined })
          return
        }
      }
      const sessionName = session.name
      const tmuxName = `hub-${sessionName}`
      const prefs = loadProjectPreferences(registry.folderPath(path))
      const wrapped = wrapQuestion(text, prefs)
      const riskKeywords = ap.riskKeywords ?? autopilotDefaults.riskKeywords
      autopilotRunner.runBtw(tmuxName, wrapped, {
        rawQuestion: text,
        riskKeywords,
        riskOverride: ap.riskOverride,
      }).then(result => {
        if (result.status === 'answered') {
          const vetoMs = ap.vetoWindowMs ?? autopilotDefaults.vetoWindowMs
          if (vetoMs > 0) {
            const veto = vetoController.schedule(path, sessionName, result.answer, vetoMs, (v) => {
              socketServer.sendToSession(v.path, {
                type: 'channel_message',
                content: v.draft,
                meta: { source: 'autopilot', frontend: 'web' },
              })
              telegramFrontend?.deliverToUser(v.sessionName, `🤖 Autopilot sent: ${v.draft}`)
              webFrontend?.deliverToUser(v.sessionName, `🤖 Autopilot sent: ${v.draft}`)
            })
            telegramFrontend?.deliverAutopilotDraft(sessionName, veto.draft, vetoMs)
            webFrontend?.deliverAutopilotDraft(path, sessionName, veto.draft, vetoMs)
          } else {
            socketServer.sendToSession(path, {
              type: 'channel_message',
              content: result.answer,
              meta: { source: 'autopilot', frontend: 'web' },
            })
            telegramFrontend?.deliverToUser(sessionName, `🤖 Autopilot answered: ${result.answer}`)
            webFrontend?.deliverToUser(sessionName, `🤖 Autopilot answered: ${result.answer}`)
          }
        } else if (result.status === 'escalate') {
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot escalated: ${result.reason}`)
          webFrontend?.deliverToUser(sessionName, `🟡 Autopilot escalated: ${result.reason}`)
        } else {
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot failed (${result.status}); please answer directly.`)
          webFrontend?.deliverToUser(sessionName, `🟡 Autopilot failed (${result.status}); please answer directly.`)
        }
      }).catch(err => {
        process.stderr.write(`hub: autopilot error for ${sessionName}: ${err}\n`)
      })
    }
  } else if (name === 'edit_message') {
    telegramFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    webFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'edit_message',
      result: 'edited',
    })
  }
})

socketServer.on('permission_request', (path: string, msg: any) => {
  process.stderr.write(`hub: permission_request from ${path}: ${msg.toolName} (${msg.requestId})\n`)
  const response = permissions.handle(path, {
    requestId: msg.requestId,
    toolName: msg.toolName,
    description: msg.description,
    inputPreview: msg.inputPreview,
    toolArgs: msg.toolArgs,  // NEW
  })
  if (response) {
    socketServer.sendToSession(path, {
      type: 'permission_response',
      requestId: response.requestId,
      behavior: response.behavior,
    })
  }
})

// Start everything
async function start(): Promise<void> {
  await socketServer.start()
  process.stderr.write(`hub: socket server listening on ${SOCKET_PATH}\n`)

  let telegramBotUsername = config.telegramBotUsername ?? ''
  if (!telegramBotUsername && config.telegramToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`)
      const data = await res.json() as any
      if (data.ok) telegramBotUsername = data.result.username
    } catch {}
  }
  if (telegramBotUsername) {
    process.stderr.write(`hub: telegram login widget bot = @${telegramBotUsername}\n`)
  }

  webFrontend = new WebFrontend({
    port: config.webPort,
    host: config.webHost,
    browseRoot: config.browseRoot,
    registry,
    router,
    permissions,
    socketServer,
    screenManager,
    telegramToken: config.telegramToken,
    telegramBotUsername,
    telegramAllowFrom: config.telegramAllowFrom,
    taskMonitor,
    vetoController,
    autopilotRunner,
  })
  await webFrontend.start()
  process.stderr.write(`hub: web UI at http://localhost:${webFrontend.port}\n`)

  if (config.telegramToken) {
    if (config.telegramAllowFrom.length === 0) {
      // Refuse to start. An empty allowlist used to mean "allow all", which
      // makes a mis-configured bot publicly reachable by any Telegram user —
      // equivalent to a shell on this machine once /spawn or /send lands.
      process.stderr.write(
        'hub: telegramToken is set but telegramAllowFrom is empty — refusing to start telegram frontend. ' +
        'Add your Telegram user id to telegramAllowFrom in config.json.\n',
      )
    } else {
      telegramFrontend = new TelegramFrontend({
        token: config.telegramToken,
        registry,
        router,
        permissions,
        screenManager,
        socketServer,
        allowFrom: config.telegramAllowFrom,
        taskMonitor,
        verificationRunner,
        vetoController,
        autopilotRunner,
      })
      telegramFrontend.start().catch(err => {
        process.stderr.write(`hub: telegram failed to start: ${err}\n`)
      })
    }
  } else {
    process.stderr.write('hub: no telegram token — skipping telegram frontend\n')
  }

  // Permission relay works natively through the MCP channel protocol.
  // No tmux polling needed — Claude Code sends permission_request notifications
  // directly to the shim, which forwards them to the daemon.

  process.stderr.write('hub: daemon ready\n')
}

async function shutdown(): Promise<void> {
  process.stderr.write('hub: shutting down...\n')
  taskMonitor.stopPolling()
  saveSessions(registry.toSaveFormat())
  await screenManager.killAll()
  await socketServer.stop()
  await webFrontend?.stop()
  await telegramFrontend?.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Ignore stdin close — daemon should not die when terminal detaches
process.stdin.on('end', () => {})
process.stdin.on('close', () => {})
process.stdin.resume()

// Prevent unhandled rejections from crashing the daemon
process.on('unhandledRejection', err => {
  process.stderr.write(`hub: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`hub: uncaught exception: ${err}\n`)
})

start().catch(err => {
  process.stderr.write(`hub: failed to start: ${err}\n`)
  process.exit(1)
})
