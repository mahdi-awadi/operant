// src/frontends/web.ts
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, resolve, basename, relative } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { writeFile } from 'fs/promises'
import { createHmac, createHash, timingSafeEqual } from 'crypto'
import { createServer } from 'net'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { SocketServer } from '../socket-server'
import { ScreenManager, isValidSessionId, type ResumeSpec } from '../screen-manager'
import type { PermissionRequest, TrustLevel } from '../types'
import type { TaskMonitor } from '../task-monitor'
import type { VetoController } from '../veto-controller'
import type { EscalationController } from '../escalation-controller'
import type { AutopilotRunner } from '../autopilot'
import type { ErrorLog } from '../error-log'
import type { Personalities, PersonalityInput } from '../personalities'
import type { Decisions } from '../decisions'
import type { Messages } from '../messages'
import { saveSessions } from '../config'
import { listPriorSessions } from '../claude-sessions'

const COOKIE_NAME = 'hub_session'
const COOKIE_MAX_AGE_SEC = 86400 // 24h

// Mini-JWT-ish token: `<b64url(payload)>.<hex(hmac)>`. Payload is a JSON
// { userId, issuedAt }. Secret is derived from the Telegram bot token so
// we don't need another config field.
export function signSession(userId: string, secret: string, now = Date.now()): string {
  const payload = JSON.stringify({ userId, issuedAt: now })
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(payloadB64).digest('hex')
  return `${payloadB64}.${mac}`
}

export function verifySession(
  token: string,
  secret: string,
  maxAgeSec = COOKIE_MAX_AGE_SEC,
  now = Date.now(),
): { userId: string } | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot < 1 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payloadB64).digest('hex')
  let match = false
  try {
    match =
      mac.length === expected.length &&
      timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    match = false
  }
  if (!match) return null
  let payload: { userId?: unknown; issuedAt?: unknown }
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload.userId !== 'string' || typeof payload.issuedAt !== 'number') return null
  if (now - payload.issuedAt > maxAgeSec * 1000) return null
  return { userId: payload.userId }
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const k = part.slice(0, eq).trim()
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

// Note: there is an inherent TOCTOU window between closing this probe server
// and opening the real Bun.serve. In practice this is safe in single-process
// test and daemon contexts.
async function pickEphemeralPort(hostname: string): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, hostname, () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') {
    throw new Error('failed to allocate an ephemeral port')
  }
  return address.port
}

// Sanitize a user-supplied filename so it cannot traverse out of the upload
// directory: strip any path components and anything outside [A-Za-z0-9._-].
export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  // Forbid leading dots that could create dotfiles in unexpected places,
  // but keep them embedded (so "foo.tar.gz" is fine).
  const stripped = base.replace(/^\.+/, '_')
  // If the result is empty or has no alphanumerics left (e.g. "..", "///"),
  // fall back to a generic name rather than letting a placeholder through.
  if (!stripped || !/[a-zA-Z0-9]/.test(stripped)) return 'file'
  return stripped
}

// Return the canonical path if `target` resolves inside `root`, else null.
// Both sides are resolved to absolute paths before comparing.
export function pathInsideRoot(target: string, root: string): string | null {
  const absRoot = resolve(root)
  const absTarget = resolve(target)
  const rel = relative(absRoot, absTarget)
  if (rel === '') return absTarget
  if (rel.startsWith('..') || rel.startsWith('/')) return null
  return absTarget
}

type WebFrontendDeps = {
  port: number
  host?: string
  browseRoot?: string
  registry: SessionRegistry
  router: MessageRouter | null
  permissions: PermissionEngine | null
  socketServer: SocketServer | null
  screenManager: ScreenManager | null
  telegramToken: string
  telegramBotUsername: string
  telegramAllowFrom: string[]
  taskMonitor: TaskMonitor | null
  vetoController?: VetoController
  escalationController?: EscalationController
  autopilotRunner?: AutopilotRunner
  errorLog?: ErrorLog
  personalities?: Personalities
  decisions?: Decisions
  messages?: Messages
  projectsRootOverride?: string  // test-only: override ~/.claude/projects root
}

export class WebFrontend {
  private deps: WebFrontendDeps
  private clients = new Set<import('bun').ServerWebSocket<unknown>>()
  private server: import('bun').Server<unknown> | null = null
  private _port: number

  constructor(deps: WebFrontendDeps) {
    this.deps = deps
    this._port = deps.port
  }

  get port(): number {
    return this._port
  }

