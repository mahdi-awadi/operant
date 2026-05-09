// tests/frontends/rubika.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { join, join as joinPath } from 'path'
import { tmpdir } from 'os'
import { RubikaFrontend, deriveWebhookSecret, type RubikaUpdateBody, type RubikaInlineMessageBody, parseCommand, formatSessionList, formatStatus, chunkText, mimeToType, guessMime } from '../../src/frontends/rubika'
import { SessionRegistry } from '../../src/session-registry'
import { saveProfiles, loadProfiles } from '../../src/profiles'
import { HUB_DIR } from '../../src/config'
import type { SessionState, Profile } from '../../src/types'

// In-memory router stub — captures calls so we can assert routing.
class StubRouter {
  calls: { sessionName: string; text: string; frontend: string; user: string }[] = []
  broadcastCalls: { message: string; frontend: string; user: string }[] = []
  routeToSession(sessionName: string, text: string, frontend: string, user: string): boolean {
    this.calls.push({ sessionName, text, frontend, user })
    return true
  }
  routeFromSession(): void {}
  broadcast(message: string, frontend: string, user: string): void {
    this.broadcastCalls.push({ message, frontend, user })
  }
}

// Mock sender — captures requests instead of hitting the real API.
class FakeSender {
  calls: { method: string; body: unknown }[] = []
  reply: unknown = { status: 'OK', data: {} }
  async send(method: string, body: unknown): Promise<unknown> {
    this.calls.push({ method, body })
    return this.reply
  }
}

class StubPermissionEngine {
  resolveCalls: { rid: string; behavior: 'allow' | 'deny' }[] = []
  nextResult: { response: { requestId: string; behavior: 'allow' | 'deny' }; sessionPath: string } | null = null
  resolve(rid: string, behavior: 'allow' | 'deny') {
    this.resolveCalls.push({ rid, behavior })
    return this.nextResult
  }
}
class StubVetoController {
  cancelCalls: string[] = []
  nextCancel: { path: string; sessionName: string; draft: string; expiresAt: number; decisionId: string } | undefined
  cancel(path: string) {
    this.cancelCalls.push(path)
    const r = this.nextCancel
    this.nextCancel = undefined
    return r
  }
}
class StubSocketServer {
  sent: { path: string; message: any }[] = []
  sendToSession(path: string, message: any) { this.sent.push({ path, message }); return true }
  disconnectSession(_p: string) {}
}
class StubAutopilotRunner {
  toggleCalls: { name: string; on: boolean }[] = []
  toggle(name: string, on: boolean) { this.toggleCalls.push({ name, on }) }
  nextQuickProbe: { ok: true } | { ok: false; reason: string } = { ok: true }
  async quickProbe(_n: string) { return this.nextQuickProbe }
  nextProbe: { ok: true } | { ok: false; reason: string } = { ok: true }
  async probe(_n: string, _t: number) { return this.nextProbe }
}
class StubScreenManager {
  spawnCalls: any[][] = []
  spawnTeamCalls: any[][] = []
  gracefulKillCalls: string[] = []
  addTeammateCalls: string[] = []
  nextAddTeammate: string | null = null
  managedNames: Set<string> = new Set()
  capturePaneCalls: { name: string; lines: number }[] = []
  nextCapturePane: string | { error: string } = ''
  async addTeammate(n: string) { this.addTeammateCalls.push(n); return this.nextAddTeammate }
  async spawn(...a: any[]) { this.spawnCalls.push(a) }
  async spawnTeam(...a: any[]) { this.spawnTeamCalls.push(a) }
  async gracefulKill(n: string) { this.gracefulKillCalls.push(n) }
  isManaged(n: string) { return this.managedNames.has(n) }
  forgetManaged(_n: string) {}
  getManagedByPath(_p: string) { return null }
  async capturePaneWithScrollback(name: string, lines: number): Promise<string> {
    this.capturePaneCalls.push({ name, lines })
    if (typeof this.nextCapturePane === 'object' && 'error' in this.nextCapturePane) {
      throw new Error(this.nextCapturePane.error)
    }
    return this.nextCapturePane
  }
}
class StubVerificationRunner {
  nextResult: import('../../src/verification').VerificationResult = { status: 'pass' }
  async run(_p: string) { return this.nextResult }
}

function makeFrontend() {
  const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  const router = new StubRouter()
  const sender = new FakeSender()
  const permissions = new StubPermissionEngine()
  const socketServer = new StubSocketServer()
  const vetoController = new StubVetoController()
  const autopilotRunner = new StubAutopilotRunner()
  const screenManager = new StubScreenManager()
  const verificationRunner = new StubVerificationRunner()
  const r = new RubikaFrontend({
    token: 't',
    allowFrom: ['u1'],
    registry,
    router: router as any,
    sender: (m, b) => sender.send(m, b),
    permissions: permissions as any,
    socketServer: socketServer as any,
    vetoController: vetoController as any,
    autopilotRunner: autopilotRunner as any,
    screenManager: screenManager as any,
    verificationRunner: verificationRunner as any,
  })
  return { r, registry, router, sender, permissions, socketServer, vetoController, autopilotRunner, screenManager, verificationRunner }
}

describe('deriveWebhookSecret', () => {
  test('is deterministic for the same token', () => {
    expect(deriveWebhookSecret('abc')).toBe(deriveWebhookSecret('abc'))
  })
  test('is different for different tokens', () => {
    expect(deriveWebhookSecret('abc')).not.toBe(deriveWebhookSecret('def'))
  })
  test('is URL-safe (no /, +, =)', () => {
    const s = deriveWebhookSecret('whatever-bot-token-1234567890')
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  test('hides the original token (one-way)', () => {
    const tok = 'super-secret-token'
    expect(deriveWebhookSecret(tok)).not.toContain(tok)
  })
})

describe('RubikaFrontend.deliverToUser', () => {
  let registry: SessionRegistry
  let router: StubRouter
  let sender: FakeSender
  let r: RubikaFrontend

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    router = new StubRouter()
    sender = new FakeSender()
    r = new RubikaFrontend({
      token: 'test-token',
      allowFrom: ['user1', 'user2'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
  })

  afterEach(async () => {
    await r.stop()
  })

  test('does not send before a chat_id has been learned for an allowed sender', async () => {
    await r.deliverToUser('sap', 'hello')
    expect(sender.calls.length).toBe(0)
  })

  test('does nothing when allowFrom is empty (deny-all)', async () => {
    const noAllow = new RubikaFrontend({
      token: 't',
      allowFrom: [],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    await noAllow.deliverToUser('sap', 'hello')
    expect(sender.calls.length).toBe(0)
  })
})

describe('RubikaFrontend.handleWebhook (inbound)', () => {
  let registry: SessionRegistry
  let router: StubRouter
  let sender: FakeSender
  let r: RubikaFrontend

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    router = new StubRouter()
    sender = new FakeSender()
    r = new RubikaFrontend({
      token: 't',
      allowFrom: ['allowed-user-1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
  })

  afterEach(async () => { await r.stop() })

  function update(senderId: string, text: string, type: string = 'NewMessage'): RubikaUpdateBody {
    return {
      update: {
        type,
        chat_id: 'chat-' + senderId,
        new_message: {
          message_id: 'm1',
          text,
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: senderId,
          aux_data: { start_id: null, button_id: null },
        },
      },
    }
  }

  test('routes a NewMessage from an allowed sender to the first active session', () => {
    r.handleWebhook(update('allowed-user-1', 'do the thing'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]).toMatchObject({
      sessionName: 'sap',
      text: 'do the thing',
      frontend: 'rubika',
      user: 'allowed-user-1',
    })
  })

  test('remembers the inbound chat_id and uses it for later outbound replies', async () => {
    r.handleWebhook(update('allowed-user-1', 'do the thing'))
    await r.deliverToUser('sap', 'hello back')
    const calls = sender.calls.filter(c => c.method === 'sendMessage')
    expect(calls.length).toBe(1)
    expect(calls[0]!.body).toMatchObject({
      chat_id: 'chat-allowed-user-1',
      text: '[sap] hello back',
    })
  })

  test('rejects a NewMessage from a non-allowed sender (no router call)', () => {
    r.handleWebhook(update('attacker-9000', 'rm -rf'))
    expect(router.calls.length).toBe(0)
  })

  test('ignores updates with type other than NewMessage', () => {
    r.handleWebhook(update('allowed-user-1', 'noop', 'BotStarted'))
    expect(router.calls.length).toBe(0)
  })

  test('ignores empty text after trim', () => {
    r.handleWebhook(update('allowed-user-1', '   \n  '))
    expect(router.calls.length).toBe(0)
  })

  test('drops malformed payload silently — no throw', () => {
    expect(() => r.handleWebhook({} as any)).not.toThrow()
    expect(() => r.handleWebhook({ update: null } as any)).not.toThrow()
    expect(router.calls.length).toBe(0)
  })

  test('with no active session, replies "no active session" instead of throwing', async () => {
    const empty = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const r2 = new RubikaFrontend({
      token: 't', allowFrom: ['u1'], registry: empty,
      router: router as any, sender: (m, b) => sender.send(m, b),
    })
    r2.handleWebhook(update('u1', 'hi'))
    // Async send, give it a tick.
    await new Promise((r) => setTimeout(r, 5))
    expect(router.calls.length).toBe(0)
    expect(sender.calls.length).toBe(1)
    expect((sender.calls[0]!.body as any).text).toMatch(/no active session/i)
    await r2.stop()
  })

  test('webhook URL secret matches the deriveWebhookSecret of the configured token', () => {
    expect(r.webhookPath).toContain(deriveWebhookSecret('t'))
    expect(r.webhookPath.startsWith('/api/rubika/webhook/')).toBe(true)
  })
})

describe('RubikaFrontend.dispatchCommand', () => {
  function update(senderId: string, text: string): RubikaUpdateBody {
    return {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-' + senderId,
        new_message: {
          message_id: 'm1',
          text,
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: senderId,
          aux_data: { start_id: null, button_id: null },
        },
      },
    }
  }

  test('handleWebhook dispatches /<unknown> with helpful message', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/nope'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(sender.calls.find(c => c.method === 'sendMessage')?.body).toMatchObject({
      text: expect.stringContaining('Unknown command'),
    })
  })

  test('/start replies with welcome message', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/start'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(sender.calls.find(c => c.method === 'sendMessage')?.body).toMatchObject({
      text: expect.stringContaining('Connected to Claude Code Hub'),
    })
  })

  test('plain text still routes to session (no dispatch)', () => {
    const { r, registry, router } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', 'hello world'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]).toMatchObject({ text: 'hello world' })
  })

  test('/list shows "No sessions connected." when registry empty', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/list'))
    await new Promise(rs => setTimeout(rs, 5))
    expect((sender.calls[0]!.body as any).text).toBe('No sessions connected.')
    expect((sender.calls[0]!.body as any).inline_keypad).toBeUndefined()
  })

  test('/list renders sessions as chat_keypad with select:<name> button ids', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    registry.register('/p/gold:0', { name: 'gold' })
    r.handleWebhook(update('u1', '/list'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls[0]!.body as any
    expect(body.text).toContain('sap')
    expect(body.text).toContain('gold')
    // chat_keypad is used (not inline_keypad) because Rubika strips
    // aux_data.button_id from inline_keypad taps in polling mode.
    expect(body.chat_keypad_type).toBe('New')
    expect(body.chat_keypad.rows).toHaveLength(2)
    expect(body.chat_keypad.rows[0].buttons[0].id).toBe('select:sap')
    expect(body.chat_keypad.rows[0].buttons[0].button_text).toBe('sap')
  })
})

