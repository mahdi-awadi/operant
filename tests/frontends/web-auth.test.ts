// tests/frontends/web-auth.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash, createHmac } from 'crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  WebFrontend,
  signSession,
  verifySession,
  sanitizeFilename,
  pathInsideRoot,
} from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'
import { ScreenManager } from '../../src/screen-manager'

const TOKEN = 'test-bot-token-abc123'
const ALLOWED = '123'
const OTHER = '999'

function buildTelegramAuthBody(userId: string, authDate: number, token = TOKEN): Record<string, string | number> {
  const userData: Record<string, string | number> = {
    id: userId,
    first_name: 'Test',
    auth_date: authDate,
  }
  const secretKey = createHash('sha256').update(token).digest()
  const checkString = Object.keys(userData)
    .sort()
    .map(k => `${k}=${userData[k]}`)
    .join('\n')
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex')
  return { ...userData, hash }
}

function authCookie(userId = ALLOWED): string {
  return `operant_session=${signSession(userId, TOKEN)}`
}

describe('signSession / verifySession', () => {
  test('round-trips a valid token', () => {
    const token = signSession(ALLOWED, TOKEN, 1_000_000)
    expect(verifySession(token, TOKEN, 3600, 1_000_000)).toEqual({ userId: ALLOWED })
  })

  test('rejects wrong secret', () => {
    const token = signSession(ALLOWED, TOKEN)
    expect(verifySession(token, 'different-secret')).toBeNull()
  })

  test('rejects tampered payload', () => {
    const token = signSession(ALLOWED, TOKEN)
    const [payload, mac] = token.split('.')
    const tampered = Buffer.from(JSON.stringify({ userId: 'attacker', issuedAt: Date.now() })).toString('base64url')
    expect(verifySession(`${tampered}.${mac}`, TOKEN)).toBeNull()
  })

  test('rejects expired tokens', () => {
    const issuedAt = 1_000_000
    const token = signSession(ALLOWED, TOKEN, issuedAt)
    // maxAge 3600s; now is 2 hours later
    expect(verifySession(token, TOKEN, 3600, issuedAt + 2 * 3600 * 1000)).toBeNull()
  })

  test('rejects garbage input', () => {
    expect(verifySession('', TOKEN)).toBeNull()
    expect(verifySession('not-a-token', TOKEN)).toBeNull()
    expect(verifySession('a.b.c', TOKEN)).toBeNull()
  })
})

describe('sanitizeFilename', () => {
  test('strips path components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('/abs/path/file.txt')).toBe('file.txt')
  })

  test('replaces unsafe chars with underscore', () => {
    expect(sanitizeFilename('foo bar.txt')).toBe('foo_bar.txt')
    expect(sanitizeFilename('rm -rf.sh')).toBe('rm_-rf.sh')
    expect(sanitizeFilename('a;b|c.md')).toBe('a_b_c.md')
  })

  test('rejects leading dots', () => {
    expect(sanitizeFilename('.bashrc')).toBe('_bashrc')
    expect(sanitizeFilename('...hidden')).toBe('_hidden')
  })

  test('preserves inner dots', () => {
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive.tar.gz')
  })

  test('never returns empty', () => {
    expect(sanitizeFilename('///')).toBe('file')
    expect(sanitizeFilename('..')).toBe('file')
  })
})

describe('pathInsideRoot', () => {
  test('accepts paths inside root', () => {
    expect(pathInsideRoot('/home/u/proj/file', '/home/u/proj')).toBe('/home/u/proj/file')
  })

  test('rejects parent traversal', () => {
    expect(pathInsideRoot('/home/u/proj/../other/file', '/home/u/proj')).toBeNull()
  })

  test('rejects sibling directories', () => {
    expect(pathInsideRoot('/home/u/other/file', '/home/u/proj')).toBeNull()
  })

  test('accepts root itself', () => {
    expect(pathInsideRoot('/home/u/proj', '/home/u/proj')).toBe('/home/u/proj')
  })
})