  async start(): Promise<void> {
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'web-client.html')
    const html = readFileSync(htmlPath, 'utf8')
      .replace('__TELEGRAM_BOT_USERNAME__', this.deps.telegramBotUsername ?? '')

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const hostname = this.deps.host ?? '127.0.0.1'
    const port = this.deps.port === 0
      ? await pickEphemeralPort(hostname)
      : this.deps.port

    this.server = Bun.serve({
      port,
      // Default loopback — remote access must go through an authenticated
      // reverse proxy. Operators can override via config.webHost to bind to
      // a private bridge IP (e.g. 172.20.0.1) so a containerized proxy can
      // reach it. See README "Remote access".
      hostname,
      fetch(req, server) {
        const url = new URL(req.url)

        // Auth: anything under /api except the Telegram login endpoint
        // requires a valid hub_session cookie issued by handleTelegramAuth.
        // Same for WebSocket upgrades. Static assets (/, favicon) are public.
        const isAuthEndpoint = url.pathname === '/api/auth/telegram'
        const isStatic =
          url.pathname === '/' ||
          url.pathname === '/index.html' ||
          url.pathname === '/favicon.ico'
        const isWsUpgrade = url.pathname === '/ws'
        const requiresAuth = (url.pathname.startsWith('/api/') && !isAuthEndpoint) || isWsUpgrade
        if (requiresAuth) {
          const session = self.authenticate(req)
          if (!session) return new Response('Unauthorized', { status: 401 })
        }

        // WebSocket upgrade
        if (isWsUpgrade) {
          const upgraded = server.upgrade(req, { data: {} })
          if (upgraded) return undefined as unknown as Response
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Favicon — empty SVG to prevent 404
        if (url.pathname === '/favicon.ico') {
          return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">⚡</text></svg>', {
            headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' },
          })
        }

        // Serve HTML
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(html, {
            headers: {
              'Content-Type': 'text/html',
              'Cache-Control': 'no-store, must-revalidate',
            },
          })
        }

        // Telegram login verification
        if (isAuthEndpoint && req.method === 'POST') {
          return self.handleTelegramAuth(req)
        }

        // Browse directories — scoped to a configurable root (defaults to
        // $HOME) so an attacker (post-auth, so the allowlist holds) can't
        // enumerate /etc, /root, or sibling home directories. Operators
        // running the daemon as root with projects under /home can set
        // config.browseRoot to "/home" to widen the scope deliberately.
        if (url.pathname === '/api/browse' && req.method === 'GET') {
          const root = resolve(self.deps.browseRoot ?? homedir())
          const requested = url.searchParams.get('path') || root + '/'
          const scoped = pathInsideRoot(requested, root)
          if (!scoped) {
            return new Response('Path outside allowed root', { status: 403 })
          }
          let dirs: string[] = []
          try {
            const entries = readdirSync(scoped)
            dirs = entries
              .filter(e => {
                try { return statSync(join(scoped, e)).isDirectory() && !e.startsWith('.') } catch { return false }
              })
              .sort()
              .map(e => join(scoped, e) + '/')
          } catch {}
          return Response.json({ root: root + '/', dirs })
        }

        // API routes
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          return Response.json(self.listSessionsWithPersonality())
        }

        if (url.pathname === '/api/upload-temp' && req.method === 'POST') {
          return self.handleUploadTemp(req)
        }

        if (url.pathname === '/api/upload' && req.method === 'POST') {
          return self.handleUpload(req)
        }

        if (url.pathname === '/api/spawn' && req.method === 'POST') {
          return self.handleSpawn(req)
        }

        if (url.pathname === '/api/kill' && req.method === 'POST') {
          return self.handleKill(req)
        }

        if (url.pathname === '/api/remove' && req.method === 'POST') {
          return self.handleRemove(req)
        }

        if (url.pathname === '/api/send' && req.method === 'POST') {
          return self.handleSend(req)
        }

        if (url.pathname === '/api/trust' && req.method === 'POST') {
          return self.handleTrust(req)
        }

        if (url.pathname === '/api/prefix' && req.method === 'POST') {
          return self.handlePrefix(req)
        }

        if (url.pathname === '/api/rename' && req.method === 'POST') {
          return self.handleRename(req)
        }

        if (url.pathname === '/api/autopilot' && req.method === 'POST') {
          return self.handleAutopilot(req)
        }

        if (url.pathname === '/api/autopilot/veto' && req.method === 'POST') {
          return self.handleAutopilotVeto(req)
        }

        if (url.pathname === '/api/autopilot/escalate' && req.method === 'POST') {
          return self.handleAutopilotEscalate(req)
        }