describe('RubikaFrontend.start', () => {
  test('registers BOTH ReceiveUpdate and ReceiveInlineMessage', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      webhookBase: 'https://hub.example',
      sender: (m, b) => sender.send(m, b),
      pollingIntervalMs: 0,
    })
    await r.start()
    expect(sender.calls).toEqual([
      { method: 'updateBotEndpoints', body: { type: 'ReceiveUpdate', url: `https://hub.example${r.webhookPath}` } },
      { method: 'updateBotEndpoints', body: { type: 'ReceiveInlineMessage', url: `https://hub.example${r.inlineWebhookPath}` } },
    ])
  })

  test('continues if one registration fails', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    let n = 0
    const flakySender = async (m: string, b: unknown) => {
      sender.calls.push({ method: m, body: b })
      n++
      if (n === 1) throw new Error('rubika down')
      return { status: 'OK' }
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      webhookBase: 'https://hub.example',
      sender: flakySender,
      pollingIntervalMs: 0,
    })
    await r.start()
    expect(sender.calls.length).toBe(2)
  })

  test('skips registration when webhookBase is missing', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
      pollingIntervalMs: 0,
    })
    await r.start()
    expect(sender.calls.length).toBe(0)
  })

  test('bootstrap captures backlog and sends Drain/Keep prompt instead of dropping', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    // Stub sender: getUpdates returns 2 messages from u1, then empty.
    let getUpdatesCalls = 0
    const stubSender = async (method: string, body: unknown): Promise<unknown> => {
      sender.calls.push({ method, body })
      if (method === 'getUpdates') {
        getUpdatesCalls++
        if (getUpdatesCalls === 1) {
          return {
            updates: [
              { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm1', text: '/list', time: '1', is_edited: false, sender_type: 'User', sender_id: 'u1' } },
              { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm2', text: 'hello', time: '2', is_edited: false, sender_type: 'User', sender_id: 'u1' } },
            ],
            next_offset_id: 'after-2',
          }
        }
        return { updates: [], next_offset_id: 'after-2' }
      }
      return { status: 'OK' }
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: stubSender,
      pollingIntervalMs: 1000,
    })
    await r.start()
    await r.stop()

    // Find the prompt sendMessage (skip getUpdates calls).
    const sendCalls = sender.calls.filter(c => c.method === 'sendMessage')
    expect(sendCalls.length).toBe(1)
    const body = sendCalls[0]!.body as any
    expect(body.chat_id).toBe('chat-u1')
    expect(body.text).toContain('/list')
    expect(body.text).toContain('hello')
    expect(body.chat_keypad_type).toBe('New')
    const ids = body.chat_keypad.rows.flatMap((r: any) => r.buttons.map((b: any) => b.id))
    expect(ids).toContain('restart:drain:u1')
    expect(ids).toContain('restart:keep:u1')

    // No commands processed yet.
    expect(router.calls.length).toBe(0)
  })

  test('bootstrap with no backlog does not send a prompt', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    sender.reply = { updates: [], next_offset_id: '' }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
      pollingIntervalMs: 1000,
    })
    await r.start()
    await r.stop()
    const sendCalls = sender.calls.filter(c => c.method === 'sendMessage')
    expect(sendCalls.length).toBe(0)
  })
})

describe('RubikaFrontend.refreshEndpoints', () => {
  test('calls updateBotEndpoints twice with correct URLs', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      webhookBase: 'https://hub.example',
      sender: (m, b) => sender.send(m, b),
    })
    await r.refreshEndpoints()
    expect(sender.calls).toEqual([
      { method: 'updateBotEndpoints', body: { type: 'ReceiveUpdate', url: `https://hub.example${r.webhookPath}` } },
      { method: 'updateBotEndpoints', body: { type: 'ReceiveInlineMessage', url: `https://hub.example${r.inlineWebhookPath}` } },
    ])
  })

  test('is a no-op when webhookBase is not configured', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    await r.refreshEndpoints()
    expect(sender.calls.length).toBe(0)
  })
})

describe('parseCommand', () => {
  test('returns null for non-slash text', () => {
    expect(parseCommand('hello')).toBeNull()
  })
  test('parses /list with no args', () => {
    expect(parseCommand('/list')).toEqual({ command: 'list', args: [] })
  })
  test('parses /spawn name path 2', () => {
    expect(parseCommand('/spawn alpha /home/foo 2')).toEqual({ command: 'spawn', args: ['alpha', '/home/foo', '2'] })
  })
  test('drops empty tokens from runs of whitespace', () => {
    expect(parseCommand('/all   hello   world')).toEqual({ command: 'all', args: ['hello', 'world'] })
  })
})

describe('formatSessionList', () => {
  test('renders empty', () => {
    expect(formatSessionList([], null)).toBe('No sessions connected.')
  })
  test('marks active and trust', () => {
    const s: SessionState[] = [{
      name: 'sap', path: '/p:0', status: 'active', trust: 'auto', prefix: '', uploadDir: '.', managed: false, teamIndex: 0, teamSize: 1, profileOverrides: {},
    } as any]
    const out = formatSessionList(s, 'sap')
    expect(out).toContain('🟢 sap')
    expect(out).toContain('[auto]')
    expect(out).toContain('← active')
  })
})

describe('formatStatus', () => {
  test('renders empty', () => {
    expect(formatStatus([])).toBe('No sessions connected.')
  })
  test('renders session with path, trust, optional prefix; no HTML tags', () => {
    const s: SessionState[] = [{
      name: 'sap', path: '/p:0', status: 'active', trust: 'auto', prefix: 'hello',
      uploadDir: '.', managed: false, teamIndex: 0, teamSize: 1, profileOverrides: {},
    } as any]
    const out = formatStatus(s)
    expect(out).toContain('sap')
    expect(out).toContain('path: /p:0')
    expect(out).toContain('trust: auto')
    expect(out).toContain('prefix: hello')
    expect(out).not.toMatch(/<\/?[bi]>/)
  })
  test('omits prefix line when prefix is empty', () => {
    const s: SessionState[] = [{
      name: 'sap', path: '/p:0', status: 'active', trust: 'ask', prefix: '',
      uploadDir: '.', managed: false, teamIndex: 0, teamSize: 1, profileOverrides: {},
    } as any]
    expect(formatStatus(s)).not.toContain('prefix:')
  })
})

describe('chunkText', () => {
  test('text shorter than limit returns a one-element array', () => {
    expect(chunkText('hello', 100)).toEqual(['hello'])
  })
  test('text exactly equal to limit returns a one-element array', () => {
    expect(chunkText('aaaa', 4)).toEqual(['aaaa'])
  })
  test('text with no newlines hard-cuts at limit', () => {
    const out = chunkText('aaaaabbbbb', 5)
    expect(out).toEqual(['aaaaa', 'bbbbb'])
  })
  test('text with a newline within the limit cuts on the newline', () => {
    const out = chunkText('aaaa\nbbbbbbb', 7)
    expect(out[0]).toBe('aaaa\n')
    expect(out[1]).toBe('bbbbbbb')
  })
  test('multi-chunk with newline preference', () => {
    const out = chunkText('line1\nline2\nlineeeeee3', 8)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.join('')).toBe('line1\nline2\nlineeeeee3')
  })
})