describe('POST /api/auth/telegram', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('accepts correct HMAC and issues Set-Cookie', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(ALLOWED, authDate)),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('operant_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Max-Age=86400')
  })

  test('rejects wrong hash with 403', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const body = buildTelegramAuthBody(ALLOWED, authDate)
    body.hash = 'deadbeef'.repeat(8)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(403)
  })

  test('rejects expired auth_date with 403', async () => {
    const expired = Math.floor(Date.now() / 1000) - 86401
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(ALLOWED, expired)),
    })
    expect(res.status).toBe(403)
  })

  test('rejects user not in allowFrom with 403', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(OTHER, authDate)),
    })
    expect(res.status).toBe(403)
  })

  test('empty allowFrom blocks auth entirely', async () => {
    await web.stop()
    const web2 = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [],
      taskMonitor: null,
    })
    await web2.start()
    try {
      const authDate = Math.floor(Date.now() / 1000)
      const res = await fetch(`http://localhost:${web2.port}/api/auth/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTelegramAuthBody(ALLOWED, authDate)),
      })
      expect(res.status).toBe(403)
    } finally {
      await web2.stop()
    }
  })

  test('missing hash returns 400', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ALLOWED }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/remove', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: { disconnectSession: () => {} } as any,
      screenManager: { forgetManaged: () => {} } as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('removes a disconnected session from the registry', async () => {
    const path = '/home/u/proj'
    registry.register(path)
    registry.disconnect(path)
    expect(registry.get(path)?.status).toBe('disconnected')

    const res = await fetch(`http://localhost:${web.port}/api/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ name: registry.list()[0]!.name }),
    })
    expect(res.status).toBe(200)
    expect(registry.get(path)).toBeUndefined()
  })

  test('refuses to remove an active session with 409', async () => {
    const path = '/home/u/proj'
    registry.register(path)
    expect(registry.get(path)?.status).toBe('active')

    const res = await fetch(`http://localhost:${web.port}/api/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ name: registry.list()[0]!.name }),
    })
    expect(res.status).toBe(409)
    // Session still registered
    expect(registry.get(path)).toBeDefined()
  })

  test('returns 404 for an unknown session name', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ name: 'does-not-exist' }),
    })
    expect(res.status).toBe(404)
  })

  test('requires auth cookie', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'anything' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/browse', () => {
  let web: WebFrontend
  let registry: SessionRegistry
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'operant-browse-'))
    mkdirSync(join(tmpRoot, 'alpha'))
    mkdirSync(join(tmpRoot, 'beta'))
    mkdirSync(join(tmpRoot, '.hidden'))

    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      browseRoot: tmpRoot,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('lists subdirectories under the configured browseRoot', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/browse?path=${encodeURIComponent(tmpRoot)}`, {
      headers: { cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.root).toBe(tmpRoot + '/')
    expect(data.dirs).toContain(join(tmpRoot, 'alpha') + '/')
    expect(data.dirs).toContain(join(tmpRoot, 'beta') + '/')
    // Hidden dirs are filtered
    expect(data.dirs.some((d: string) => d.includes('.hidden'))).toBe(false)
  })

  test('missing path param echoes the configured root', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/browse`, {
      headers: { cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.root).toBe(tmpRoot + '/')
    expect(data.dirs.length).toBeGreaterThan(0)
  })

  test('rejects paths outside browseRoot with 403', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/browse?path=${encodeURIComponent('/etc')}`, {
      headers: { cookie: authCookie() },
    })
    expect(res.status).toBe(403)
  })

  test('rejects traversal attempts with 403', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/browse?path=${encodeURIComponent(tmpRoot + '/../../etc')}`, {
      headers: { cookie: authCookie() },
    })
    expect(res.status).toBe(403)
  })

  test('requires auth cookie', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/browse?path=${encodeURIComponent(tmpRoot)}`)
    expect(res.status).toBe(401)
  })
})

