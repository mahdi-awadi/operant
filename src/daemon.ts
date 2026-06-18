// src/daemon.ts
import { join } from 'path'
import { readFileSync, statSync, existsSync, mkdirSync } from 'fs'
import { loadOperantConfig, loadSessions, saveSessions, loadProfilesForOperant, saveProfilesForOperant, OPERANT_DIR, resolveAutopilotDefaults } from './config'
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
import { wrapQuestion, isTrivialReply } from './autopilot-risk'
import { VetoController } from './veto-controller'
import { EscalationController } from './escalation-controller'
import { ErrorLog } from './error-log'
import { openOperantDb } from './operant-db'
import { CompanyStore } from './company/store'
import { handleCompanyTool } from './company/tools'
import { loadOrg } from './company/org-loader'
import { decideWakes } from './company/orchestrator'
import { spawnDepartment } from './company/spawn'
import { Personalities } from './personalities'
import { Decisions } from './decisions'
import { Messages } from './messages'
import { BrowserController } from './browser-controller'

const DRIFT_RATE_LIMIT_MS = 2 * 60 * 1000 // 2 minutes between alerts per session

/** Parse a 5-field cron string and return true if minute, hour, and day-of-week match now.
 *  Supports '*' (any) and comma lists like '7,13,19'. DOM and month are ignored for MVP. */
function cronDueNow(cron: string | null, now: Date): boolean {
  if (!cron) return false
  const fields = cron.trim().split(/\s+/)
  if (fields.length < 5) return false
  const [minF, hourF, , , dowF] = fields
  const matches = (field: string, value: number): boolean => {
    if (field === '*') return true
    return field.split(',').map(Number).includes(value)
  }
  return (
    matches(minF, now.getMinutes()) &&
    matches(hourF, now.getHours()) &&
    matches(dowF, now.getDay())
  )
}

export function deptIdForPath(path: string, store: CompanyStore): string | null {
  const folder = path.replace(/:\d+$/, '')
  for (const d of store.listDepartments()) {
    if (d.folder === folder) return d.id
  }
  return null
}

async function findChromiumPath(override?: string): Promise<string | null> {
  if (override) return override
  try {
    const { chromium } = await import('playwright')
    const p = chromium.executablePath()
    if (p) return p
  } catch { /* playwright not installed or chromium not downloaded */ }
  return null
}
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

const config = loadOperantConfig()
const savedSessions = loadSessions()

let profiles: Profile[] = loadProfilesForOperant()
process.stderr.write(`operant: loaded ${profiles.length} profiles\n`)

export function getProfiles(): Profile[] {
  return profiles
}

export function reloadProfiles(): void {
  profiles = loadProfilesForOperant()
}

const SOCKET_PATH = process.env.OPERANT_SOCKET ?? join(OPERANT_DIR, 'operant.sock')

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
const escalationController = new EscalationController()
// Single SQLite file backing errors + personalities + assignments. Migrates
// the legacy errors.sqlite on first boot if present (renamed to .bak).
const operantDb = openOperantDb(OPERANT_DIR)
const errorLog = new ErrorLog(operantDb.db)
const personalities = new Personalities(operantDb.db)
const decisions = new Decisions(operantDb.db)
const messages = new Messages(operantDb.db)
const companyStore = new CompanyStore(operantDb.db)
companyStore.setMemoryMirrorDir('/home/company/memory')
try { loadOrg('/home/company', companyStore) } catch (e) { console.error('org load failed', e) }
mkdirSync('/home/company/desks/secretary', { recursive: true })
// Bound error-log storage at 5000 entries — captured panes can be large.
setInterval(() => errorLog.purgeKeepLast(5000), 60 * 60 * 1000).unref()
// Bound decision history to last 500 per session.
setInterval(() => decisions.purgeKeepLastPerSession(500), 60 * 60 * 1000).unref()
// Bound visible chat history to last 1000 per session.
setInterval(() => messages.purgeKeepLastPerSession(1000), 60 * 60 * 1000).unref()
// Orchestrator tick: wake departments that are due and have pending work.
setInterval(async () => {
  const depts = companyStore.listDepartments()
  const wake = decideWakes(new Date(), depts, {
    maxConcurrent: 2,
    isDue: (cron, now) => cronDueNow(cron, now),
    hasInboxOrAssigned: (id) => companyStore.listTasks({ dept_id: id }).some(t => t.status === 'inbox' || t.status === 'assigned'),
    minutesUsedThisWeek: () => 0, // MVP: ledger summation is a Phase-4 refinement
  })
  for (const id of wake) {
    const d = companyStore.getDepartment(id)!
    if (registry.findByName(id)) continue // already running
    companyStore.upsertDepartment({ ...d, status: 'computing' })
    try { await spawnDepartment(d, screenManager) } catch (e) { console.error('wake failed', id, e) }
  }
}, 60 * 1000).unref()
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

