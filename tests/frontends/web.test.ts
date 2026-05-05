// tests/frontends/web.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend, signSession } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'
import { RubikaFrontend } from '../../src/frontends/rubika'

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

  test('GET /api/peek/:name requires auth', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/peek/frontend`)
    expect(res.status).toBe(401)
  })

  test('GET /api/peek/:name returns 503 when no screen manager', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/peek/frontend`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(503)
    const data = await res.json() as any
    expect(data.error).toContain('screen manager')
  })

  test('GET /api/peek/:name returns captured pane when screen manager present', async () => {
    // Re-build the frontend with a stub screen manager that returns canned output.
    await web.stop()
    const stubScreen = {
      capturePaneWithScrollback: async (n: string, lines: number) => `pane for ${n} (${lines} lines)`,
      getManagedByPath: () => undefined,
      isManaged: () => false,
    }
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: stubScreen as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED_USER],
      taskMonitor: null,
    })
    await web.start()

    const res = await fetch(`http://localhost:${web.port}/api/peek/frontend?lines=120`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.name).toBe('frontend')
    expect(data.lines).toBe(120)
    expect(data.pane).toContain('pane for hub-frontend')
    expect(data.pane).toContain('120 lines')
  })

  test('GET /api/peek/:name returns 404 when tmux session is missing', async () => {
    await web.stop()
    const stubScreen = {
      capturePaneWithScrollback: async () => { throw new Error('No tmux session "hub-frontend"') },
      getManagedByPath: () => undefined,
      isManaged: () => false,
    }
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: stubScreen as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED_USER],
      taskMonitor: null,
    })
    await web.start()

    const res = await fetch(`http://localhost:${web.port}/api/peek/frontend`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(404)
    const data = await res.json() as any
    expect(data.error).toContain('No tmux session')
  })

  test('GET /api/peek/:name clamps absurd lines values', async () => {
    await web.stop()
    let receivedLines = 0
    const stubScreen = {
      capturePaneWithScrollback: async (_n: string, lines: number) => { receivedLines = lines; return 'ok' },
      getManagedByPath: () => undefined,
      isManaged: () => false,
    }
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: stubScreen as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED_USER],
      taskMonitor: null,
    })
    await web.start()

    await fetch(`http://localhost:${web.port}/api/peek/frontend?lines=999999`, {
      headers: { Cookie: authCookie() },
    })
    expect(receivedLines).toBe(500)
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

  test('POST /api/rubika/webhook/:secret accepts Rubika updates without dashboard cookie', async () => {
    const calls: unknown[] = []
    const rubika = new RubikaFrontend({
      token: 'rubika-token',
      allowFrom: ['sender-1'],
      registry,
      router: { routeToSession: (...args: unknown[]) => { calls.push(args); return true } } as any,
      sender: async () => ({ status: 'OK' }),
    })
    web.attachRubikaWebhook(rubika)

    const res = await fetch(`http://localhost:${web.port}${rubika.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update: {
          type: 'NewMessage',
          chat_id: 'chat-1',
          new_message: {
            message_id: 'm1',
            text: 'hello from rubika',
            time: '1700000000',
            is_edited: false,
            sender_type: 'User',
            sender_id: 'sender-1',
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(calls[0]).toEqual(['frontend', 'hello from rubika', 'rubika', 'sender-1'])
  })

  test('POST /api/rubika/refresh with valid auth returns 200 and calls refreshEndpoints', async () => {
    let refreshCalled = false
    const rubika = new RubikaFrontend({
      token: 'rubika-token',
      allowFrom: ['sender-1'],
      registry,
      router: { routeToSession: () => true } as any,
      sender: async () => ({ status: 'OK' }),
    })
    rubika.refreshEndpoints = async () => { refreshCalled = true }
    web.attachRubikaWebhook(rubika)

    const res = await fetch(`http://localhost:${web.port}/api/rubika/refresh`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    expect(refreshCalled).toBe(true)
  })

  test('POST /api/rubika/refresh without auth returns 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/rubika/refresh`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  test('POST /api/rubika/refresh without rubika attached returns 503', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/rubika/refresh`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(503)
  })

  test('POST /api/rubika/webhook/:secret rejects wrong secret', async () => {
    const rubika = new RubikaFrontend({
      token: 'rubika-token',
      allowFrom: ['sender-1'],
      registry,
      router: { routeToSession: () => true } as any,
      sender: async () => ({ status: 'OK' }),
    })
    web.attachRubikaWebhook(rubika)

    const res = await fetch(`http://localhost:${web.port}/api/rubika/webhook/wrong-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: null }),
    })

    expect(res.status).toBe(401)
  })
})
