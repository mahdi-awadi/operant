// tests/frontends/rubika.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { RubikaFrontend, deriveWebhookSecret, type RubikaUpdateBody, type RubikaInlineMessageBody, parseCommand, formatSessionList, formatStatus, chunkText } from '../../src/frontends/rubika'
import { SessionRegistry } from '../../src/session-registry'
import type { SessionState } from '../../src/types'

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
  responses: { rid: string; decision: string }[] = []
  respond(rid: string, decision: string) { this.responses.push({ rid, decision }) }
}
class StubAutopilotRunner {
  vetos: { id: string; decision: string; reason?: string }[] = []
  veto(id: string, decision: string, reason?: string) { this.vetos.push({ id, decision, reason }) }
  toggle(_n: string, _on: boolean) {}
  async quickProbe(_n: string) { return { ok: true } as const }
  async probe(_n: string, _t: number) { return { ok: true } as const }
}
class StubVetoController {
  drafts = new Map<string, { sessionName: string; draft: string }>()
}
class StubScreenManager {
  async addTeammate(_n: string) { return null }
  async spawn(..._a: any[]) {}
  async spawnTeam(..._a: any[]) {}
  async gracefulKill(_n: string) {}
  isManaged(_n: string) { return false }
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
  const autopilotRunner = new StubAutopilotRunner()
  const screenManager = new StubScreenManager()
  const r = new RubikaFrontend({
    token: 't',
    allowFrom: ['u1'],
    registry,
    router: router as any,
    sender: (m, b) => sender.send(m, b),
    permissions: permissions as any,
    autopilotRunner: autopilotRunner as any,
    screenManager: screenManager as any,
  })
  return { r, registry, router, sender, permissions, autopilotRunner, screenManager }
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
  function inline(senderId: string, buttonId: string): RubikaInlineMessageBody {
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
    expect(permissions.responses).toEqual([])
  })

  test('routes perm:allow:<rid> to permissionEngine.respond(rid, "allow")', () => {
    const { r, permissions } = makeFrontend()
    r.handleInlineWebhook(inline('u1', 'perm:allow:42'))
    expect(permissions.responses).toEqual([{ rid: '42', decision: 'allow' }])
  })

  test('routes perm:always:<rid> as "always-allow"', () => {
    const { r, permissions } = makeFrontend()
    r.handleInlineWebhook(inline('u1', 'perm:always:42'))
    expect(permissions.responses).toEqual([{ rid: '42', decision: 'always-allow' }])
  })

  test('routes perm:deny:<rid> as "deny"', () => {
    const { r, permissions } = makeFrontend()
    r.handleInlineWebhook(inline('u1', 'perm:deny:42'))
    expect(permissions.responses).toEqual([{ rid: '42', decision: 'deny' }])
  })

  test('routes select:<name> to per-user activeSession map', () => {
    const { r, registry } = makeFrontend()
    registry.register('/p/sap:0', { name: 'sap' })
    r.handleInlineWebhook(inline('u1', 'select:sap'))
    expect((r as any).activeSessionByUser.get('u1')).toBe('sap')
  })

  test('drops malformed payloads', () => {
    const { r, permissions } = makeFrontend()
    expect(() => r.handleInlineWebhook({} as any)).not.toThrow()
    expect(() => r.handleInlineWebhook({ inline_message: null } as any)).not.toThrow()
    expect(permissions.responses).toEqual([])
  })

  test('logs unknown prefix without throwing', () => {
    const { r } = makeFrontend()
    expect(() => r.handleInlineWebhook(inline('u1', 'unknown:prefix'))).not.toThrow()
  })
})