describe('RubikaFrontend.handleInlineWebhook', () => {
  function inline(senderId: string, buttonId: string) {
    return {
      inline_message: {
        chat_id: `chat-${senderId}`,
        sender_id: senderId,
        message_id: 'm1',
        aux_data: { button_id: buttonId },
      },
    }
  }

  test('rejects non-allowed senders', () => {
    const { r, permissions } = makeFrontend()
    r.handleInlineWebhook(inline('attacker', 'perm:allow:1'))
    expect(permissions.resolveCalls).toEqual([])
  })

  test('select:<name> updates per-user active session map', () => {
    const { r, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleInlineWebhook(inline('u1', 'select:sap'))
    expect((r as any).activeSessionByUser.get('u1')).toBe('sap')
  })

  test('perm:allow:<rid> calls permissions.resolve and forwards via socketServer', () => {
    const { r, permissions, socketServer } = makeFrontend()
    permissions.nextResult = { response: { requestId: '42', behavior: 'allow' }, sessionPath: '/p:0' }
    r.handleInlineWebhook(inline('u1', 'perm:allow:42'))
    expect(permissions.resolveCalls).toEqual([{ rid: '42', behavior: 'allow' }])
    expect(socketServer.sent[0]).toMatchObject({ path: '/p:0', message: { type: 'permission_response', requestId: '42', behavior: 'allow' } })
  })

  test('perm:deny:<rid> dispatches deny via permissions.resolve + socketServer', () => {
    const { r, permissions, socketServer } = makeFrontend()
    permissions.nextResult = { response: { requestId: '42', behavior: 'deny' }, sessionPath: '/p:0' }
    r.handleInlineWebhook(inline('u1', 'perm:deny:42'))
    expect(permissions.resolveCalls).toEqual([{ rid: '42', behavior: 'deny' }])
    expect(socketServer.sent.length).toBe(1)
  })

  test('perm:allow:<rid> with no pending request makes no socket send', () => {
    const { r, permissions, socketServer } = makeFrontend()
    permissions.nextResult = null
    r.handleInlineWebhook(inline('u1', 'perm:allow:42'))
    expect(socketServer.sent).toEqual([])
  })

  test('ap-send:<sessionName> resolves the veto and sends the draft to the session', () => {
    const { r, vetoController, socketServer, registry } = makeFrontend()
    registry.register('/home/sap:0', { name: 'sap' })
    vetoController.nextCancel = { path: '/home/sap:0', sessionName: 'sap', draft: 'hello there', expiresAt: 0, decisionId: 'd1' }
    r.handleInlineWebhook(inline('u1', 'ap-send:sap'))
    expect(vetoController.cancelCalls).toEqual(['/home/sap:0'])
    expect(socketServer.sent[0]).toMatchObject({ path: '/home/sap:0', message: { type: 'channel_message', content: 'hello there' } })
  })

  test('ap-cancel:<sessionName> resolves the veto without sending', () => {
    const { r, vetoController, socketServer, registry } = makeFrontend()
    registry.register('/home/sap:0', { name: 'sap' })
    vetoController.nextCancel = { path: '/home/sap:0', sessionName: 'sap', draft: 'hello', expiresAt: 0, decisionId: 'd1' }
    r.handleInlineWebhook(inline('u1', 'ap-cancel:sap'))
    expect(vetoController.cancelCalls).toEqual(['/home/sap:0'])
    expect(socketServer.sent).toEqual([])
  })

  test('drift:remind:<sessionName> sends a rule-reminder channel_message', () => {
    const { r, registry, socketServer } = makeFrontend()
    registry.register('/home/sap:0', { name: 'sap' })
    r.handleInlineWebhook(inline('u1', 'drift:remind:sap'))
    expect(socketServer.sent[0]?.message.type).toBe('channel_message')
    expect(socketServer.sent[0]?.message.content).toMatch(/Project rule/)
  })

  test('drift:ignore:<sessionName> is a no-op (no socket send)', () => {
    const { r, socketServer } = makeFrontend()
    r.handleInlineWebhook(inline('u1', 'drift:ignore:sap'))
    expect(socketServer.sent).toEqual([])
  })

  test('restart:keep:<senderId> replays captured updates and clears backlog', () => {
    const { r, registry, router } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    const captured: RubikaUpdateBody[] = [
      { update: { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm1', text: '/list', time: '1', is_edited: false, sender_type: 'User', sender_id: 'u1' } } },
      { update: { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm2', text: 'hello', time: '2', is_edited: false, sender_type: 'User', sender_id: 'u1' } } },
    ]
    ;(r as any).pendingRestartBacklog.set('u1', captured)
    ;(r as any).chatIdByUser.set('u1', 'chat-u1')

    r.handleInlineWebhook(inline('u1', 'restart:keep:u1'))

    // /list goes to handleWebhook → cmdList (sendMessage path), but plain text
    // 'hello' gets routed through MessageRouter. Assert at least the routing
    // path saw it.
    expect(router.calls.find(c => c.text === 'hello')).toBeTruthy()
    expect((r as any).pendingRestartBacklog.has('u1')).toBe(false)

    // Second click is a no-op.
    const before = router.calls.length
    r.handleInlineWebhook(inline('u1', 'restart:keep:u1'))
    expect(router.calls.length).toBe(before)
  })

  test('restart:drain:<senderId> clears backlog without replaying', () => {
    const { r, router } = makeFrontend()
    const captured: RubikaUpdateBody[] = [
      { update: { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm1', text: 'something', time: '1', is_edited: false, sender_type: 'User', sender_id: 'u1' } } },
    ]
    ;(r as any).pendingRestartBacklog.set('u1', captured)
    ;(r as any).chatIdByUser.set('u1', 'chat-u1')

    r.handleInlineWebhook(inline('u1', 'restart:drain:u1'))

    expect(router.calls.length).toBe(0)
    expect((r as any).pendingRestartBacklog.has('u1')).toBe(false)
  })

  test('drops malformed payloads', () => {
    const { r, permissions } = makeFrontend()
    expect(() => r.handleInlineWebhook({} as any)).not.toThrow()
    expect(() => r.handleInlineWebhook({ inline_message: null } as any)).not.toThrow()
    expect(permissions.resolveCalls).toEqual([])
  })

  test('logs unknown prefix without throwing', () => {
    const { r } = makeFrontend()
    expect(() => r.handleInlineWebhook(inline('u1', 'unknown:prefix'))).not.toThrow()
  })
})

// Helper: build a NewMessage update
function update(senderId: string, text: string): RubikaUpdateBody {
  return {
    update: {
      type: 'NewMessage',
      chat_id: 'chat-' + senderId,
      new_message: {
        message_id: 'm1',
        text,
        time: '1700000000',
        is_edited: false,
        sender_type: 'User',
        sender_id: senderId,
        aux_data: { start_id: null, button_id: null },
      },
    },
  }
}

describe('cmdStatus', () => {
  test('/status with one session — reply text contains session name (no HTML)', async () => {
    const { r, registry, sender } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/status'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toMatch(/sap/)
    expect(body.text).not.toMatch(/<\/?[^>]+>/)
  })

  test('/status with no sessions — "No sessions connected."', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/status'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('No sessions connected.')
  })
})

describe('cmdProfiles', () => {
  // HUB_DIR is the temp dir set by tests/setup.ts preload — safe to read/write.
  // Clean up any profiles.json left by a previous test.
  const profilesFile = join(HUB_DIR, 'profiles.json')

  afterEach(() => {
    rmSync(profilesFile, { force: true })
  })

  test('/profiles with no user profiles returns built-in profiles listing', async () => {
    // loadProfilesForHub with an empty dir returns built-ins — just verify non-empty reply
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profiles'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    // Built-ins exist, so we get a listing (not "No profiles defined.")
    expect(body.text).toMatch(/Profiles:/)
    expect(body.text).toMatch(/careful/)
  })

  test('/profiles with a user-defined profile lists its name and trust', async () => {
    const myProfile: Profile = {
      name: 'myproj',
      description: 'My project',
      trust: 'ask',
      rules: [],
      facts: [],
      prefix: '',
    }
    saveProfiles([myProfile], HUB_DIR)
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profiles'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('myproj')
    expect(body.text).toContain('ask')
  })
})

describe('cmdProfile', () => {
  // Use HUB_DIR (temp dir from setup.ts preload) for all profile reads/writes.
  const profilesFile = join(HUB_DIR, 'profiles.json')

  afterEach(() => {
    rmSync(profilesFile, { force: true })
  })

  test('/profile <unknown> — "Profile not found"', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile nonexistent'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toMatch(/Profile "nonexistent" not found/)
  })

  test('/profile <name> shows details — Trust, Rules count, Facts count', async () => {
    const myProfile: Profile = {
      name: 'myproj',
      description: 'A project profile',
      trust: 'ask',
      rules: ['rule one', 'rule two'],
      facts: ['fact one'],
      prefix: '',
    }
    saveProfiles([myProfile], HUB_DIR)
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile myproj'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Profile: myproj')
    expect(body.text).toContain('Trust: ask')
    expect(body.text).toContain('Rules (2):')
    expect(body.text).toContain('Facts (1):')
    // No HTML tags
    expect(body.text).not.toMatch(/<\/?[^>]+>/)
  })

  test('/profile create <name> writes a new profile', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile create newone'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Created profile "newone"')
    // Verify it actually got saved by loading it back
    const saved = loadProfiles(HUB_DIR)
    expect(saved.find(p => p.name === 'newone')).toBeDefined()
  })

  test('/profile create <name> when name already exists — "already exists"', async () => {
    const myProfile: Profile = {
      name: 'existing',
      description: '',
      trust: 'ask',
      rules: [],
      facts: [],
      prefix: '',
    }
    saveProfiles([myProfile], HUB_DIR)
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile create existing'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('already exists')
  })

  test('/profile delete <name> removes the profile', async () => {
    const myProfile: Profile = {
      name: 'todelete',
      description: '',
      trust: 'ask',
      rules: [],
      facts: [],
      prefix: '',
    }
    saveProfiles([myProfile], HUB_DIR)
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile delete todelete'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Deleted profile "todelete"')
    // Verify removal
    const saved = loadProfiles(HUB_DIR)
    expect(saved.find(p => p.name === 'todelete')).toBeUndefined()
  })

  test('/profile with no args returns usage string', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/profile'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Usage:')
    expect(body.text).toContain('/profile create')
  })
})