        if (url.pathname === '/api/team/add' && req.method === 'POST') {
          return req.json().then(async (body: any) => {
            const newName = await self.deps.screenManager?.addTeammate(body.leadName)
            if (newName) {
              return Response.json({ ok: true, name: newName })
            }
            return new Response('Lead not found', { status: 404 })
          })
        }

        if (url.pathname === '/api/activity' && req.method === 'GET') {
          const activity = self.deps.permissions?.getActivity() ?? []
          return Response.json(activity)
        }

        if (url.pathname === '/api/errors' && req.method === 'GET') {
          const log = self.deps.errorLog
          if (!log) return Response.json([])
          const session = url.searchParams.get('session') ?? undefined
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 50, 500)) : 50
          return Response.json(log.recent({ session, limit }))
        }

        // Audit trail of successful autopilot answers.
        if (url.pathname === '/api/decisions' && req.method === 'GET') {
          const dec = self.deps.decisions
          if (!dec) return Response.json([])
          const session = url.searchParams.get('session') ?? undefined
          const personalityIdRaw = url.searchParams.get('personalityId')
          const personalityId = personalityIdRaw ? parseInt(personalityIdRaw, 10) : undefined
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 100, 1000)) : 100
          // Default ON: caller almost always wants the linked feedback rows
          // for surfacing in the History modal. Set ?feedback=0 to opt out.
          const withFeedback = url.searchParams.get('feedback') !== '0'
          return Response.json(dec.recent({
            session,
            personalityId: Number.isFinite(personalityId as number) ? personalityId : undefined,
            limit,
            withFeedback,
          }))
        }

        // === Personalities CRUD ============================================
        if (url.pathname === '/api/personalities' && req.method === 'GET') {
          const p = self.deps.personalities
          if (!p) return Response.json([])
          return Response.json(p.listAll())
        }
        if (url.pathname === '/api/personalities' && req.method === 'POST') {
          return self.handleCreatePersonality(req)
        }
        {
          const m = url.pathname.match(/^\/api\/personalities\/(\d+)$/)
          if (m) {
            const id = parseInt(m[1]!, 10)
            if (req.method === 'PATCH') return self.handleUpdatePersonality(req, id)
            if (req.method === 'DELETE') return self.handleDeletePersonality(id)
            if (req.method === 'GET') {
              const p = self.deps.personalities?.getById(id)
              return p ? Response.json(p) : new Response('Not found', { status: 404 })
            }
          }
        }
        // POST /api/sessions/:name/personality  body: { personalityId: N | null }
        {
          const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/personality$/)
          if (m && req.method === 'POST') {
            return self.handleAssignPersonality(req, decodeURIComponent(m[1]!))
          }
        }

        // GET /api/sessions/:name/messages — replay history on dashboard
        // refresh. Returns rows newest-first; the client reverses for display.
        {
          const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
          if (m && req.method === 'GET') {
            const dao = self.deps.messages
            if (!dao) return Response.json([])
            const limitRaw = url.searchParams.get('limit')
            const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 200, 1000)) : 200
            return Response.json(dao.recent({ session: decodeURIComponent(m[1]!), limit }))
          }
        }

        if (url.pathname === '/api/session/rules' && req.method === 'POST') {
          return self.handleRules(req)
        }

        if (url.pathname === '/api/session/facts' && req.method === 'POST') {
          return self.handleFacts(req)
        }

        {
          const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prior$/)
          if (m && req.method === 'GET') {
            return self.handlePriorSessions(decodeURIComponent(m[1]))
          }
        }

        // GET /api/peek/:name — capture the live tmux pane (incl. scrollback)
        // so the dashboard can show what's actually on Claude's screen, not
        // just what's been relayed through the MCP channel.
        {
          const m = url.pathname.match(/^\/api\/peek\/([^/]+)$/)
          if (m && req.method === 'GET') {
            return self.handlePeek(decodeURIComponent(m[1]!), url.searchParams.get('lines'))
          }
        }

        return new Response('Not Found', { status: 404 })
      },
      websocket: {
        open(ws) {
          self.clients.add(ws)
          ws.send(JSON.stringify({ type: 'sessions', data: self.listSessionsWithPersonality() }))
        },
        message(ws, data) {
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString())
            self.handleWsMessage(ws, msg)
          } catch (e) {
            console.error('WS message parse error', e)
          }
        },
        close(ws) {
          self.clients.delete(ws)
        },
      },
    })

    this._port = this.server.port ?? this.deps.port
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true)
      this.server = null
    }
  }

  broadcastToClients(msg: unknown): void {
    const text = JSON.stringify(msg)
    for (const ws of this.clients) {
      ws.send(text)
    }
  }

  deliverToUser(sessionName: string, text: string, files?: string[]): void {
    // Persist before broadcast so a hard refresh can replay the chat.
    try {
      this.deps.messages?.record({
        ts: Date.now(),
        sessionName,
        role: 'claude',
        text,
        files,
      })
    } catch (err) {
      process.stderr.write(`web: messages.record (claude) failed: ${err}\n`)
    }
    this.broadcastToClients({ type: 'message', sessionName, text, files })
  }

  deliverPermissionRequest(req: PermissionRequest): void {
    this.broadcastToClients({ type: 'permission', ...req })
  }

  // Decorate each session with its assigned personality (if any) so the
  // sidebar can render the badge / dropdown without an extra round-trip.
  private listSessionsWithPersonality(): unknown[] {
    const sessions = this.deps.registry.list()
    const p = this.deps.personalities
    if (!p) return sessions
    return sessions.map((s: any) => {
      const personality = p.getForSession(s.path)
      if (!personality) return s
      return {
        ...s,
        personalityId: personality.id,
        personalityName: personality.name,
      }
    })
  }

  refreshSessions(): void {
    this.broadcastToClients({ type: 'sessions', data: this.listSessionsWithPersonality() })
  }

  deliverTaskUpdate(tasks: Record<string, any[]>): void {
    this.broadcastToClients({ type: 'tasks', data: tasks })
  }

  deliverAutopilotDraft(path: string, sessionName: string, draft: string, vetoMs: number): void {
    this.broadcastToClients({
      type: 'autopilot:draft',
      path,
      sessionName,
      draft,
      expiresAt: Date.now() + vetoMs,
    })
  }

  deliverAutopilotEscalation(
    path: string,
    sessionName: string,
    rawQuestion: string,
    reason: string,
    reasonKind: 'risk' | 'escalate_token' | 'parse_error' | 'timeout' | 'other',
  ): void {
    this.broadcastToClients({
      type: 'autopilot:escalate',
      path,
      sessionName,
      rawQuestion,
      reason,
      reasonKind,
    })
  }

  private handleWsMessage(ws: import('bun').ServerWebSocket<unknown>, msg: Record<string, unknown>): void {
    if (msg.type === 'message') {
      const { text, sessionName } = msg as { text: string; sessionName: string }
      if (this.deps.router && text && sessionName) {
        try {
          this.deps.messages?.record({
            ts: Date.now(),
            sessionName,
            role: 'user',
            text,
          })
        } catch (err) {
          process.stderr.write(`web: messages.record (user/ws) failed: ${err}\n`)
        }
        this.deps.router.routeToSession(sessionName, text, 'web', 'web-user')
      }
    } else if (msg.type === 'spawn') {
      const { name, path, teamSize, instructions } = msg as { name: string; path: string; teamSize?: number; instructions?: string }
      if (this.deps.screenManager && name && path) {
        const size = teamSize ?? 1
        if (size > 1) {
          this.deps.screenManager.spawnTeam(name, path, size, instructions).catch(console.error)
        } else {
          this.deps.screenManager.spawn(name, path, instructions).catch(console.error)
        }
      }
    } else if (msg.type === 'permission_response') {
      const { requestId, behavior, option } = msg as { requestId: string; behavior: 'allow' | 'deny'; option?: number }
      if (requestId && behavior) {
        if (this.deps.permissions) {
          const result = this.deps.permissions.resolve(requestId, behavior)
          if (result && this.deps.socketServer) {
            this.deps.socketServer.sendToSession(result.sessionPath, {
              type: 'permission_response',
              requestId: result.response.requestId,
              behavior: result.response.behavior,
            })
          }
        }
      }
    }
  }

  private async handleUploadTemp(req: Request): Promise<Response> {
    try {
      const form = await req.formData()
      const file = form.get('file') as File | null
      if (!file) return new Response('Missing file', { status: 400 })

      const { mkdirSync, writeFileSync } = await import('fs')
      const tmpDir = join('/tmp', 'hub-uploads')
      mkdirSync(tmpDir, { recursive: true })
      const safeName = sanitizeFilename(file.name)
      const destPath = join(tmpDir, `${Date.now()}-${safeName}`)
      writeFileSync(destPath, Buffer.from(await file.arrayBuffer()))

      return Response.json({ path: destPath, name: safeName })
    } catch (err) {
      return new Response('Upload failed', { status: 500 })
    }
  }

  // Returns the authenticated user id if the request has a valid session
  // cookie AND that user is still in the allowlist. Null otherwise.
  private authenticate(req: Request): { userId: string } | null {
    if (!this.deps.telegramToken) return null
    if (this.deps.telegramAllowFrom.length === 0) return null
    const token = parseCookie(req.headers.get('cookie'), COOKIE_NAME)
    if (!token) return null
    const verified = verifySession(token, this.deps.telegramToken)
    if (!verified) return null
    if (!this.deps.telegramAllowFrom.includes(verified.userId)) return null
    return verified
  }

  private async handleTelegramAuth(req: Request): Promise<Response> {
    try {
      const data = await req.json() as Record<string, any>
      const { hash, ...userData } = data

      if (!hash || !this.deps.telegramToken) {
        return new Response('Missing auth data', { status: 400 })
      }

      // Verify Telegram hash: https://core.telegram.org/widgets/login#checking-authorization
      const secretKey = createHash('sha256').update(this.deps.telegramToken).digest()
      const checkString = Object.keys(userData)
        .sort()
        .map(k => `${k}=${userData[k]}`)
        .join('\n')
      const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex')

      // Constant-time compare — length-mismatch throws, which we treat as invalid.
      let hashMatches = false
      try {
        hashMatches =
          hmac.length === hash.length &&
          timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(hash, 'hex'))
      } catch {
        hashMatches = false
      }
      if (!hashMatches) {
        return new Response('Invalid auth hash', { status: 403 })
      }

      // Check auth_date is not too old (allow 1 day)
      const authDate = Number(userData.auth_date)
      if (Date.now() / 1000 - authDate > 86400) {
        return new Response('Auth expired', { status: 403 })
      }

      // Check if user is in allowFrom list. Empty list is DENY ALL — the
      // previous "allow everyone" behaviour was a misconfiguration footgun.
      const userId = String(userData.id)
      if (this.deps.telegramAllowFrom.length === 0) {
        return new Response(
          'Web auth disabled: telegramAllowFrom is empty in config.json',
          { status: 403 },
        )
      }
      if (!this.deps.telegramAllowFrom.includes(userId)) {
        return new Response('User not authorized', { status: 403 })
      }

      // Issue session cookie — HttpOnly so JS can't read it, SameSite=Strict
      // so a malicious site can't POST to /api/* with this user's credentials.
      const cookie = signSession(userId, this.deps.telegramToken)
      const cookieHeader =
        `${COOKIE_NAME}=${cookie}; Max-Age=${COOKIE_MAX_AGE_SEC}; Path=/; ` +
        `HttpOnly; SameSite=Strict`
      return new Response(JSON.stringify({ ok: true, user: userData }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieHeader,
        },
      })
    } catch (err) {
      return new Response('Auth failed', { status: 500 })
    }
  }

  private async handleUpload(req: Request): Promise<Response> {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      const sessionName = formData.get('sessionName') as string | null

      if (!file || !sessionName) {
        return new Response('Missing file or sessionName', { status: 400 })
      }

      const path = this.deps.registry.findByName(sessionName)
      if (!path) {
        return new Response(`Session not found: ${sessionName}`, { status: 404 })
      }

      const session = this.deps.registry.get(path)!
      // Resolve uploadDir against the session's project root so a relative
      // uploadDir like "." lands in the project, not the daemon's cwd. Then
      // sanitize the filename and confirm the final path stays inside the
      // project root (defense against traversal via a crafted uploadDir).
      const projectRoot = this.deps.registry.folderPath(session.path)
      const dir = resolve(projectRoot, session.uploadDir)
      const safeName = sanitizeFilename(file.name)
      const savePath = pathInsideRoot(join(dir, safeName), projectRoot)
      if (!savePath) {
        return new Response('Refusing to write outside project root', { status: 400 })
      }
      const buffer = await file.arrayBuffer()
      await writeFile(savePath, new Uint8Array(buffer))

      if (this.deps.router) {
        this.deps.router.routeToSession(
          sessionName,
          `[File uploaded: ${savePath}]`,
          'web',
          'web-user',
        )
      }

      return Response.json({ path: savePath })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleSpawn(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        name: string
        path: string
        teamSize?: number
        instructions?: string
        resume?: 'continue' | { sessionId: string }
      }
      const { name, path, teamSize, instructions, resume } = body
      if (!this.deps.screenManager) return new Response('No screen manager', { status: 503 })

      let resumeSpec: ResumeSpec | undefined
      if (resume === 'continue') {
        resumeSpec = { mode: 'continue' }
      } else if (resume && typeof resume === 'object' && typeof resume.sessionId === 'string') {
        if (!isValidSessionId(resume.sessionId)) {
          return new Response('Invalid session id', { status: 400 })
        }
        resumeSpec = { mode: 'session', id: resume.sessionId }
      }

      const size = teamSize ?? 1
      if (size > 1) {
        if (resumeSpec) return new Response('Resume not supported with teamSize > 1', { status: 400 })
        this.deps.screenManager.spawnTeam(name, path, size, instructions).catch(err => {
          process.stderr.write(`hub: spawnTeam error: ${err}\n`)
        })
      } else {
        await this.deps.screenManager.spawn(name, path, instructions, undefined, resumeSpec)
      }
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleKill(req: Request): Promise<Response> {
    try {
      const { name } = (await req.json()) as { name: string }
      const isManaged = this.deps.screenManager?.isManaged(name) ?? false

      // Either path: send Ctrl-C + `/exit` to the tmux session so Claude
      // actually exits. The new gracefulKill handles the unmanaged case
      // (assumes tmux is `hub-<name>`) so the user's "Close session" click
      // really does close it, not just unhook the daemon socket.
      await this.deps.screenManager?.gracefulKill(name)

      // For unmanaged sessions, also drop from the registry — the user clearly
      // wants this gone and there is no respawn machinery to bring it back.
      if (!isManaged) {
        const path = this.deps.registry.findByName(name)
        if (path) {
          this.deps.socketServer?.disconnectSession(path)
          this.deps.registry.unregister(path)
        }
      }
      this.refreshSessions()
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleRemove(req: Request): Promise<Response> {
    try {
      const { name } = (await req.json()) as { name: string }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      const state = this.deps.registry.get(path)
      if (state && state.status !== 'disconnected') {
        return new Response('Session is still connected — use close instead', { status: 409 })
      }
      this.deps.screenManager?.forgetManaged(name)
      this.deps.socketServer?.disconnectSession(path)
      this.deps.registry.unregister(path)
      saveSessions(this.deps.registry.toSaveFormat())
      this.refreshSessions()
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleSend(req: Request): Promise<Response> {
    try {
      const { sessionName, text } = (await req.json()) as { sessionName: string; text: string }
      if (!this.deps.router) return new Response('No router', { status: 503 })
      try {
        this.deps.messages?.record({
          ts: Date.now(),
          sessionName,
          role: 'user',
          text,
        })
      } catch (err) {
        process.stderr.write(`web: messages.record (user/api) failed: ${err}\n`)
      }
      this.deps.router.routeToSession(sessionName, text, 'web', 'web-user')
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleTrust(req: Request): Promise<Response> {
    try {
      const { name, level } = (await req.json()) as { name: string; level: string }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setTrust(path, level as TrustLevel)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handlePrefix(req: Request): Promise<Response> {
    try {
      const { name, text } = (await req.json()) as { name: string; text: string }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setPrefix(path, text)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleCreatePersonality(req: Request): Promise<Response> {
    const p = this.deps.personalities
    if (!p) return new Response('Personalities not available', { status: 503 })
    try {
      const body = (await req.json()) as PersonalityInput
      if (!body?.name?.trim() || !body?.systemPrompt?.trim()) {
        return new Response('name and systemPrompt are required', { status: 400 })
      }
      const created = p.create(body)
      return Response.json(created, { status: 201 })
    } catch (err) {
      // UNIQUE constraint on name surfaces here as a normal Error.
      const msg = String(err)
      const status = /UNIQUE/i.test(msg) ? 409 : 400
      return new Response(msg, { status })
    }
  }

  private async handleUpdatePersonality(req: Request, id: number): Promise<Response> {
    const p = this.deps.personalities
    if (!p) return new Response('Personalities not available', { status: 503 })
    try {
      const body = (await req.json()) as Partial<PersonalityInput>
      // Strip fields the API must not let clients change.
      delete (body as any).builtin
      delete (body as any).id
      delete (body as any).createdAt
      delete (body as any).updatedAt
      const updated = p.update(id, body)
      return Response.json(updated)
    } catch (err) {
      const msg = String(err)
      const status = /No personality/i.test(msg) ? 404 : 400
      return new Response(msg, { status })
    }
  }

  private async handleDeletePersonality(id: number): Promise<Response> {
    const p = this.deps.personalities
    if (!p) return new Response('Personalities not available', { status: 503 })
    try {
      p.deleteById(id)
      return new Response(null, { status: 204 })
    } catch (err) {
      const msg = String(err)
      // Built-in personalities can't be deleted.
      const status = /built-in/i.test(msg) ? 403 : 400
      return new Response(msg, { status })
    }
  }

  private async handleAssignPersonality(req: Request, name: string): Promise<Response> {
    const p = this.deps.personalities
    if (!p) return new Response('Personalities not available', { status: 503 })
    const path = this.deps.registry.findByName(name)
    if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
    try {
      const body = (await req.json()) as { personalityId: number | null }
      if (body.personalityId === null) {
        p.removeFromSession(path)
      } else if (typeof body.personalityId === 'number') {
        if (!p.getById(body.personalityId)) {
          return new Response('No such personality', { status: 404 })
        }
        p.assignToSession(path, body.personalityId)
      } else {
        return new Response('personalityId must be a number or null', { status: 400 })
      }
      this.refreshSessions()
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 400 })
    }
  }

  private async handleRules(req: Request): Promise<Response> {
    try {
      const { name, rules } = (await req.json()) as { name: string; rules: string[] }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setRules(path, rules)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleFacts(req: Request): Promise<Response> {
    try {
      const { name, facts } = (await req.json()) as { name: string; facts: string[] }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setFacts(path, facts)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleRename(req: Request): Promise<Response> {
    try {
      const { oldName, newName } = (await req.json()) as { oldName: string; newName: string }
      const path = this.deps.registry.findByName(oldName)
      if (!path) return new Response(`Session not found: ${oldName}`, { status: 404 })
      this.deps.registry.rename(path, newName)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleAutopilot(req: Request): Promise<Response> {
    try {
      const { name, enabled } = (await req.json()) as { name: string; enabled: boolean }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      if (enabled) {
        const runner = this.deps.autopilotRunner
        const managed = this.deps.screenManager?.getManagedByPath(this.deps.registry.folderPath(path))
        const tmuxName = managed?.sessionName ?? `hub-${name}`
        if (runner) {
          // Synchronous fast check — pane state only, no /btw round-trip.
          const quick = await runner.quickProbe(tmuxName)
          if (!quick.ok) {
            return Response.json({ ok: false, reason: quick.reason }, { status: 400 })
          }
        }
        const existing = this.deps.registry.getAutopilot(path)
        const current = this.deps.registry.get(path)
        const prior = current?.trust
        // Preserve the original priorTrust if this is a re-enable while already on.
        const priorTrust = existing?.priorTrust ?? prior
        this.deps.registry.setTrust(path, 'auto')
        this.deps.registry.setAutopilot(path, {
          ...existing,
          enabled: true,
          priorTrust,
          startedAt: existing?.startedAt ?? Date.now(),
        })
        saveSessions(this.deps.registry.toSaveFormat())
        // Background /btw confirmation — fire and forget. The toggle has already
        // returned 200 to the caller; if /btw fails we deliver a notice so the
        // user can decide whether to keep autopilot on.
        if (runner) {
          runner.probe(tmuxName, 20_000).then(res => {
            if (!res.ok) {
              this.deliverToUser(name, `⚠️ Autopilot enabled but /btw confirmation failed: ${res.reason}`)
            } else {
              this.deliverToUser(name, `✅ Autopilot ready — /btw confirmed reachable.`)
            }
          }).catch(err => {
            process.stderr.write(`hub: autopilot bg probe error for ${name}: ${err}\n`)
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
      this.refreshSessions()
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleAutopilotVeto(req: Request): Promise<Response> {
    try {
      const { name, action, edited, reason } = (await req.json()) as {
        name: string
        action: 'send' | 'edit' | 'cancel'
        edited?: string
        reason?: string         // user's free-text "why" — captured for cancel/edit
      }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })

      const vc = this.deps.vetoController
      if (!vc) return new Response('Veto controller not available', { status: 503 })

      const pending = vc.cancel(path)
      if (!pending) {
        return Response.json({ ok: false, reason: 'no pending' }, { status: 404 })
      }

      if (action === 'send') {
        this.deps.socketServer?.sendToSession(path, {
          type: 'channel_message',
          content: pending.draft,
          meta: { source: 'autopilot', frontend: 'web' },
        })
      } else if (action === 'edit' && edited && edited.trim()) {
        this.deps.socketServer?.sendToSession(path, {
          type: 'channel_message',
          content: edited,
          meta: { source: 'autopilot', frontend: 'web' },
        })
      }
      // action === 'cancel': no injection, just drop the draft

      // Capture feedback against the original decision row when the user
      // overrode or rejected the autopilot's draft. Send carries no
      // feedback — the silent "yes" doesn't tell us anything.
      if ((action === 'cancel' || action === 'edit') && pending.decisionId !== undefined) {
        try {
          this.deps.decisions?.recordFeedback(pending.decisionId, {
            ts: Date.now(),
            action,
            reason: reason?.trim() || undefined,
            editedAnswer: action === 'edit' ? edited : undefined,
          })
        } catch (err) {
          process.stderr.write(`hub: decisions.recordFeedback failed: ${err}\n`)
        }
      }

      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleAutopilotEscalate(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        name: string
        action: 'proceed' | 'answer' | 'dismiss'
        text?: string
      }
      const path = this.deps.registry.findByName(body.name)
      if (!path) return new Response(`Session not found: ${body.name}`, { status: 404 })

      const ec = this.deps.escalationController
      if (!ec) return new Response('Escalation controller not available', { status: 503 })

      const pending = ec.clear(path)
      if (!pending) return Response.json({ ok: false, reason: 'no pending' }, { status: 404 })

      if (body.action === 'dismiss') {
        return Response.json({ ok: true })
      }

      if (body.action === 'answer') {
        const text = (body.text ?? '').trim()
        if (!text) return Response.json({ ok: false, reason: 'empty answer' }, { status: 400 })
        // Route the user's answer through the normal message path — same as
        // typing in the web chat input. Persist for history first.
        try {
          this.deps.messages?.record({
            ts: Date.now(),
            sessionName: body.name,
            role: 'user',
            text,
          })
        } catch (err) {
          process.stderr.write(`web: messages.record (user/escalate) failed: ${err}\n`)
        }
        this.deps.router?.routeToSession(body.name, text, 'web', 'web-user')
        return Response.json({ ok: true })
      }

      // action === 'proceed': re-run /btw for the same wrapped question, this
      // time with the risk filter bypassed. Reuse the main autopilot-answer
      // handling via the injection code path.
      const runner = this.deps.autopilotRunner
      if (!runner) return new Response('Autopilot runner not available', { status: 503 })

      const retryT0 = Date.now()
      runner.runBtw(pending.tmuxName, pending.wrappedQuestion, {
        rawQuestion: pending.rawQuestion,
        riskKeywords: [],       // explicitly empty
        riskOverride: true,     // bypass pre-fire check
      }).then(result => {
        if (result.status === 'answered') {
          this.deps.socketServer?.sendToSession(path, {
            type: 'channel_message',
            content: result.answer,
            meta: { source: 'autopilot', frontend: 'web' },
          })
          this.deliverToUser(pending.sessionName, `🤖 Autopilot answered (risk override): ${result.answer}`)
        } else {
          // Log the retry failure so the user can inspect the captured pane
          // and diagnose why /btw still couldn't answer.
          this.deps.errorLog?.record({
            ts: Date.now(),
            sessionName: pending.sessionName,
            sessionPath: path,
            status: result.status === 'escalate' ? 'escalate' : result.status,
            reason: `retry-${result.status}` + (result.status === 'escalate' ? `: ${result.reason}` : ''),
            rawQuestion: pending.rawQuestion,
            wrappedQuestion: pending.wrappedQuestion,
            capturedPane: result.pane,
            durationMs: Date.now() - retryT0,
          })
          this.deliverToUser(pending.sessionName, `🟡 Autopilot still can't answer (${result.status}). Type a reply.`)
        }
      }).catch(err => process.stderr.write(`hub: escalate-proceed failed: ${err}\n`))

      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handlePriorSessions(name: string): Promise<Response> {
    const path = this.deps.registry.findByName(name)
    if (!path) return new Response('Session not found', { status: 404 })
    const projectPath = path.replace(/:\d+$/, '')
    try {
      const sessions = await listPriorSessions(projectPath, {
        rootOverride: this.deps.projectsRootOverride,
      })
      return Response.json({ sessions })
    } catch (err) {
      process.stderr.write(`hub: /api/sessions/${name}/prior error: ${err}\n`)
      return Response.json({ sessions: [], error: 'read-failed' }, { status: 200 })
    }
  }

  private async handlePeek(name: string, linesRaw: string | null): Promise<Response> {
    if (!this.deps.screenManager) {
      return Response.json({ error: 'screen manager unavailable' }, { status: 503 })
    }
    const lines = linesRaw && /^\d+$/.test(linesRaw)
      ? Math.max(1, Math.min(parseInt(linesRaw, 10), 500))
      : 80
    const path = this.deps.registry.findByName(name)
    const managed = path ? this.deps.screenManager.getManagedByPath(this.deps.registry.folderPath(path)) : undefined
    const tmuxName = managed?.sessionName ?? `hub-${name}`
    try {
      const pane = await this.deps.screenManager.capturePaneWithScrollback(tmuxName, lines)
      return Response.json({ name, lines, pane })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // tmux-not-found errors come from capturePaneWithScrollback's pre-check.
      const status = /No tmux session/.test(msg) ? 404 : 500
      return Response.json({ error: msg, name }, { status })
    }
  }
}
