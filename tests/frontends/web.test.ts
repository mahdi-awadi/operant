// tests/frontends/web.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend, signSession } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'

const TOKEN = 'test-bot-token'
const ALLOWED_USER = '123'

function authCookie(userId = ALLOWED_USER): string {
  return `hub_session=${signSession(userId, TOKEN)}`
}

describe('WebFrontend', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/home/user/frontend')
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED_USER],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/sessions requires auth cookie — rejects without', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`)
    expect(res.status).toBe(401)
  })

  test('GET /api/sessions with valid cookie returns session list', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data.length).toBe(1)
    expect(data[0].name).toBe('frontend')
  })

  test('GET / serves HTML without auth', async () => {
    const res = await fetch(`http://localhost:${web.port}/`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<!DOCTYPE html>')
  })

  test('POST /api/autopilot sets autopilot enabled via registry', async () => {
    const path = registry.findByName('frontend')!
    expect(registry.getAutopilot(path)).toBeUndefined()

    const res = await fetch(`http://localhost:${web.port}/api/autopilot`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'frontend', enabled: true }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(registry.getAutopilot(path)?.enabled).toBe(true)
  })

  test('POST /api/autopilot returns 404 for unknown session', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/autopilot`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-such-session', enabled: true }),
    })
    expect(res.status).toBe(404)
  })
})