describe('cmdSpawn / cmdKill / cmdRemove / cmdRename', () => {
  test('/spawn with no args replies with usage', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/spawn'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Usage: /spawn')
  })

  test('/spawn alpha /home/foo calls screenManager.spawn and sets active session', async () => {
    const { r, sender, screenManager } = makeFrontend()
    r.handleWebhook(update('u1', '/spawn alpha /home/foo'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.spawnCalls.length).toBe(1)
    expect(screenManager.spawnCalls[0]).toEqual(['alpha', '/home/foo', undefined, undefined])
    expect((r as any).activeSessionByUser.get('u1')).toBe('alpha')
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Spawned alpha at /home/foo')
    expect(body.text).toContain('now active')
  })

  test('/spawn alpha /home/foo 3 calls spawnTeam(name, path, 3, undefined, undefined)', async () => {
    const { r, screenManager } = makeFrontend()
    r.handleWebhook(update('u1', '/spawn alpha /home/foo 3'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.spawnTeamCalls.length).toBe(1)
    expect(screenManager.spawnTeamCalls[0]).toEqual(['alpha', '/home/foo', 3, undefined, undefined])
  })

  test('/resume with no args replies with usage', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/resume'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Usage: /resume')
  })

  test('/resume alpha /home/foo calls screenManager.spawn with continue resume spec', async () => {
    const { r, sender, screenManager } = makeFrontend()
    r.handleWebhook(update('u1', '/resume alpha /home/foo'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.spawnCalls.length).toBe(1)
    expect(screenManager.spawnCalls[0]).toEqual(['alpha', '/home/foo', undefined, undefined, { mode: 'continue' }])
    expect((r as any).activeSessionByUser.get('u1')).toBe('alpha')
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Resumed alpha at /home/foo')
    expect(body.text).toContain('latest session')
    expect(body.text).toContain('now active')
  })

  test('/resume with --profile unknown replies error and does not spawn', async () => {
    const { r, sender, screenManager } = makeFrontend()
    r.handleWebhook(update('u1', '/resume alpha /home/foo --profile unknownprofile99'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.spawnCalls.length).toBe(0)
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Profile "unknownprofile99" not found')
  })

  test('/spawn with --profile foo unknown profile replies error', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/spawn alpha /home/foo --profile unknownprofile99'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Profile "unknownprofile99" not found')
    expect(body.text).toContain('/profiles')
  })

  test('/kill <name> calls screenManager.gracefulKill when managed', async () => {
    const { r, sender, registry, screenManager } = makeFrontend()
    registry.register('/p/alpha:0', { name: 'alpha' })
    screenManager.managedNames.add('alpha')
    r.handleWebhook(update('u1', '/kill alpha'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.gracefulKillCalls).toEqual(['alpha'])
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Killed session alpha')
  })

  test('/kill <unknown> replies "Session not found"', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/kill ghostsession'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Session not found: ghostsession')
  })

  test('/remove on connected session replies hint to /kill first', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/alpha:0', { name: 'alpha' })
    // Default status is 'active' (connected), not 'disconnected'
    r.handleWebhook(update('u1', '/remove alpha'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('still connected')
    expect(body.text).toContain('/kill')
  })

  test('/rename foo bar updates registry', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    r.handleWebhook(update('u1', '/rename foo bar'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Renamed foo')
    expect(body.text).toContain('bar')
    // Verify registry updated — foo should be gone, bar should exist
    expect(registry.findByName('bar')).toBeTruthy()
    expect(registry.findByName('foo')).toBeUndefined()
  })
})

describe('cmdTeam', () => {
  test('/team with no args replies usage', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/team'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Usage: /team <name> [add]')
  })

  test('/team <unknown> replies "Session not found"', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/team ghostsession'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Session "ghostsession" not found')
  })

  test('/team <name> on solo session replies "is a solo session"', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/alpha:0', { name: 'alpha' })
    r.handleWebhook(update('u1', '/team alpha'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('alpha is a solo session, not a team')
  })

  test('/team <name> on a team renders members as plain text (no inline_keypad, has 👑 and ├ markers)', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/home/proj:0', { name: 'lead' })
    registry.register('/home/proj:1', { name: 'mate1' })
    r.handleWebhook(update('u1', '/team lead'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.inline_keypad).toBeUndefined()
    expect(body.text).toContain('👑')
    expect(body.text).toContain('├')
    expect(body.text).toContain('lead')
    expect(body.text).toContain('mate1')
  })

  test('/team <name> add calls screenManager.addTeammate and replies with new name', async () => {
    const { r, sender, screenManager } = makeFrontend()
    screenManager.nextAddTeammate = 'lead-1'
    r.handleWebhook(update('u1', '/team lead add'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(screenManager.addTeammateCalls).toEqual(['lead'])
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Added teammate: lead-1')
  })
})

describe('cmdTrust / cmdPrefix / cmdAll', () => {
  test('/trust foo bogus replies invalid level message', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/trust foo bogus'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('Invalid trust level. Must be one of: strict, ask, auto, yolo')
  })

  test('/trust foo auto sets registry trust and replies confirmation', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    r.handleWebhook(update('u1', '/trust foo auto'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(registry.get('/p/foo:0')?.trust).toBe('auto')
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Set foo trust to auto')
  })

  test('/prefix foo (no space) replies usage', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/prefix foo'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('Usage: /prefix <name> <text>')
  })

  test('/prefix foo hello world sets prefix to "hello world"', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    r.handleWebhook(update('u1', '/prefix foo hello world'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(registry.get('/p/foo:0')?.prefix).toBe('hello world')
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('hello world')
  })

  test('/all hello world broadcasts via router with senderId', async () => {
    const { r, router } = makeFrontend()
    r.handleWebhook(update('u1', '/all hello world'))
    await new Promise(rs => setTimeout(rs, 5))
    expect(router.broadcastCalls).toEqual([{ message: 'hello world', frontend: 'rubika', user: 'u1' }])
  })
})

describe('cmdRules / cmdFact / cmdFacts / cmdChannel', () => {
  const profilesFile = join(HUB_DIR, 'profiles.json')

  afterEach(() => {
    rmSync(profilesFile, { force: true })
  })

  test('/rules <unknown> → "Session \"<unknown>\" not found"', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/rules ghost'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('Session "ghost" not found')
  })

  test('/rules <name> with no rules → "No rules for <name>"', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/rules sap'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('No rules for sap')
  })

  test('/rules <name> <text> → adds rule, replies with confirmation (no HTML)', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/rules sap always write tests'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('✅ Added rule to sap: "always write tests"')
    expect(body.text).not.toMatch(/<\/?[^>]+>/)
  })

  test('/rules <name> clear → "🗑 Cleared rules for <name>"', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/rules sap clear'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('🗑 Cleared rules for sap')
  })

  test('/fact with no session arg → usage', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/fact'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Usage: /fact')
  })

  test('/fact <name> <text> → adds fact and replies confirmation', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/fact sap the sky is blue'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('✅ Added fact to sap: "the sky is blue"')
  })

  test('/facts <name> clear → "🗑 Cleared facts for <name>"', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/facts sap clear'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('🗑 Cleared facts for sap')
  })

  test('/channel <name> reset → clears override and replies confirmation', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/channel sap reset'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toBe('✅ Reset channel instructions for sap (using default)')
  })

  test('/channel <name> <text> → sets rubika channel override (assert via registry)', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleWebhook(update('u1', '/channel sap be concise and helpful'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('updated')
    expect(registry.getChannelOverride('/p/sap:0', 'rubika')).toBe('be concise and helpful')
  })
})