// Headless Chrome — daemon-managed, attached by chrome-devtools-mcp.
let browserController: BrowserController | null = null
if (config.chromeEnabled !== false) {
  const exec = await findChromiumPath(config.chromeExecutablePath)
  if (!exec) {
    process.stderr.write('operant: chrome disabled — chromium binary not found (run "bunx playwright install chromium")\n')
  } else {
    browserController = new BrowserController({
      port: config.chromePort ?? 9222,
      profileDir: join(OPERANT_DIR, 'chrome-profile'),
      executablePath: exec,
    })
    browserController.start().catch(err => process.stderr.write(`operant: chrome failed to start: ${err}\n`))
  }
}

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
  process.stderr.write(`operant: session connected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()
})

socketServer.on('session:disconnected', (path: string) => {
  const session = registry.get(path)
  process.stderr.write(`operant: session disconnected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()

  // Reset department status to 'idle' so the orchestrator can wake it again.
  const deptId = deptIdForPath(path, companyStore)
  if (deptId) {
    const dept = companyStore.getDepartment(deptId)
    if (dept) companyStore.upsertDepartment({ ...dept, status: 'idle' })
  }

  if (session?.managed) {
    const s = registry.get(path)
    if (s) s.status = 'respawning'
    webFrontend?.refreshSessions()
    screenManager.scheduleRespawn(session.name)
  }
})

