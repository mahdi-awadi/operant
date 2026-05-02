// tests/frontends/rubika.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { RubikaFrontend, deriveWebhookSecret, type RubikaUpdateBody, type RubikaInlineMessageBody, parseCommand, formatSessionList, formatStatus, chunkText } from '../../src/frontends/rubika'
import { SessionRegistry } from '../../src/session-registry'
import { saveProfiles, loadProfiles } from '../../src/profiles'
import { HUB_DIR } from '../../src/config'
import type { SessionState, Profile } from '../../src/types'

// In-memory router stub — captures calls so we can assert routing.
class StubRouter {
  calls: { sessionName: string; text: string; frontend: string; user: string }[] = []
  routeToSession(sessionName: string, text: string, frontend: string, user: string): boolean {
    this.calls.push({ sessionName, text, frontend, user })
    return true
  }
  routeFromSession(): void {}
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
  async quickProbe(_n: string) { return { ok: true } as const }
  async probe(_n: string, _t: number) { return { ok: true } as const }
}
class StubScreenManager {
  spawnCalls: any[][] = []
  spawnTeamCalls: any[][] = []
  gracefulKillCalls: string[] = []
  managedNames: Set<string> = new Set()
  async addTeammate(_n: string) { return null }
  async spawn(...a: any[]) { this.spawnCalls.push(a) }
  async spawnTeam(...a: any[]) { this.spawnTeamCalls.push(a) }
  async gracefulKill(n: string) { this.gracefulKillCalls.push(n) }
  isManaged(n: string) { return this.managedNames.has(n) }
  forgetManaged(_n: string) {}
  getManagedByPath(_p: string) { return null }
}
class StubVerificationRunner {
  async run(_p: string) { return { status: 'pass' as const } }
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

  test('/list renders sessions with select:<name> inline buttons', async () => {
    const { r, sender, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    registry.register('/p/gold:0', { name: 'gold' })
    r.handleWebhook(update('u1', '/list'))
    await new Promise(rs => setTimeout(rs, 5))
    const body = sender.calls[0]!.body as any
    expect(body.text).toContain('sap')
    expect(body.text).toContain('gold')
    expect(body.inline_keypad.rows).toHaveLength(2)
    expect(body.inline_keypad.rows[0].buttons[0].id).toBe('select:sap')
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
    })
    await r.start()
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