describe('cmdAutopilot', () => {
  test('/autopilot foo on enables autopilot, sets trust auto, calls quickProbe, persists, replies ON', async () => {
    const { r, registry, autopilotRunner, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    r.handleWebhook(update('u1', '/autopilot foo on'))
    await new Promise(rs => setTimeout(rs, 20))
    expect(registry.get('/p/foo:0')?.trust).toBe('auto')
    expect(registry.getAutopilot('/p/foo:0')?.enabled).toBe(true)
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('🤖 Autopilot ON for foo')
  })

  test('/autopilot foo off disables autopilot, restores priorTrust', async () => {
    const { r, registry, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    // Enable first so there is a priorTrust to restore
    registry.setTrust('/p/foo:0', 'ask')
    registry.setAutopilot('/p/foo:0', { enabled: true, priorTrust: 'ask' })
    r.handleWebhook(update('u1', '/autopilot foo off'))
    await new Promise(rs => setTimeout(rs, 10))
    expect(registry.getAutopilot('/p/foo:0')?.enabled).toBe(false)
    expect(registry.get('/p/foo:0')?.trust).toBe('ask')
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('🤖 Autopilot OFF for foo')
  })

  test('/autopilot foo on with failing quickProbe replies precheck failed', async () => {
    const { r, registry, autopilotRunner, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    autopilotRunner.nextQuickProbe = { ok: false, reason: 'tmux session not found' }
    r.handleWebhook(update('u1', '/autopilot foo on'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Autopilot precheck failed: tmux session not found')
    expect(registry.getAutopilot('/p/foo:0')?.enabled).not.toBe(true)
  })
})

describe('cmdPeek', () => {
  test('/peek with no active session and no name replies with "no active session"', async () => {
    const { r, sender } = makeFrontend()
    r.handleWebhook(update('u1', '/peek'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text.toLowerCase()).toContain('no active session')
  })

  test('/peek <name> captures pane and includes name in reply', async () => {
    const { r, registry, screenManager, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    screenManager.nextCapturePane = 'PANE_CONTENT_LINE_1\nPANE_CONTENT_LINE_2'
    r.handleWebhook(update('u1', '/peek foo'))
    await new Promise(rs => setTimeout(rs, 10))
    expect(screenManager.capturePaneCalls[0]).toEqual({ name: 'hub-foo', lines: 80 })
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('foo')
    expect(body.text).toContain('PANE_CONTENT_LINE_1')
    expect(body.text).toContain('PANE_CONTENT_LINE_2')
  })

  test('/peek with custom line count passes it through', async () => {
    const { r, registry, screenManager } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    screenManager.nextCapturePane = 'x'
    r.handleWebhook(update('u1', '/peek foo 200'))
    await new Promise(rs => setTimeout(rs, 10))
    expect(screenManager.capturePaneCalls[0]?.lines).toBe(200)
  })

  test('/peek with no tmux session reports the error', async () => {
    const { r, registry, screenManager, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    screenManager.nextCapturePane = { error: 'No tmux session "hub-foo"' }
    r.handleWebhook(update('u1', '/peek foo'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('Could not peek foo')
    expect(body.text).toContain('No tmux session')
  })

  test('/peek strips ANSI codes from captured output', async () => {
    const { r, registry, screenManager, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    screenManager.nextCapturePane = '\x1b[31mRED_TEXT\x1b[0m'
    r.handleWebhook(update('u1', '/peek foo'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('RED_TEXT')
    expect(body.text).not.toContain('\x1b[31m')
  })
})

describe('cmdVerify', () => {
  test('/verify foo on passing run replies ✅', async () => {
    const { r, registry, verificationRunner, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    verificationRunner.nextResult = { status: 'pass' }
    r.handleWebhook(update('u1', '/verify foo'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('✅')
  })

  test('/verify foo on failing run contains failed command name and tail', async () => {
    const { r, registry, verificationRunner, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    verificationRunner.nextResult = {
      status: 'fail',
      failedCommand: 'bun run test',
      exitCode: 1,
      tail: ['FAIL: some-test', 'AssertionError: expected 1 to equal 2'],
    }
    r.handleWebhook(update('u1', '/verify foo'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text).toContain('bun run test')
    expect(body.text).toContain('FAIL: some-test')
  })

  test('/verify foo with no-commands error contains "no verification commands"', async () => {
    const { r, registry, verificationRunner, sender } = makeFrontend()
    registry.register('/p/foo:0', { name: 'foo' })
    verificationRunner.nextResult = {
      status: 'error',
      reason: 'no-commands',
      details: '',
    }
    r.handleWebhook(update('u1', '/verify foo'))
    await new Promise(rs => setTimeout(rs, 10))
    const body = sender.calls.find(c => c.method === 'sendMessage')?.body as any
    expect(body.text.toLowerCase()).toContain('no verification commands')
  })
})

describe('mimeToType', () => {
  test('image/gif → Gif', () => expect(mimeToType('image/gif')).toBe('Gif'))
  test('image/png → Image', () => expect(mimeToType('image/png')).toBe('Image'))
  test('image/jpeg → Image', () => expect(mimeToType('image/jpeg')).toBe('Image'))
  test('video/mp4 → Video', () => expect(mimeToType('video/mp4')).toBe('Video'))
  test('audio/ogg → Voice', () => expect(mimeToType('audio/ogg')).toBe('Voice'))
  test('audio/opus → Voice', () => expect(mimeToType('audio/opus')).toBe('Voice'))
  test('audio/mpeg → Music', () => expect(mimeToType('audio/mpeg')).toBe('Music'))
  test('application/pdf → File', () => expect(mimeToType('application/pdf')).toBe('File'))
  test('application/octet-stream → File', () => expect(mimeToType('application/octet-stream')).toBe('File'))
})

describe('uploadFile', () => {
  test('calls requestSendFile with the correct type and POSTs buffer to upload_url, returns file_id', async () => {
    const { r, sender } = makeFrontend()

    // First sender call (requestSendFile) returns upload_url.
    // We intercept the second fetch (the upload) via globalThis.fetch.
    sender.reply = { upload_url: 'https://upload.example/x' }

    const fakeFileId = 'file-abc-123'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return {
        ok: true,
        json: async () => ({ status: 'OK', data: { file_id: fakeFileId } }),
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      // Write a tiny temp file to upload
      const tmpPath = '/tmp/rubika-upload-test.png'
      await import('node:fs/promises').then(fs => fs.writeFile(tmpPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])))

      const result = await (r as any).uploadFile(tmpPath, 'image/png')

      // The sender should have been called with requestSendFile + type=Image
      expect(sender.calls.length).toBe(1)
      expect(sender.calls[0]).toMatchObject({ method: 'requestSendFile', body: { type: 'Image' } })

      // The returned object carries back the file_id from the upload response
      expect(result.file_id).toBe(fakeFileId)
      expect(result.file_name).toBe('rubika-upload-test.png')
      expect(result.type).toBe('Image')
      expect(typeof result.size).toBe('number')
      expect(result.size).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('realSend passes AbortSignal to fetch — spy confirms signal is wired', async () => {
    let capturedSignal: AbortSignal | undefined

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      // Return a valid Rubika response to avoid parse errors
      return {
        ok: true,
        json: async () => ({ status: 'OK', data: {} }),
        text: async () => '',
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      // Build a frontend without a custom sender so realSend is exercised
      const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
      const router = new StubRouter()
      const r = new RubikaFrontend({
        token: 'tok',
        allowFrom: ['u1'],
        registry,
        router: router as any,
        apiBase: 'https://botapi.rubika.ir/v3',
      })
      // Trigger realSend via start() (which calls updateBotEndpoints — no webhookBase = skips)
      // Instead call a public method that routes through send → realSend:
      // deliverToUser with a known chatId set
      ;(r as any).chatIdByUser.set('u1', 'chat-u1')
      await r.deliverToUser('sap', 'hello')
      expect(capturedSignal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('deliverToUser with files', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = `/tmp/rubika-deliver-test-${Date.now()}.png`
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // minimal PNG header
  })

  afterEach(() => {
    try { unlinkSync(tmpFile) } catch {}
  })

  test('single file — calls requestSendFile (type=Image for .png), uploads, sends sendMessage with file_inline and caption', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()

    // requestSendFile returns upload_url
    sender.reply = { upload_url: 'https://upload.example/slot1' }

    const fakeFileId = 'fid-001'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return {
        ok: true,
        json: async () => ({ status: 'OK', data: { file_id: fakeFileId } }),
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      const r = new RubikaFrontend({
        token: 't',
        allowFrom: ['u1'],
        registry,
        router: router as any,
        sender: (m, b) => sender.send(m, b),
      })
      // Simulate inbound message to learn chat_id
      ;(r as any).chatIdByUser.set('u1', 'chat-u1')

      await r.deliverToUser('sap', 'caption', [tmpFile])

      // Should have called requestSendFile with type=Image
      const rsf = sender.calls.find(c => c.method === 'requestSendFile')
      expect(rsf).toBeDefined()
      expect((rsf!.body as any).type).toBe('Image')

      // Should have called sendFile (NOT sendMessage) with the flat shape
      // Rubika uses for actual photo/file delivery.
      const sf = sender.calls.find(c => c.method === 'sendFile')
      expect(sf).toBeDefined()
      expect((sf!.body as any).text).toBe('[sap] caption')
      expect((sf!.body as any).file_id).toBe(fakeFileId)
      expect((sf!.body as any).type).toBe('Image')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('two files — first message carries caption, second has empty text but still has file_inline', async () => {
    const tmpFile2 = `/tmp/rubika-deliver-test2-${Date.now()}.png`
    writeFileSync(tmpFile2, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()

    let callCount = 0
    const fakeIds = ['fid-001', 'fid-002']
    const customSender = async (method: string, body: unknown): Promise<unknown> => {
      if (method === 'requestSendFile') {
        const id = fakeIds[callCount++] ?? 'fid-x'
        return { upload_url: `https://upload.example/slot${callCount}`, file_id: id }
      }
      sender.calls.push({ method, body })
      return {}
    }

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const fileId = fakeIds[fetchCount++] ?? 'fid-x'
      return {
        ok: true,
        json: async () => ({ status: 'OK', data: { file_id: fileId } }),
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      const r = new RubikaFrontend({
        token: 't',
        allowFrom: ['u1'],
        registry,
        router: router as any,
        sender: customSender,
      })
      ;(r as any).chatIdByUser.set('u1', 'chat-u1')

      await r.deliverToUser('sap', 'caption', [tmpFile, tmpFile2])

      const sendFiles = sender.calls.filter(c => c.method === 'sendFile')
      expect(sendFiles.length).toBe(2)
      // First message carries the caption
      expect((sendFiles[0]!.body as any).text).toBe('[sap] caption')
      expect((sendFiles[0]!.body as any).file_id).toBeDefined()
      // Second message has empty text but still has the file
      expect((sendFiles[1]!.body as any).text).toBe('')
      expect((sendFiles[1]!.body as any).file_id).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
      try { unlinkSync(tmpFile2) } catch {}
    }
  })

  test('upload failure — falls back to text-only sendMessage with [upload failed: <path> — <reason>] prefix', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()

    // requestSendFile returns upload_url but the fetch upload step fails
    const customSender = async (method: string, body: unknown): Promise<unknown> => {
      if (method === 'requestSendFile') {
        return { upload_url: 'https://upload.example/slot1' }
      }
      sender.calls.push({ method, body })
      return {}
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return {
        ok: false,
        status: 413,
        json: async () => ({}),
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      const r = new RubikaFrontend({
        token: 't',
        allowFrom: ['u1'],
        registry,
        router: router as any,
        sender: customSender,
      })
      ;(r as any).chatIdByUser.set('u1', 'chat-u1')
      ;(r as any).uploadBackoffsMs = [0, 0, 0, 0]

      await r.deliverToUser('sap', 'caption', [tmpFile])

      const sm = sender.calls.find(c => c.method === 'sendMessage')
      expect(sm).toBeDefined()
      expect((sm!.body as any).text).toContain(`[upload failed: ${tmpFile}`)
      expect((sm!.body as any).text).toContain('upload HTTP 413')
      expect((sm!.body as any).text).toContain('[sap] caption')
      // No file_inline on fallback
      expect((sm!.body as any).file_inline).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('guessMime', () => {
  test('png → image/png', async () => expect(await guessMime('/tmp/x.png')).toBe('image/png'))
  test('jpg → image/jpeg', async () => expect(await guessMime('/tmp/x.jpg')).toBe('image/jpeg'))
  test('mp4 → video/mp4', async () => expect(await guessMime('/tmp/x.mp4')).toBe('video/mp4'))
  test('mp3 → audio/mpeg', async () => expect(await guessMime('/tmp/x.mp3')).toBe('audio/mpeg'))
  test('pdf → application/pdf', async () => expect(await guessMime('/tmp/x.pdf')).toBe('application/pdf'))
  test('unknown ext → application/octet-stream', async () => expect(await guessMime('/tmp/x.xyz')).toBe('application/octet-stream'))
})

// ── Task 15: inbound file save ────────────────────────────────────────────────

describe('inbound file save (Task 15)', () => {
  // Build an inbound update with a file_inline field (no text)
  function fileUpdate(senderId: string, fileId: string, fileName: string): RubikaUpdateBody {
    return {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-' + senderId,
        new_message: {
          message_id: 'm-file',
          text: '',
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: senderId,
          file_inline: { file_id: fileId, file_name: fileName },
        } as any,
      },
    }
  }

  test('inbound file_inline with active session saves to <session.path>/<uploadDir>/<file_name> and replies 📎', async () => {
    const tmpDir = mkdtempSync(joinPath(tmpdir(), 'rubika-test-'))
    try {
      const { r, registry, sender } = makeFrontend()
      registry.register(`${tmpDir}:0`, { name: 'sap' })

      const fileContent = Buffer.from('hello file')
      const originalFetch = globalThis.fetch
      // Mock fetch for the download step
      let fetchCalled = false
      globalThis.fetch = (async (url: RequestInfo | URL, _init?: RequestInit) => {
        fetchCalled = true
        expect(String(url)).toBe('https://cdn.rubika.ir/file123')
        return {
          ok: true,
          arrayBuffer: async () => fileContent.buffer,
        } as unknown as Response
      }) as unknown as typeof fetch

      // getFile returns a download_url
      sender.reply = { download_url: 'https://cdn.rubika.ir/file123' }

      try {
        r.handleWebhook(fileUpdate('u1', 'file123', 'test-doc.txt'))
        // Give async save a moment to complete
        await new Promise(rs => setTimeout(rs, 30))

        expect(fetchCalled).toBe(true)

        // File should exist at tmpDir/./test-doc.txt
        const fs = await import('node:fs/promises')
        const written = await fs.readFile(joinPath(tmpDir, 'test-doc.txt'))
        expect(written.toString()).toBe('hello file')

        // Reply should contain 📎 and the relative path
        const reply = sender.calls.find(c => c.method === 'sendMessage')
        expect(reply).toBeDefined()
        expect((reply!.body as any).text).toContain('📎 Saved')
        expect((reply!.body as any).text).toContain('test-doc.txt')
      } finally {
        globalThis.fetch = originalFetch
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('inbound file with no active session replies "No active session." and does not save', async () => {
    const { r, sender } = makeFrontend()
    // registry is empty — no active session

    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response
    }) as unknown as typeof fetch

    try {
      r.handleWebhook(fileUpdate('u1', 'file123', 'doc.txt'))
      await new Promise(rs => setTimeout(rs, 20))

      expect(fetchCalled).toBe(false)
      const reply = sender.calls.find(c => c.method === 'sendMessage')
      expect(reply).toBeDefined()
      expect((reply!.body as any).text).toMatch(/no active session/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('inbound file with empty allowFrom does nothing (no save, no send)', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: [], // deny-all
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })

    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response
    }) as unknown as typeof fetch

    try {
      r.handleWebhook(fileUpdate('u1', 'file123', 'doc.txt'))
      await new Promise(rs => setTimeout(rs, 20))

      expect(fetchCalled).toBe(false)
      expect(sender.calls.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('file save error (bad download) replies "⚠️ Could not save file: ..."', async () => {
    const tmpDir = mkdtempSync(joinPath(tmpdir(), 'rubika-test-'))
    try {
      const { r, registry, sender } = makeFrontend()
      registry.register(`${tmpDir}:0`, { name: 'sap' })

      // getFile returns a download_url but the HTTP fetch fails
      sender.reply = { download_url: 'https://cdn.rubika.ir/file123' }

      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        return {
          ok: false,
          status: 503,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response
      }) as unknown as typeof fetch

      try {
        r.handleWebhook(fileUpdate('u1', 'file123', 'bad.txt'))
        await new Promise(rs => setTimeout(rs, 30))

        const errReply = sender.calls.find(
          c => c.method === 'sendMessage' && (c.body as any).text?.includes('⚠️ Could not save file:'),
        )
        expect(errReply).toBeDefined()
        expect((errReply!.body as any).text).toContain('503')
      } finally {
        globalThis.fetch = originalFetch
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('RubikaFrontend.deliverPermissionRequest', () => {
  test('sends sendMessage with 2 inline_keypad buttons for a known chat_id', async () => {
    const { r, sender } = makeFrontend()
    // Teach the frontend the chat_id for user u1 via a webhook
    r.handleWebhook({
      update: {
        type: 'NewMessage',
        chat_id: 'chat-99',
        new_message: {
          message_id: 'm1',
          text: 'hi',
          time: '0',
          is_edited: false,
          sender_type: 'User',
          sender_id: 'u1',
        },
      },
    })
    sender.calls.length = 0 // clear routing noise

    await r.deliverPermissionRequest({
      sessionName: 'mysession',
      requestId: '42',
      toolName: 'bash',
      description: 'run a command',
      inputPreview: 'ls /tmp',
    })

    expect(sender.calls.length).toBe(1)
    const call = sender.calls[0]!
    expect(call.method).toBe('sendMessage')
    const body = call.body as any
    expect(body.chat_id).toBe('chat-99')
    expect(body.text).toContain('mysession')
    expect(body.text).toContain('bash')
    // chat_keypad (not inline_keypad) — Rubika strips aux_data.button_id from
    // inline_keypad taps so they never reach the daemon. chat_keypad delivers
    // taps via getUpdates and works on mobile.
    expect(body.inline_keypad).toBeUndefined()
    expect(body.chat_keypad_type).toBe('New')
    const rows = body.chat_keypad.rows
    expect(rows.length).toBe(1)
    const buttons = rows[0].buttons
    expect(buttons.length).toBe(2)
    expect(buttons[0].id).toBe('perm:allow:42')
    expect(buttons[0].button_text).toBe('Allow')
    expect(buttons[1].id).toBe('perm:deny:42')
    expect(buttons[1].button_text).toBe('Deny')
  })

  test('is a no-op when allowFrom is empty', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const noAllow = new RubikaFrontend({
      token: 't',
      allowFrom: [],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    await noAllow.deliverPermissionRequest({
      sessionName: 'sess',
      requestId: '1',
      toolName: 'bash',
      description: '',
      inputPreview: '',
    })
    expect(sender.calls.length).toBe(0)
  })

  test('skips a user whose chat_id has not been learned yet', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    // u1 is in allowFrom but has never sent a message, so chat_id is unknown
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    await r.deliverPermissionRequest({
      sessionName: 'sess',
      requestId: '7',
      toolName: 'write',
      description: '',
      inputPreview: '',
    })
    expect(sender.calls.length).toBe(0)
  })
})

describe('RubikaFrontend.deliverAutopilotDraft', () => {
  test('sends message with 2 buttons keyed by sessionName and text contains draft', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    // Simulate u1 having learned a chat_id via an inbound message
    const body: RubikaUpdateBody = {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-u1',
        new_message: {
          message_id: 'm1',
          text: 'hello',
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: 'u1',
          aux_data: { start_id: null, button_id: null },
        },
      },
    }
    r.handleWebhook(body)
    sender.calls.length = 0 // clear routing calls

    await r.deliverAutopilotDraft('sap', 'draft text')

    expect(sender.calls.length).toBe(1)
    const call = sender.calls[0]
    expect(call.method).toBe('sendMessage')
    const b = call.body as any
    expect(b.text).toContain('draft text')
    const buttons = b.chat_keypad?.rows?.flatMap((r: any) => r.buttons) ?? []
    expect(buttons.length).toBe(2)
    expect(buttons[0].id).toBe('ap-send:sap')
    expect(buttons[1].id).toBe('ap-cancel:sap')
  })

  test('is a no-op when allowFrom is empty', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: [],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    await r.deliverAutopilotDraft('sap', 'draft text')
    expect(sender.calls.length).toBe(0)
  })

  test('skips a user whose chat_id has not been learned yet', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    const sender = new FakeSender()
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
    // u1 is in allowFrom but has never sent a message, so chat_id is unknown
    await r.deliverAutopilotDraft('sap', 'draft text')
    expect(sender.calls.length).toBe(0)
  })
})

// ── getUpdates polling ────────────────────────────────────────────────────────

describe('RubikaFrontend polling — bootstrap drains backlog without processing', () => {
  test('start() drains backlog: queued updates are NOT routed; nextOffsetId is set', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    const router = new StubRouter()
    // Sender: bootstrap getUpdates returns two stale updates, then nothing more.
    const bootstrapResp = {
      updates: [
        { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm0', text: 'stale', time: '1', is_edited: false, sender_type: 'User', sender_id: 'u1', aux_data: { start_id: null, button_id: null } } },
      ],
      next_offset_id: 'offset-42',
    }
    const sender = async (method: string, _body: unknown) => {
      if (method === 'getUpdates') return bootstrapResp
      return {}
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender,
      pollingIntervalMs: 0, // no interval; we test bootstrap only
    })
    await r.start()
    // Stale updates must NOT have been routed.
    expect(router.calls.length).toBe(0)
    await r.stop()
  })
})

describe('RubikaFrontend polling — pollNow processes new updates', () => {
  test('pollNow routes a NewMessage to the active session', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    const router = new StubRouter()
    let callCount = 0
    const pollResp = {
      updates: [
        { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm1', text: 'hello from poll', time: '2', is_edited: false, sender_type: 'User', sender_id: 'u1', aux_data: { start_id: null, button_id: null } } },
      ],
      next_offset_id: 'offset-99',
    }
    const sender = async (method: string, _body: unknown) => {
      callCount++
      if (method === 'getUpdates') return pollResp
      return {}
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender,
      pollingIntervalMs: 0,
    })
    // Skip start() (bootstrap) to isolate pollNow.
    await r.pollNow()
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]).toMatchObject({ sessionName: 'sap', text: 'hello from poll', frontend: 'rubika', user: 'u1' })
    await r.stop()
  })
})

describe('RubikaFrontend polling — survives a getUpdates failure', () => {
  test('poll loop does not crash; next pollNow succeeds after a failure', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    const router = new StubRouter()
    let callCount = 0
    const sender = async (method: string, _body: unknown) => {
      if (method !== 'getUpdates') return {}
      callCount++
      if (callCount === 1) throw new Error('network error')
      return {
        updates: [
          { type: 'NewMessage', chat_id: 'chat-u1', new_message: { message_id: 'm2', text: 'recovered', time: '3', is_edited: false, sender_type: 'User', sender_id: 'u1', aux_data: { start_id: null, button_id: null } } },
        ],
        next_offset_id: 'offset-100',
      }
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender,
      pollingIntervalMs: 0,
    })
    // First call: throws — should not propagate.
    await expect(r.pollNow()).resolves.toBeUndefined()
    expect(router.calls.length).toBe(0)
    // Second call: succeeds.
    await r.pollNow()
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]).toMatchObject({ text: 'recovered' })
    await r.stop()
  })
})

describe('RubikaFrontend polling — stop() halts polling', () => {
  test('after stop() the interval is cleared and pollNow is still callable but timer fires no more', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    let getUpdatesCalls = 0
    const sender = async (method: string, _body: unknown) => {
      if (method === 'getUpdates') { getUpdatesCalls++; return { updates: [], next_offset_id: '' } }
      return {}
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender,
      pollingIntervalMs: 50, // very short for the test
    })
    await r.start() // bootstrap drains → getUpdatesCalls === 1
    const afterBootstrap = getUpdatesCalls
    await r.stop()
    // After stop, wait > 2 interval cycles to ensure no more auto-firings.
    await new Promise(res => setTimeout(res, 200))
    expect(getUpdatesCalls).toBe(afterBootstrap) // no new polls fired
  })
})

describe('RubikaFrontend polling — re-entrancy guard', () => {
  test('concurrent pollNow invocations only call getUpdates once', async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new StubRouter()
    let getUpdatesCalls = 0
    // Slow sender: stalls for 50ms so the second pollNow starts while first is in flight.
    const sender = async (method: string, _body: unknown) => {
      if (method === 'getUpdates') {
        getUpdatesCalls++
        await new Promise(res => setTimeout(res, 50))
        return { updates: [], next_offset_id: '' }
      }
      return {}
    }
    const r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender,
      pollingIntervalMs: 0,
    })
    // Fire both concurrently — second should return immediately via re-entrancy guard.
    const [, ] = await Promise.all([r.pollNow(), r.pollNow()])
    expect(getUpdatesCalls).toBe(1)
    await r.stop()
  })
})

describe('RubikaFrontend.handleWebhook reply-to routing', () => {
  let registry: SessionRegistry
  let router: StubRouter
  let sender: FakeSender
  let r: RubikaFrontend

  // Build an inbound update mimicking a user reply-to-message. We pass the
  // reply target via `reply_to_message_id` (Rubika's expected field name);
  // the alternate `reply_to_message: { message_id }` shape is exercised
  // separately below.
  function replyUpdate(senderId: string, text: string, replyToId: string): RubikaUpdateBody {
    return {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-' + senderId,
        new_message: {
          message_id: 'inbound-' + Math.random().toString(36).slice(2, 8),
          text,
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: senderId,
          aux_data: { start_id: null, button_id: null },
          reply_to_message_id: replyToId,
        },
      },
    }
  }

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/sap:0', { name: 'sap' })
    registry.register('/p/eticket-v3:0', { name: 'eticket' })
    router = new StubRouter()
    sender = new FakeSender()
    r = new RubikaFrontend({
      token: 't',
      allowFrom: ['u1'],
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
  })

  afterEach(async () => { await r.stop() })

  // Send chat_id learning bootstrap update so deliverToUser has somewhere to send.
  function learnChatId() {
    r.handleWebhook({
      update: {
        type: 'NewMessage',
        chat_id: 'chat-u1',
        new_message: {
          message_id: 'init',
          text: 'hi',
          time: '0',
          is_edited: false,
          sender_type: 'User',
          sender_id: 'u1',
          aux_data: { start_id: null, button_id: null },
        },
      },
    })
  }

  test('reply with no captured mapping falls back to active session', () => {
    learnChatId()
    router.calls = []
    r.handleWebhook(replyUpdate('u1', 'follow up', 'unknown-msg-id'))
    // No mapping → falls through to active/first-active session ("eticket"
    // alphabetically first OR by registration order; either way: routed).
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.text).toBe('follow up')
  })

  test('reply to a captured outgoing message routes to that session, NOT active', async () => {
    learnChatId()
    sender.reply = { message_id: 'sap-msg-1' }
    await r.deliverToUser('sap', 'hello from sap')
    sender.reply = { message_id: 'eticket-msg-1' }
    await r.deliverToUser('eticket', 'hello from eticket')

    router.calls = []
    // User replies to the sap message even though eticket was active last.
    r.handleWebhook(replyUpdate('u1', 'thanks sap', 'sap-msg-1'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.sessionName).toBe('sap')
    expect(router.calls[0]!.text).toBe('thanks sap')
  })

  test('reply to mapped session whose name is no longer registered → user notice, no route', async () => {
    learnChatId()
    sender.reply = { message_id: 'goner-msg-1' }
    await r.deliverToUser('goner', 'hi from goner')
    // Note: 'goner' was never registered — registry.findByName returns undefined.

    router.calls = []
    sender.calls = []
    r.handleWebhook(replyUpdate('u1', 'hello goner', 'goner-msg-1'))

    expect(router.calls.length).toBe(0)
    const notices = sender.calls.filter(c => c.method === 'sendMessage')
    expect(notices.length).toBe(1)
    expect((notices[0]!.body as any).text).toContain('Session "goner" is gone')
  })

  test('also handles the alternate reply_to_message.message_id shape', async () => {
    learnChatId()
    sender.reply = { message_id: 'sap-msg-2' }
    await r.deliverToUser('sap', 'hi from sap')

    router.calls = []
    const upd: RubikaUpdateBody = {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-u1',
        new_message: {
          message_id: 'inbound-x',
          text: 'reply nested',
          time: '0',
          is_edited: false,
          sender_type: 'User',
          sender_id: 'u1',
          aux_data: { start_id: null, button_id: null },
          reply_to_message: { message_id: 'sap-msg-2' },
        },
      },
    }
    r.handleWebhook(upd)
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.sessionName).toBe('sap')
  })

  test('extracts message_id from message_update.message_id envelope shape', async () => {
    learnChatId()
    sender.reply = { message_update: { message_id: 'sap-msg-3' } }
    await r.deliverToUser('sap', 'hi')

    router.calls = []
    r.handleWebhook(replyUpdate('u1', 'reply', 'sap-msg-3'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.sessionName).toBe('sap')
  })

  test('caps the per-chat map at 200 entries and evicts oldest', async () => {
    learnChatId()
    // Insert 250 outgoing messages; the first 50 should be evicted.
    for (let i = 0; i < 250; i++) {
      sender.reply = { message_id: `m-${i}` }
      await r.deliverToUser('sap', `n=${i}`)
    }

    router.calls = []
    sender.calls = []
    // Replying to the very first message → evicted → no mapping → fallback to active.
    r.handleWebhook(replyUpdate('u1', 'too old', 'm-0'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.text).toBe('too old')
    // The text routed via fallback (active session is sap or first-active),
    // it doesn't really matter — we just want to confirm we did NOT use a
    // stale-map entry to send a "session is gone" notice.
    const notices = sender.calls.filter(c => c.method === 'sendMessage')
    expect(notices.length).toBe(0)

    router.calls = []
    // The most recent should still hit.
    r.handleWebhook(replyUpdate('u1', 'still here', 'm-249'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.sessionName).toBe('sap')
  })

  test('targeted prefix /<name> still wins over reply context (not exercised in rubika; reply only checked when no command)', () => {
    // Rubika doesn't use parseTargetedMessage; commands take the parseCommand
    // path first. This test guards: a reply that *also* starts with '/' is
    // dispatched as a command, not routed via reply-target.
    learnChatId()
    router.calls = []
    sender.calls = []
    r.handleWebhook(replyUpdate('u1', '/list', 'unknown'))
    // No router call (handled by /list command), and no fallback "session gone" notice.
    expect(router.calls.length).toBe(0)
  })
})

// ── Guest pinning ────────────────────────────────────────────────────────────
// rubikaGuests is a sender_id → session_name map. Guests bypass the
// rubikaAllowFrom allowlist, are forced to route to their pinned session, and
// can NOT run any command (`/<anything>`). When a pinned session replies via
// deliverToUser, the message is also delivered to the guest's chat (in
// addition to allowFrom owners) so the conversation flows.

describe('RubikaFrontend rubikaGuests pinning', () => {
  let registry: SessionRegistry
  let router: StubRouter
  let sender: FakeSender
  let r: RubikaFrontend

  function update(senderId: string, text: string, type: string = 'NewMessage'): RubikaUpdateBody {
    return {
      update: {
        type,
        chat_id: 'chat-' + senderId,
        new_message: {
          message_id: 'm-' + Math.random().toString(36).slice(2, 8),
          text,
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: senderId,
          aux_data: { start_id: null, button_id: null },
        },
      },
    }
  }

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/p/mhmd:0', { name: 'mhmd' })
    registry.register('/p/other:0', { name: 'other' })
    router = new StubRouter()
    sender = new FakeSender()
    r = new RubikaFrontend({
      token: 't',
      allowFrom: ['owner-1'],
      guests: { 'guest-9': 'mhmd' },
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
    })
  })

  afterEach(async () => { await r.stop() })

  test('guest sender bypasses allowFrom and routes to pinned session', () => {
    r.handleWebhook(update('guest-9', 'hi'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]).toMatchObject({
      sessionName: 'mhmd',
      text: 'hi',
      frontend: 'rubika',
      user: 'guest-9',
    })
  })

  test('guest message ignores active-session-by-user (always pinned)', () => {
    // Even if some prior code path tried to set the guest's active session
    // to "other", inbound text must still go to mhmd.
    r.handleWebhook(update('guest-9', 'first'))
    // Pretend the guest somehow hits inline select:other (which we also block,
    // but defense-in-depth) — they should still pin to mhmd on next message.
    r.handleWebhook(update('guest-9', 'second'))
    expect(router.calls.every(c => c.sessionName === 'mhmd')).toBe(true)
    expect(router.calls.length).toBe(2)
  })

  test('guest /list is rejected with a "Not available." reply', async () => {
    r.handleWebhook(update('guest-9', '/list'))
    await new Promise(r => setTimeout(r, 5))
    expect(router.calls.length).toBe(0)
    const replies = sender.calls.filter(c => c.method === 'sendMessage')
    expect(replies.length).toBe(1)
    expect(replies[0]!.body).toMatchObject({
      chat_id: 'chat-guest-9',
      text: 'Not available.',
    })
  })

  test('guest /<other-session-name> is rejected with "Not available."', async () => {
    r.handleWebhook(update('guest-9', '/other do something'))
    await new Promise(r => setTimeout(r, 5))
    expect(router.calls.length).toBe(0)
    const replies = sender.calls.filter(c => c.method === 'sendMessage')
    expect(replies.length).toBe(1)
    expect(replies[0]!.body).toMatchObject({ text: 'Not available.' })
  })

  test('guest /<their-pinned-session> ... is also rejected (no command access at all)', async () => {
    r.handleWebhook(update('guest-9', '/mhmd hi there'))
    await new Promise(r => setTimeout(r, 5))
    expect(router.calls.length).toBe(0)
    const replies = sender.calls.filter(c => c.method === 'sendMessage')
    expect(replies.length).toBe(1)
    expect(replies[0]!.body).toMatchObject({ text: 'Not available.' })
  })

  test('guest /spawn (privileged) is rejected — privileges are not escalated', async () => {
    r.handleWebhook(update('guest-9', '/spawn evil /tmp'))
    await new Promise(r => setTimeout(r, 5))
    expect(router.calls.length).toBe(0)
    const replies = sender.calls.filter(c => c.method === 'sendMessage')
    expect(replies.length).toBe(1)
    expect(replies[0]!.body).toMatchObject({ text: 'Not available.' })
  })

  test('guest plain text routes (no command rejection)', () => {
    r.handleWebhook(update('guest-9', 'just a question'))
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.text).toBe('just a question')
  })

  test('guest replying to a captured bot message still pins to their session, not the reply-target', () => {
    // Even if the guest taps "reply" to some old bot message that originated
    // from "other", we ignore the reply-to mapping and stay pinned to mhmd.
    const u: RubikaUpdateBody = {
      update: {
        type: 'NewMessage',
        chat_id: 'chat-guest-9',
        new_message: {
          message_id: 'mx',
          text: 'hi',
          time: '1700000000',
          is_edited: false,
          sender_type: 'User',
          sender_id: 'guest-9',
          aux_data: { start_id: null, button_id: null },
          reply_to_message_id: 'whatever',
        },
      },
    }
    r.handleWebhook(u)
    expect(router.calls.length).toBe(1)
    expect(router.calls[0]!.sessionName).toBe('mhmd')
  })

  test('non-guest non-allowFrom sender is still rejected (guest list does not open the bot)', () => {
    r.handleWebhook(update('random-stranger', 'hi'))
    expect(router.calls.length).toBe(0)
  })

  test('inline button tap from a guest is dropped (no engine resolve, no socket send)', () => {
    const permissions = new StubPermissionEngine()
    const socketServer = new StubSocketServer()
    const r2 = new RubikaFrontend({
      token: 't',
      allowFrom: ['owner-1'],
      guests: { 'guest-9': 'mhmd' },
      registry,
      router: router as any,
      sender: (m, b) => sender.send(m, b),
      permissions: permissions as any,
      socketServer: socketServer as any,
    })
    const im: RubikaInlineMessageBody = {
      inline_message: {
        chat_id: 'chat-guest-9',
        sender_id: 'guest-9',
        message_id: 'm1',
        aux_data: { button_id: 'perm:allow:req-123' },
      },
    }
    r2.handleInlineWebhook(im)
    expect(permissions.resolveCalls.length).toBe(0)
    expect(socketServer.sent.length).toBe(0)
  })

  test('deliverToUser fans out to the guest pinned to that session', async () => {
    // Guest must have spoken first so their chat_id is recorded.
    r.handleWebhook(update('guest-9', 'hi'))
    sender.calls = []
    await r.deliverToUser('mhmd', 'pong')
    const sends = sender.calls.filter(c => c.method === 'sendMessage')
    // owner-1 has not spoken to the bot, so only the guest receives.
    expect(sends.length).toBe(1)
    expect(sends[0]!.body).toMatchObject({
      chat_id: 'chat-guest-9',
      text: '[mhmd] pong',
    })
  })

  test('deliverToUser still fans out to allowFrom owners alongside guests', async () => {
    // Owner speaks once so chat_id is recorded, then guest does too.
    r.handleWebhook(update('owner-1', '/list'))   // owner is on allowFrom — chat_id is captured
    r.handleWebhook(update('guest-9', 'hi'))
    sender.calls = []
    await r.deliverToUser('mhmd', 'pong')
    const sends = sender.calls.filter(c => c.method === 'sendMessage')
    expect(sends.length).toBe(2)
    const chatIds = sends.map(s => (s.body as any).chat_id).sort()
    expect(chatIds).toEqual(['chat-guest-9', 'chat-owner-1'])
  })

  test('deliverToUser does NOT fan out to a guest pinned to a DIFFERENT session', async () => {
    // Guest is pinned to mhmd; replies from "other" should not reach them.
    r.handleWebhook(update('guest-9', 'hi'))
    sender.calls = []
    await r.deliverToUser('other', 'leak?')
    const sends = sender.calls.filter(c => c.method === 'sendMessage')
    expect(sends.length).toBe(0)
  })
})