socketServer.on('tool_call', async (path: string, name: string, args: Record<string, unknown>) => {
  const session = registry.get(path)
  if (!session) return

  if (name.startsWith('company_')) {
    const deptId = deptIdForPath(path, companyStore) ?? 'unknown'
    let result: string, isError = false
    try { result = await handleCompanyTool(companyStore, deptId, name, args) }
    catch (e) { result = String(e); isError = true }
    socketServer.sendToSession(path, { type: 'tool_result', name, result, isError })
    if (name === 'company_request_approval' && !isError) {
      const pending = companyStore.listPendingApprovals()
      const appr = pending[pending.length - 1]
      if (appr) {
        telegramFrontend?.deliverApprovalRequest(appr)
        webFrontend?.deliverApprovalRequest(appr)
      }
    }
    return
  }

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
      // Skip trivial replies — pure emoji acknowledgements like 👍 carry no
      // question, but the daemon used to dutifully fire /btw on them, get an
      // ack-shaped answer, deliver it back to the session, and the session
      // would 👍 again, and so on indefinitely. The ap-test session got
      // wedged in this loop on 2026-04-27 (errors.sqlite #20-#21). Bail
      // before doing any work — no decision row, no toast, no escalation.
      if (isTrivialReply(text)) {
        process.stderr.write(`operant: autopilot ${session.name} skip — trivial reply ${JSON.stringify(text.slice(0, 40))}\n`)
        return
      }
      // Duration cap removed — autopilot runs as long as the user keeps it on.
      // The user disables it explicitly via the toggle when they want to take
      // back control; we don't pull the rug at an arbitrary time threshold.
      const sessionName = session.name
      const managed = screenManager.getManagedByPath(registry.folderPath(path))
      const tmuxName = managed?.sessionName ?? `operant-${sessionName}`
      const prefs = loadProjectPreferences(registry.folderPath(path))
      // If this session has a personality assigned, splice its system_prompt
      // into the wrap. Falls back to the default constraint block otherwise.
      const personality = personalities.getForSession(path)
      const wrapped = wrapQuestion(text, prefs, personality
        ? { name: personality.name, systemPrompt: personality.systemPrompt }
        : undefined)
      const riskKeywords = ap.riskKeywords ?? autopilotDefaults.riskKeywords
      const apT0 = Date.now()
      autopilotRunner.runBtw(tmuxName, wrapped, {
        rawQuestion: text,
        riskKeywords,
        riskOverride: ap.riskOverride,
      }).then(result => {
        const elapsed = Date.now() - apT0
        process.stderr.write(`operant: autopilot ${sessionName} ${elapsed}ms status=${result.status}${result.status === 'answered' ? ` length=${result.answer.length}` : ''}\n`)
        // Log every non-answered outcome to SQLite so the user can see WHY
        // /btw didn't deliver — captured pane is the most useful field.
        if (result.status !== 'answered') {
          const reasonKind = result.status === 'escalate'
            ? (/risk keyword/i.test(result.reason) ? 'risk' : 'escalate' as const)
            : result.status
          try {
            errorLog.record({
              ts: Date.now(),
              sessionName,
              sessionPath: path,
              status: reasonKind === 'escalate' ? 'escalate' : reasonKind === 'risk' ? 'risk' : reasonKind,
              reason: result.status === 'escalate' ? result.reason : `/btw ${result.status}`,
              rawQuestion: text,
              wrappedQuestion: wrapped,
              capturedPane: result.pane,
              durationMs: elapsed,
            })
          } catch (err) {
            process.stderr.write(`operant: error-log record failed for ${sessionName}: ${err}\n`)
          }
        }
        if (result.status === 'answered') {
          // Audit trail — the autopilot actually answered, log it. Failure
          // outcomes already go to errorLog above; this complements that.
          let decisionId: number | undefined
          try {
            decisionId = decisions.record({
              ts: Date.now(),
              sessionName,
              sessionPath: path,
              personalityId: personality?.id,
              personalityName: personality?.name,
              rawQuestion: text,
              answer: result.answer,
              durationMs: elapsed,
            })
          } catch (err) {
            process.stderr.write(`operant: decisions.record failed for ${sessionName}: ${err}\n`)
          }
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
            }, decisionId)
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
          const reasonKind = /risk keyword/i.test(result.reason) ? 'risk'
            : /^proxy escalated/i.test(result.reason) ? 'escalate_token'
            : 'other'
          escalationController.record({
            path, sessionName, rawQuestion: text, wrappedQuestion: wrapped,
            tmuxName, reason: result.reason, reasonKind, createdAt: Date.now(),
          })
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot escalated: ${result.reason}`)
          webFrontend?.deliverAutopilotEscalation?.(path, sessionName, text, result.reason, reasonKind)
        } else {
          const kind: 'parse_error' | 'timeout' = result.status
          escalationController.record({
            path, sessionName, rawQuestion: text, wrappedQuestion: wrapped,
            tmuxName, reason: `${result.status}: /btw did not complete`, reasonKind: kind,
            createdAt: Date.now(),
          })
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot failed (${result.status}); please answer directly.`)
          webFrontend?.deliverAutopilotEscalation?.(path, sessionName, text, `autopilot /btw failed (${result.status})`, kind)
        }
      }).catch(err => {
        process.stderr.write(`operant: autopilot error for ${sessionName}: ${err}\n`)
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
  } else if (name === 'list_sessions') {
    // Return the registry so the caller can discover peer session names.
    // Excludes the path:index suffix and includes a self flag.
    const all = registry.list().map(s => ({
      name: s.name,
      status: s.status,
      folder: registry.folderPath(s.path),
      teamIndex: s.teamIndex,
      self: s.path === path,
    }))
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'list_sessions',
      result: { sessions: all },
    })
  } else if (name === 'send_to_session') {
    // Cross-session routing — Claude in one session sends a message directly
    // to another session via the daemon, without the user having to relay.
    const targetName = String(args.name ?? '')
    const text = String(args.text ?? '')
    type SendResult = { ok: boolean; reason?: string; available?: string[] }
    let result: SendResult = { ok: false }
    if (!targetName || !text) {
      result = { ok: false, reason: 'name and text are required' }
    } else {
      const targetPath = registry.findByName(targetName)
      if (!targetPath) {
        // Session not found — return the list of active session names so the
        // caller can recover (e.g. user shorthand "team 2" → registry "team-test-2").
        const available = registry.list()
          .filter(s => s.status === 'active' && s.path !== path)
          .map(s => s.name)
        result = {
          ok: false,
          reason: `Session not found: "${targetName}". Use list_sessions to discover peer names.`,
          available,
        }
      } else if (targetPath === path) {
        result = { ok: false, reason: 'Cannot send to self' }
      } else {
        const target = registry.get(targetPath)
        if (!target || target.status !== 'active') {
          result = { ok: false, reason: `Session ${targetName} is not active (status=${target?.status ?? 'unknown'})` }
        } else {
          // Route via the existing message router so prefix/profile injection
          // and per-frontend rendering apply uniformly.
          router.routeToSession(targetName, text, 'cli', `session-${session.name}`)
          result = { ok: true }
          // Surface the cross-session relay to the user too, so it's visible
          // in their dashboard and not silently moving between Claudes.
          const note = `↪ ${session.name} → ${targetName}: ${text}`
          telegramFrontend?.deliverToUser(session.name, note)
          webFrontend?.deliverToUser(session.name, note)
        }
      }
    }
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'send_to_session',
      result,
      isError: !result.ok,
    })
  }
})