describe('API auth middleware', () => {
  let web: WebFrontend

  beforeEach(async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/sessions without cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`)
    expect(res.status).toBe(401)
  })

  test('GET /api/sessions with valid cookie → 200', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
  })

  test('GET /api/sessions with tampered cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: 'operant_session=garbage.token' },
    })
    expect(res.status).toBe(401)
  })

  test('cookie for non-allowlisted user → 401', async () => {
    // Forge a valid-signature cookie for OTHER (who is not in allowFrom).
    const cookie = `operant_session=${signSession(OTHER, TOKEN)}`
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(401)
  })

  test('GET / (static) serves without auth', async () => {
    const res = await fetch(`http://localhost:${web.port}/`)
    expect(res.status).toBe(200)
  })

  test('WebSocket upgrade without cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/sessions/:name/prior', () => {
  let web: WebFrontend
  let tmpProjectsRoot: string
  let registry: SessionRegistry

  beforeEach(async () => {
    tmpProjectsRoot = mkdtempSync(join(tmpdir(), 'web-prior-'))
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    // Register a session at a real-looking cwd. The registry key will be `${cwd}:0`.
    const projectCwd = join(tmpProjectsRoot, 'project')
    mkdirSync(projectCwd, { recursive: true })
    registry.register(`${projectCwd}:0`, { name: 'alpha' })

    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
      projectsRootOverride: tmpProjectsRoot,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
    rmSync(tmpProjectsRoot, { recursive: true, force: true })
  })

  test('requires auth', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions/alpha/prior`)
    expect(res.status).toBe(401)
  })

  test('returns 404 for unknown session', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions/ghost/prior`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(404)
  })

  test('returns empty list when project has no prior sessions', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions/alpha/prior`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })

  test('returns sessions newest-first with first message preview', async () => {
    // The project cwd stored in the registry is `${tmpProjectsRoot}/project`.
    // Claude would store that cwd's sessions at `${tmpProjectsRoot}/-<tmpProjectsRoot>-project/`.
    // Since the override root is `tmpProjectsRoot`, the storage dir is:
    //   join(tmpProjectsRoot, encodeProjectPath(`${tmpProjectsRoot}/project`))
    // Compute it the same way listPriorSessions does.
    const projectCwd = join(tmpProjectsRoot, 'project')
    const encoded = projectCwd.replace(/\//g, '-')
    const storageDir = join(tmpProjectsRoot, encoded)
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(
      join(storageDir, 'aaaa1111-2222-3333-4444-555555555555.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi claude' } }) + '\n',
    )

    const res = await fetch(`http://localhost:${web.port}/api/sessions/alpha/prior`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: Array<{ id: string; firstUserMessage: string; mtime: number }> }
    expect(body.sessions.length).toBe(1)
    expect(body.sessions[0].id).toBe('aaaa1111-2222-3333-4444-555555555555')
    expect(body.sessions[0].firstUserMessage).toBe('hi claude')
  })
})

describe('POST /api/spawn with resume', () => {
  let web: WebFrontend
  let spawnCalls: Array<{ name: string; path: string; instructions?: string; profile?: string; resume?: unknown }>

  beforeEach(async () => {
    spawnCalls = []
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const fakeScreen = {
      spawn: async (name: string, path: string, instructions?: string, profileName?: string, resume?: unknown) => {
        spawnCalls.push({ name, path, instructions, profile: profileName, resume })
      },
      spawnTeam: async () => {},
      isManaged: () => false,
    }
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: fakeScreen as unknown as ScreenManager,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('resume="continue" passes through to ScreenManager', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/spawn`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj', resume: 'continue' }),
    })
    expect(res.status).toBe(200)
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].resume).toEqual({ mode: 'continue' })
  })

  test('resume={sessionId} passes through as session mode', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/spawn`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'alpha',
        path: '/tmp/proj',
        resume: { sessionId: 'aaaa1111-2222-3333-4444-555555555555' },
      }),
    })
    expect(res.status).toBe(200)
    expect(spawnCalls[0].resume).toEqual({ mode: 'session', id: 'aaaa1111-2222-3333-4444-555555555555' })
  })

  test('rejects invalid session id with 400', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/spawn`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'alpha',
        path: '/tmp/proj',
        resume: { sessionId: '../../etc/passwd' },
      }),
    })
    expect(res.status).toBe(400)
    expect(spawnCalls.length).toBe(0)
  })

  test('no resume field → spawn called without resume', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/spawn`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj' }),
    })
    expect(res.status).toBe(200)
    expect(spawnCalls[0].resume).toBeUndefined()
  })

  test('rejects resume when teamSize > 1', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/spawn`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'team', path: '/tmp/proj', teamSize: 2, resume: 'continue' }),
    })
    expect(res.status).toBe(400)
    expect(spawnCalls.length).toBe(0)
  })
})
