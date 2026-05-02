// tests/frontends/rubika.integration.test.ts
//
// HTTP-level integration tests that drive both Rubika webhook routes through
// the real WebFrontend. Port is picked dynamically via port:0.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend } from '../../src/frontends/web'
import { RubikaFrontend, deriveWebhookSecret, deriveInlineWebhookSecret } from '../../src/frontends/rubika'
import { SessionRegistry } from '../../src/session-registry'

const TOKEN = 'test-rubika-token'
const ALLOWED_SENDER = 'u1'

// ── Minimal stubs ─────────────────────────────────────────────────────────────

class StubRouter {
  calls: { sessionName: string; text: string; frontend: string; user: string }[] = []
  routeToSession(sessionName: string, text: string, frontend: string, user: string): boolean {
    this.calls.push({ sessionName, text, frontend, user })
    return true
  }
  routeFromSession(): void {}
  broadcast(): void {}
}

class StubPermissionEngine {
  resolveCalls: { rid: string; behavior: 'allow' | 'deny' }[] = []
  resolve(rid: string, behavior: 'allow' | 'deny') {
    this.resolveCalls.push({ rid, behavior })
    return null  // no socket forwarding needed in these tests
  }
}

class StubSocketServer {
  sent: { path: string; message: unknown }[] = []
  sendToSession(path: string, message: unknown) { this.sent.push({ path, message }); return true }
  disconnectSession(_p: string) {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function newMessageBody(senderId: string, text: string): object {
  return {
    update: {
      type: 'NewMessage',
      chat_id: 'chat-1',
      new_message: {
        message_id: 'm1',
        text,
        time: '1700000000',
        is_edited: false,
        sender_type: 'User',
        sender_id: senderId,
      },
    },
  }
}

function inlineBody(senderId: string, buttonId: string): object {
  return {
    inline_message: {
      chat_id: 'chat-1',
      sender_id: senderId,
      message_id: 'im1',
      aux_data: { button_id: buttonId },
    },
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Rubika HTTP integration', () => {
  let web: WebFrontend
  let rubika: RubikaFrontend
  let router: StubRouter
  let permissions: StubPermissionEngine
  let socketServer: StubSocketServer
  let registry: SessionRegistry
  let senderCalls: { method: string; body: unknown }[]

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    router = new StubRouter()
    permissions = new StubPermissionEngine()
    socketServer = new StubSocketServer()
    senderCalls = []

    rubika = new RubikaFrontend({
      token: TOKEN,
      allowFrom: [ALLOWED_SENDER],
      registry,
      router: router as any,
      permissions: permissions as any,
      socketServer: socketServer as any,
      sender: async (method, body) => {
        senderCalls.push({ method, body })
        return { status: 'OK' }
      },
    })

    web = new WebFrontend({
      port: 0,
      registry,
      router: router as any,
      permissions: permissions as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: 'telegram-token',
      telegramBotUsername: '',
      telegramAllowFrom: [],
      taskMonitor: null,
    })
    web.attachRubikaWebhook(rubika)
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  // ── Case 1: valid NewMessage from allowed sender — no active session ─────────
  test('POST /api/rubika/webhook/<secret> with NewMessage + no session → 200 + No active session reply', async () => {
    // No session registered → should reply "No active session."
    const res = await fetch(`http://127.0.0.1:${web.port}${rubika.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMessageBody(ALLOWED_SENDER, 'hello')),
    })
    expect(res.status).toBe(200)
    // router should NOT have been called (no session to route to)
    expect(router.calls).toHaveLength(0)
    // sender should have been called with "No active session." message
    expect(senderCalls.some(c => c.method === 'sendMessage' && (c.body as any).text === 'No active session.')).toBe(true)
  })

  // ── Case 1b: valid NewMessage + active session → routeToSession called ────────
  test('POST /api/rubika/webhook/<secret> with NewMessage + active session → 200 + routeToSession called', async () => {
    // register() defaults to status:'active'
    registry.register('/home/user/myproject')

    const res = await fetch(`http://127.0.0.1:${web.port}${rubika.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMessageBody(ALLOWED_SENDER, 'hello from rubika')),
    })
    expect(res.status).toBe(200)
    expect(router.calls).toHaveLength(1)
    expect(router.calls[0]).toEqual({ sessionName: 'myproject', text: 'hello from rubika', frontend: 'rubika', user: ALLOWED_SENDER })
  })

  // ── Case 2: inline-webhook perm:allow → permissions.resolve called ───────────
  test('POST /api/rubika/inline-webhook/<secret> with perm:allow:42 → 200 + permissions.resolve called', async () => {
    const res = await fetch(`http://127.0.0.1:${web.port}${rubika.inlineWebhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inlineBody(ALLOWED_SENDER, 'perm:allow:42')),
    })
    expect(res.status).toBe(200)
    expect(permissions.resolveCalls).toHaveLength(1)
    expect(permissions.resolveCalls[0]).toEqual({ rid: '42', behavior: 'allow' })
  })

  // ── Case 3: wrong secret → 401 ────────────────────────────────────────────────
  test('POST /api/rubika/webhook/<wrong-secret> → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${web.port}/api/rubika/webhook/wrong-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMessageBody(ALLOWED_SENDER, 'hi')),
    })
    expect(res.status).toBe(401)
  })

  // ── Case 4: right secret + malformed body → 400 ───────────────────────────────
  test('POST /api/rubika/webhook/<secret> with malformed body → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${web.port}${rubika.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json{{{',
    })
    expect(res.status).toBe(400)
  })

  // ── Case 5: non-allowed sender → 200 + no routeToSession ──────────────────────
  test('POST /api/rubika/webhook/<secret> from non-allowed sender → 200 + no router call', async () => {
    registry.register('/home/user/myproject')

    const res = await fetch(`http://127.0.0.1:${web.port}${rubika.webhookPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMessageBody('not-allowed-user', 'hello')),
    })
    expect(res.status).toBe(200)
    expect(router.calls).toHaveLength(0)
  })
})