socketServer.on('permission_request', (path: string, msg: any) => {
  process.stderr.write(`operant: permission_request from ${path}: ${msg.toolName} (${msg.requestId})\n`)
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
  process.stderr.write(`operant: socket server listening on ${SOCKET_PATH}\n`)

  let telegramBotUsername = config.telegramBotUsername ?? ''
  if (!telegramBotUsername && config.telegramToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`)
      const data = await res.json() as any
      if (data.ok) telegramBotUsername = data.result.username
    } catch {}
  }
  if (telegramBotUsername) {
    process.stderr.write(`operant: telegram login widget bot = @${telegramBotUsername}\n`)
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
    escalationController,
    autopilotRunner,
    errorLog,
    personalities,
    decisions,
    messages,
    companyStore,
  })
  await webFrontend.start()
  process.stderr.write(`operant: web UI at http://localhost:${webFrontend.port}\n`)

  if (config.telegramToken) {
    if (config.telegramAllowFrom.length === 0) {
      // Refuse to start. An empty allowlist used to mean "allow all", which
      // makes a mis-configured bot publicly reachable by any Telegram user —
      // equivalent to a shell on this machine once /spawn or /send lands.
      process.stderr.write(
        'operant: telegramToken is set but telegramAllowFrom is empty — refusing to start telegram frontend. ' +
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
        escalationController,
        autopilotRunner,
        companyStore,
      })
      telegramFrontend.start().catch(err => {
        process.stderr.write(`operant: telegram failed to start: ${err}\n`)
      })
    }
  } else {
    process.stderr.write('operant: no telegram token — skipping telegram frontend\n')
  }

  // Permission relay works natively through the MCP channel protocol.
  // No tmux polling needed — Claude Code sends permission_request notifications
  // directly to the shim, which forwards them to the daemon.

  process.stderr.write('operant: daemon ready\n')
}

async function shutdown(): Promise<void> {
  process.stderr.write('operant: shutting down...\n')
  taskMonitor.stopPolling()
  saveSessions(registry.toSaveFormat())
  await screenManager.killAll()
  await socketServer.stop()
  await webFrontend?.stop()
  await telegramFrontend?.stop()
  if (browserController) {
    await browserController.stop().catch(err => process.stderr.write(`operant: chrome stop error: ${err}\n`))
  }
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
  process.stderr.write(`operant: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`operant: uncaught exception: ${err}\n`)
})

start().catch(err => {
  process.stderr.write(`operant: failed to start: ${err}\n`)
  process.exit(1)
})
