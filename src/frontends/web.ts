// src/frontends/web.ts
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, resolve, basename, relative } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { writeFile } from 'fs/promises'
import { createHmac, createHash, timingSafeEqual } from 'crypto'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { SocketServer } from '../socket-server'
import { ScreenManager, isValidSessionId, type ResumeSpec } from '../screen-manager'
import type { PermissionRequest, TrustLevel } from '../types'
import type { TaskMonitor } from '../task-monitor'
import type { VetoController } from '../veto-controller'
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

    this.server = Bun.serve({
      port: this.deps.port,
      // Default loopback — remote access must go through an authenticated
      // reverse proxy. Operators can override via config.webHost to bind to
      // a private bridge IP (e.g. 172.20.0.1) so a containerized proxy can
      // reach it. See README "Remote access".
      hostname: this.deps.host ?? '127.0.0.1',
      fetch(req, server) {
        const url = new URL(req.url)

        // Auth: anything under /api except the Telegram login endpoint requires
        // a valid hub_session cookie issued by handleTelegramAuth. Same for
        // WebSocket upgrades. Static assets (/, favicon) are public.
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
          const sessions = self.deps.registry.list()
          return Response.json(sessions)
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

        return new Response('Not Found', { status: 404 })
      },
      websocket: {
        open(ws) {
          self.clients.add(ws)
          const sessions = self.deps.registry.list()
          ws.send(JSON.stringify({ type: 'sessions', data: sessions }))
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
    this.broadcastToClients({ type: 'message', sessionName, text, files })
  }

  deliverPermissionRequest(req: PermissionRequest): void {
    this.broadcastToClients({ type: 'permission', ...req })
  }

  refreshSessions(): void {
    const sessions = this.deps.registry.list()
    this.broadcastToClients({ type: 'sessions', data: sessions })
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

  private handleWsMessage(ws: import('bun').ServerWebSocket<unknown>, msg: Record<string, unknown>): void {
    if (msg.type === 'message') {
      const { text, sessionName } = msg as { text: string; sessionName: string }
      if (this.deps.router && text && sessionName) {
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
      if (this.deps.screenManager?.isManaged(name)) {
        await this.deps.screenManager.gracefulKill(name)
      } else {
        // Unmanaged session (Claude started outside hub) — disconnect socket and drop from registry.
        const path = this.deps.registry.findByName(name)
        if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
        this.deps.socketServer?.disconnectSession(path)
        this.deps.registry.unregister(path)
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
      const existing = this.deps.registry.getAutopilot(path) ?? {}
      this.deps.registry.setAutopilot(path, { ...existing, enabled })
      this.refreshSessions()
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleAutopilotVeto(req: Request): Promise<Response> {
    try {
      const { name, action, edited } = (await req.json()) as {
        name: string
        action: 'send' | 'edit' | 'cancel'
        edited?: string
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
}
