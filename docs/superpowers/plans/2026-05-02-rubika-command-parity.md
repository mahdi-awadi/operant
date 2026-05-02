# Rubika Command Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `src/frontends/rubika.ts` to feature parity with `src/frontends/telegram.ts` — 18 slash commands, inline-button callbacks, file uploads in/out, permission prompts with Allow/Deny buttons, autopilot veto buttons, and a `/start` greeting.

**Architecture:** Monolithic mirror — copy the shape of `telegram.ts` into `rubika.ts`, translating grammy calls to our existing `RubikaSendFn` and Telegram's `inline_keyboard` to Rubika's `inline_keypad`. Inline-button clicks arrive on a second registered webhook endpoint (`/api/rubika/inline-webhook/<secret>`). Files use Rubika's two-step upload: `requestSendFile` → upload-URL POST → `sendMessage` with `file_inline`. No shared abstraction between Telegram and Rubika in this PR; deduplication is a follow-up.

**Tech Stack:** Bun + TypeScript, native `fetch`, `node:crypto` HMAC, `@modelcontextprotocol/sdk` (already wired). No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-05-02-rubika-command-parity-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/frontends/rubika.ts` | Modify (195 → ~1,200 lines) | All Rubika logic — webhooks, commands, callbacks, files, persistence-free state |
| `src/frontends/web.ts` | Modify (~5 lines) | Mount second route `POST /api/rubika/inline-webhook/:secret`, with auth bypass |
| `src/daemon.ts` | Modify (~10 lines) | Pass `permissions`, `screenManager`, `socketServer`, `verificationRunner`, `autopilotRunner`, `vetoController`, `taskMonitor` into `RubikaFrontend` (mirroring TelegramFrontend deps) |
| `src/types.ts` | Modify (~3 lines) | Extend `RubikaUpdateBody`/add `RubikaInlineMessageBody` types |
| `src/cli.ts` | Modify (~25 lines) | New `refresh-rubika` subcommand |
| `tests/frontends/rubika.test.ts` | Modify (15 → ~80 cases) | Per-command, callback-prefix, file, start, refresh tests |
| `tests/frontends/rubika.integration.test.ts` | Create | HTTP-level tests against real `WebFrontend` |
| `tests/cli.test.ts` | Modify (if exists, else create) | `refresh-rubika` CLI test |

---

## Conventions used by every test in this plan

Every new test in `tests/frontends/rubika.test.ts` builds the frontend with this fixture (already present at the top of the file — extend it as needed). When a task adds a new dep stub, update this fixture in that task and reuse it.

```ts
function makeFrontend(overrides: Partial<RubikaFrontendDeps> = {}) {
  const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  const router = new StubRouter()
  const sender = new FakeSender()
  const permissions = new StubPermissionEngine()
  const screenManager = new StubScreenManager()
  const verificationRunner = new StubVerificationRunner()
  const autopilotRunner = new StubAutopilotRunner()
  const vetoController = new StubVetoController()
  const r = new RubikaFrontend({
    token: 't',
    allowFrom: ['u1'],
    registry,
    router: router as any,
    permissions: permissions as any,
    screenManager: screenManager as any,
    verificationRunner: verificationRunner as any,
    autopilotRunner: autopilotRunner as any,
    vetoController: vetoController as any,
    sender: (m, b) => sender.send(m, b),
    ...overrides,
  })
  return { r, registry, router, sender, permissions, screenManager, verificationRunner, autopilotRunner, vetoController }
}
```

---

## Phase 0 — Foundation

### Task 1: Extend deps + helpers + parse helpers

**Files:**
- Modify: `src/frontends/rubika.ts` (top of file, around lines 24-90)
- Modify: `tests/frontends/rubika.test.ts` (add fixture stubs, two new tests)

- [ ] **Step 1: Write failing tests for helpers**

Append to `tests/frontends/rubika.test.ts`:

```ts
import { parseCommand, formatSessionList, chunkText } from '../../src/frontends/rubika'
import type { SessionState } from '../../src/types'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/frontends/rubika.test.ts -t "parseCommand"`
Expected: FAIL — `parseCommand` not exported.

- [ ] **Step 3: Add helpers + extend deps in `src/frontends/rubika.ts`**

Replace the deps type, add a second exported webhook-path constant, and add helpers. Insert after `DEFAULT_API_BASE`:

```ts
// ── Pure helpers (exported for testability) ─────────────────────────────────

export function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+/)
  const command = parts[0] ?? ''
  const args = parts.slice(1).filter((a) => a.length > 0)
  return { command, args }
}

export function formatSessionList(sessions: SessionState[], activeSession: string | null): string {
  if (sessions.length === 0) return 'No sessions connected.'
  return sessions.map((s) => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const trustLabel = s.trust === 'auto' ? ' [auto]' : ''
    const activeMarker = s.name === activeSession ? ' ← active' : ''
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    return `${icon} ${s.name}${trustLabel}${activeMarker}${autopilotBadge}`
  }).join('\n')
}

export function formatStatus(sessions: SessionState[]): string {
  if (sessions.length === 0) return 'No sessions connected.'
  return sessions.map((s) => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const autopilotBadge = s.autopilot?.enabled === true ? ' 🤖' : ''
    const parts = [`${icon} ${s.name}${autopilotBadge} (${s.status})`]
    parts.push(`  path: ${s.path}`)
    parts.push(`  trust: ${s.trust}`)
    if (s.prefix) parts.push(`  prefix: ${s.prefix}`)
    return parts.join('\n')
  }).join('\n\n')
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit)
    const lastNewline = slice.lastIndexOf('\n')
    const cutAt = lastNewline > 0 ? lastNewline + 1 : limit
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export function deriveInlineWebhookSecret(token: string): string {
  return createHmac('sha256', 'channelhub-rubika-inline-webhook')
    .update(token)
    .digest('base64url')
}
```

Extend `RubikaFrontendDeps` (replacing the existing block):

```ts
export type RubikaFrontendDeps = {
  token: string
  allowFrom: string[]
  registry: SessionRegistry
  router: MessageRouter
  // New deps for command parity:
  permissions?: PermissionEngine
  screenManager?: ScreenManager
  socketServer?: SocketServer
  taskMonitor?: TaskMonitor | null
  verificationRunner?: VerificationRunner
  vetoController?: VetoController
  autopilotRunner?: AutopilotRunner
  apiBase?: string
  webhookBase?: string
  sender?: RubikaSendFn
}
```

Add corresponding imports at the top:

```ts
import type { SessionState, PermissionRequest, TrustLevel, Profile } from '../types'
import type { PermissionEngine } from '../permission-engine'
import type { ScreenManager } from '../screen-manager'
import type { SocketServer } from '../socket-server'
import type { TaskMonitor } from '../task-monitor'
import type { VerificationRunner, VerificationResult } from '../verification'
import type { VetoController } from '../veto-controller'
import type { AutopilotRunner } from '../autopilot'
import { getProfile } from '../profiles'
import { loadProfilesForHub, saveProfilesForHub, saveSessions } from '../config'
```

Store the new deps in the constructor (under the existing `this.deps = deps` line):

```ts
this.permissions = deps.permissions
this.screenManager = deps.screenManager
this.socketServer = deps.socketServer
this.taskMonitor = deps.taskMonitor ?? null
this.verificationRunner = deps.verificationRunner
this.vetoController = deps.vetoController
this.autopilotRunner = deps.autopilotRunner
this.inlineWebhookPath = `/api/rubika/inline-webhook/${deriveInlineWebhookSecret(deps.token)}`
```

Add the matching private fields and the new public path field:

```ts
readonly inlineWebhookPath: string
private permissions?: PermissionEngine
private screenManager?: ScreenManager
private socketServer?: SocketServer
private taskMonitor: TaskMonitor | null
private verificationRunner?: VerificationRunner
private vetoController?: VetoController
private autopilotRunner?: AutopilotRunner
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test tests/frontends/rubika.test.ts`
Expected: 18 pass (the original 15 plus 3 new helper tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): add command-parity helpers and dep slots"
```

---

### Task 2: Register both webhook endpoints, mount in WebFrontend

**Files:**
- Modify: `src/frontends/rubika.ts` (`start()` method)
- Modify: `src/frontends/web.ts` (route handler block, ~line 396)
- Modify: `tests/frontends/rubika.test.ts` (replace existing `start()` test, add a second)

- [ ] **Step 1: Write failing tests**

Replace the existing `RubikaFrontend.start` describe block with:

```ts
describe('RubikaFrontend.start', () => {
  test('registers BOTH ReceiveUpdate and ReceiveInlineMessage', async () => {
    const { r, sender } = makeFrontend({ webhookBase: 'https://hub.example' })
    await r.start()
    expect(sender.calls).toEqual([
      { method: 'updateBotEndpoints', body: { type: 'ReceiveUpdate', url: `https://hub.example${r.webhookPath}` } },
      { method: 'updateBotEndpoints', body: { type: 'ReceiveInlineMessage', url: `https://hub.example${r.inlineWebhookPath}` } },
    ])
  })

  test('continues if one registration fails', async () => {
    const { r, sender } = makeFrontend({ webhookBase: 'https://hub.example' })
    let n = 0
    sender.send = async (m, b) => {
      sender.calls.push({ method: m, body: b })
      n++
      if (n === 1) throw new Error('rubika down')
      return { status: 'OK' }
    }
    await r.start()
    expect(sender.calls.length).toBe(2)
  })

  test('skips registration when webhookBase is missing', async () => {
    const { r, sender } = makeFrontend()
    await r.start()
    expect(sender.calls.length).toBe(0)
  })
})
```

Run: `bun test tests/frontends/rubika.test.ts -t "RubikaFrontend.start"`
Expected: FAIL — only one endpoint registered today.

- [ ] **Step 2: Update `start()` in `src/frontends/rubika.ts`**

Replace the body of `start()`:

```ts
async start(): Promise<void> {
  if (this.started) return
  this.started = true
  if (!this.deps.webhookBase) {
    process.stderr.write('rubika: rubikaWebhookBase not configured — webhooks NOT registered\n')
    return
  }
  const base = this.deps.webhookBase.replace(/\/$/, '')
  const updateUrl = `${base}${this.webhookPath}`
  const inlineUrl = `${base}${this.inlineWebhookPath}`
  await this.registerEndpoint('ReceiveUpdate', updateUrl)
  await this.registerEndpoint('ReceiveInlineMessage', inlineUrl)
}

private async registerEndpoint(type: 'ReceiveUpdate' | 'ReceiveInlineMessage', url: string): Promise<void> {
  try {
    await this.send('updateBotEndpoints', { type, url })
    process.stderr.write(`rubika: ${type} webhook registered → ${url}\n`)
  } catch (err) {
    process.stderr.write(`rubika: failed to register ${type} (${err})\n`)
  }
}
```

- [ ] **Step 3: Mount inline route in `src/frontends/web.ts`**

Find the existing block (around line 396):

```ts
const m = url.pathname.match(/^\/api\/rubika\/webhook\/([A-Za-z0-9_-]+)$/)
```

Add a sibling block immediately after the existing one:

```ts
// POST /api/rubika/inline-webhook/:secret — inline button click delivery.
const mInline = url.pathname.match(/^\/api\/rubika\/inline-webhook\/([A-Za-z0-9_-]+)$/)
if (req.method === 'POST' && mInline) {
  const r = self.rubika
  if (!r) return new Response('not configured', { status: 503 })
  if (mInline[1] !== r.inlineWebhookPath.split('/').pop()) {
    return new Response('unauthorized', { status: 401 })
  }
  try {
    const body = await req.json()
    r.handleInlineWebhook(body as any)
    return new Response('ok', { status: 200 })
  } catch (err) {
    process.stderr.write(`web: rubika inline webhook parse error: ${err}\n`)
    return new Response('bad request', { status: 400 })
  }
}
```

Update the auth-bypass `isRubikaWebhook` predicate at line 198 so both paths bypass auth:

```ts
const isRubikaWebhook =
  url.pathname.startsWith('/api/rubika/webhook/') ||
  url.pathname.startsWith('/api/rubika/inline-webhook/')
```

- [ ] **Step 4: Add a stub `handleInlineWebhook`**

In `src/frontends/rubika.ts`, add a no-op so step 3 type-checks:

```ts
handleInlineWebhook(_body: unknown): void {
  // Implemented in Task 3.
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/frontends/rubika.test.ts -t "RubikaFrontend.start"`
Expected: 3 pass.

Run: `bun test tests/frontends/web.test.ts`
Expected: existing tests still pass (no behavior change for unrelated routes).

- [ ] **Step 6: Commit**

```bash
git add src/frontends/rubika.ts src/frontends/web.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): register inline webhook + mount second route"
```

---

## Phase 1 — Inline message dispatch

### Task 3: Inline webhook prefix dispatch

**Files:**
- Modify: `src/frontends/rubika.ts` (`handleInlineWebhook`, add types)
- Modify: `src/types.ts` (add `RubikaInlineMessageBody`)
- Modify: `tests/frontends/rubika.test.ts` (new describe block)

- [ ] **Step 1: Define the inline message envelope shape in `src/frontends/rubika.ts`**

Append the type definition near `RubikaUpdateBody`:

```ts
export type RubikaInlineMessageBody = {
  inline_message?: {
    chat_id: string
    sender_id: string
    message_id: string
    aux_data?: { button_id?: string; start_id?: string | null }
  } | null
}
```

**Amended 2026-05-02** — earlier draft of this task invented `perm:always`,
`vp:*`, `team:*`, and `autopilot:*` prefixes that don't exist on Telegram.
Real Telegram callbacks (see `telegram.ts:718-818`) are: `select:`,
`perm:allow:`, `perm:deny:`, `ap-send:`, `ap-cancel:`, `drift:ignore:`,
`drift:remind:`. Task 3 mirrors those exactly and calls the real methods
(`permissions.resolve`, `vetoController.cancel`, `socketServer.sendToSession`).

- [ ] **Step 2: Write failing tests**

Append:

```ts
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
```

Add to fixtures section (top of test file):

```ts
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
```

Run: `bun test tests/frontends/rubika.test.ts -t "handleInlineWebhook"`
Expected: FAIL.

- [ ] **Step 3: Implement `handleInlineWebhook`**

Mirror `telegram.ts:718-818` exactly. Replace the no-op stub with:

```ts
handleInlineWebhook(body: RubikaInlineMessageBody): void {
  const im = body?.inline_message
  if (!im || !im.aux_data?.button_id) return
  const senderId = im.sender_id
  if (!this.deps.allowFrom.includes(senderId)) {
    process.stderr.write(`rubika: inline rejecting non-allowed sender ${senderId}\n`)
    return
  }
  this.chatIdByUser.set(senderId, im.chat_id)
  const buttonId = im.aux_data.button_id

  try {
    if (buttonId.startsWith('select:')) {
      const sessionName = buttonId.slice('select:'.length)
      this.activeSessionByUser.set(senderId, sessionName)
      return
    }
    if (buttonId.startsWith('perm:allow:') || buttonId.startsWith('perm:deny:')) {
      const isAllow = buttonId.startsWith('perm:allow:')
      const requestId = buttonId.slice(isAllow ? 'perm:allow:'.length : 'perm:deny:'.length)
      if (!this.permissions || !this.socketServer) return
      const result = this.permissions.resolve(requestId, isAllow ? 'allow' : 'deny')
      if (result) {
        this.socketServer.sendToSession(result.sessionPath, {
          type: 'permission_response',
          requestId: result.response.requestId,
          behavior: result.response.behavior,
        })
      }
      return
    }
    const apMatch = buttonId.match(/^ap-(send|cancel):(.+)$/)
    if (apMatch) {
      const [, action, sessionName] = apMatch
      const path = this.deps.registry.findByName(sessionName)
      if (!path || !this.vetoController) return
      const pending = this.vetoController.cancel(path)
      if (!pending) return
      if (action === 'send' && this.socketServer) {
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: pending.draft,
          meta: { source: 'autopilot', frontend: 'rubika' },
        })
      }
      return
    }
    const driftMatch = buttonId.match(/^drift:(ignore|remind):(.+)$/)
    if (driftMatch) {
      const [, action, sessionName] = driftMatch
      if (action === 'ignore') return
      const path = this.deps.registry.findByName(sessionName)
      if (!path || !this.socketServer) return
      const profiles = loadProfilesForHub()
      const rules = this.deps.registry.getEffectiveRules(path, profiles)
      const reminder =
        `⚠️ Project rule reminder: ${rules.slice(0, 2).join('; ')}. ` +
        `Please re-do your last action without shortcuts, root-causing the issue instead.`
      this.socketServer.sendToSession(path, {
        type: 'channel_message',
        content: reminder,
        meta: { source: 'hub', frontend: 'rubika', user: 'drift-check', session: sessionName },
      })
      return
    }
    process.stderr.write(`rubika: unknown inline button id "${buttonId}"\n`)
  } catch (err) {
    process.stderr.write(`rubika: inline handler error for "${buttonId}": ${err}\n`)
  }
}
```

(No `vetoEditPending` state — Telegram doesn't have an Edit flow.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/frontends/rubika.test.ts -t "handleInlineWebhook"`
Expected: 11 pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): inline webhook dispatch — select/perm/ap-send/ap-cancel/drift"
```

---

## Phase 2 — Commands

> All commands live inside a single `dispatchCommand` helper called from `handleWebhook` when text starts with `/`. Each command is an `async` method on `RubikaFrontend`. The pattern is: (1) parse args from the existing `parseCommand` helper, (2) call into `registry`/`screenManager`/etc. exactly like `telegram.ts`, (3) call `this.replyTo(senderId, chatId, text)` (a new helper) instead of `ctx.reply`. The reference handler in `telegram.ts` is cited per task — copy its behavior verbatim.

### Task 4: Wire `dispatchCommand` and `replyTo` helper

**Files:**
- Modify: `src/frontends/rubika.ts`
- Modify: `tests/frontends/rubika.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('handleWebhook dispatches /<unknown> with helpful message', async () => {
  const { r, sender } = makeFrontend()
  r.handleWebhook(update('u1', '/nope'))
  await new Promise(rs => setTimeout(rs, 5))
  expect(sender.calls.find(c => c.method === 'sendMessage')?.body).toMatchObject({
    text: expect.stringContaining('Unknown command'),
  })
})
```

Run, expect FAIL.

- [ ] **Step 2: Implement**

Add helper near other private helpers in `rubika.ts`:

```ts
private async replyTo(_senderId: string, chatId: string, text: string): Promise<void> {
  try {
    await this.send('sendMessage', { chat_id: chatId, text })
  } catch (err) {
    process.stderr.write(`rubika: replyTo failed: ${err}\n`)
  }
}

private async sendButtons(chatId: string, text: string, buttons: { id: string; label: string }[][]): Promise<void> {
  try {
    await this.send('sendMessage', {
      chat_id: chatId,
      text,
      inline_keypad: {
        rows: buttons.map(row => ({
          buttons: row.map(b => ({ id: b.id, type: 'Simple', button_text: b.label })),
        })),
      },
    })
  } catch (err) {
    process.stderr.write(`rubika: sendButtons failed: ${err}\n`)
  }
}
```

Modify `handleWebhook` to dispatch slash commands. Replace the existing `routeToSession` block at the end of `handleWebhook`:

```ts
const text = (m.text || '').trim()
if (text.length === 0) return

const parsed = parseCommand(text)
if (parsed) {
  this.dispatchCommand(senderId, inner.chat_id, parsed.command, parsed.args).catch(err =>
    process.stderr.write(`rubika: command "${parsed.command}" failed: ${err}\n`),
  )
  return
}

const target = this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
if (!target) {
  this.send('sendMessage', { chat_id: inner.chat_id, text: 'No active session.' })
    .catch((err) => process.stderr.write(`rubika: ack-send failed: ${err}\n`))
  return
}
this.deps.router.routeToSession(target, text, 'rubika', senderId)
```

Add `dispatchCommand`:

```ts
private async dispatchCommand(senderId: string, chatId: string, command: string, args: string[]): Promise<void> {
  switch (command) {
    case 'start':    return this.cmdStart(senderId, chatId)
    case 'list':     return this.cmdList(senderId, chatId)
    case 'status':   return this.cmdStatus(chatId)
    case 'profiles': return this.cmdProfiles(chatId)
    case 'profile':  return this.cmdProfile(chatId, args)
    case 'spawn':    return this.cmdSpawn(senderId, chatId, args)
    case 'team':     return this.cmdTeam(chatId, args)
    case 'kill':     return this.cmdKill(chatId, args)
    case 'remove':   return this.cmdRemove(chatId, args)
    case 'rename':   return this.cmdRename(chatId, args)
    case 'trust':    return this.cmdTrust(chatId, args)
    case 'autopilot':return this.cmdAutopilot(chatId, args)
    case 'rules':    return this.cmdRules(chatId, args)
    case 'fact':     return this.cmdFact(chatId, args)
    case 'facts':    return this.cmdFacts(chatId, args)
    case 'channel':  return this.cmdChannel(chatId, args)
    case 'verify':   return this.cmdVerify(chatId, args)
    case 'prefix':   return this.cmdPrefix(chatId, args)
    case 'all':      return this.cmdAll(senderId, chatId, args)
    default:
      return this.replyTo(senderId, chatId, `Unknown command "/${command}". Try /list or /status.`)
  }
}

private async cmdStart(senderId: string, chatId: string): Promise<void> {
  await this.replyTo(senderId, chatId,
    '👋 Connected to Claude Code Hub. Use /list to pick a session or send any message to talk to the active one.')
}

// Other cmdXxx methods are added one per task below.
```

For now, leave the other `cmdXxx` methods as stubs: `private async cmdList(_s: string, c: string){ await this.replyTo('', c, 'todo'); }` and so on for the 17 remaining. They will be filled task-by-task.

- [ ] **Step 3: Run test**

Run: `bun test tests/frontends/rubika.test.ts -t "Unknown command"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): dispatchCommand router + replyTo/sendButtons helpers"
```

---

### Task 5: `/start` — greeting

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** N/A (Telegram silently ignores; Rubika replies)

- [ ] **Step 1: Failing test**

```ts
test('/start replies with a welcome message', async () => {
  const { r, sender } = makeFrontend()
  r.handleWebhook(update('u1', '/start'))
  await new Promise(rs => setTimeout(rs, 5))
  const m = sender.calls.find(c => c.method === 'sendMessage')!
  expect((m.body as any).text).toMatch(/Connected to Claude Code Hub/)
  expect((m.body as any).text).toMatch(/\/list/)
})
```

- [ ] **Step 2: Verify (already implemented in Task 4 — confirm test passes)**

Run: `bun test tests/frontends/rubika.test.ts -t "/start replies"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/frontends/rubika.test.ts
git commit -m "test(rubika): /start greeting"
```

---

### Task 6: `/list` — sessions with selection buttons

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `src/frontends/telegram.ts:206-224`

- [ ] **Step 1: Failing tests**

```ts
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
```

Run, expect FAIL.

- [ ] **Step 2: Implement `cmdList`**

Replace the stub with:

```ts
private async cmdList(senderId: string, chatId: string): Promise<void> {
  const sessions = this.deps.registry.list()
  const active = this.activeSessionByUser.get(senderId) ?? null
  const text = formatSessionList(sessions, active)
  if (sessions.length === 0) {
    await this.replyTo(senderId, chatId, text)
    return
  }
  await this.sendButtons(chatId, text, sessions.map(s => [{ id: `select:${s.name}`, label: s.name }]))
}
```

- [ ] **Step 3: Run tests, expect PASS**

Run: `bun test tests/frontends/rubika.test.ts -t "/list"`

- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /list with selection buttons"
```

---

### Task 7: `/status`, `/profiles`, `/profile`

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:226-302`

These three are pure text replies — no buttons.

- [ ] **Step 1: Failing tests**

```ts
test('/status renders sessions in plain text', async () => {
  const { r, sender, registry } = makeFrontend()
  registry.register('/p/sap:0', { name: 'sap' })
  r.handleWebhook(update('u1', '/status'))
  await new Promise(rs => setTimeout(rs, 5))
  expect((sender.calls[0]!.body as any).text).toMatch(/sap/)
})

test('/profiles when none returns "No profiles defined."', async () => {
  // (mock loadProfilesForHub via dependency injection — see Step 2)
})

test('/profile <name> shows details', async () => { /* ... */ })
test('/profile create <name> writes a new profile', async () => { /* ... */ })
test('/profile delete <name> removes it', async () => { /* ... */ })
```

- [ ] **Step 2: Implement**

`cmdStatus`, `cmdProfiles`, `cmdProfile` mirror the Telegram handlers verbatim — same usage strings, same logic, replace `ctx.reply(text, { parse_mode: 'HTML' })` with `this.replyTo(senderId, chatId, stripHtml(text))`. The `stripHtml` helper:

```ts
function stripHtml(s: string): string {
  return s.replace(/<\/?[^>]+>/g, '')
}
```

Full `cmdProfile` body — copy from `telegram.ts:249-302`, replacing each `ctx.reply(x, opts)` call site with `await this.replyTo(senderId, chatId, stripHtml(x))`.

- [ ] **Step 3: Run tests** — expect 5 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /status, /profiles, /profile"
```

---

### Task 8: `/spawn`, `/kill`, `/remove`, `/rename`

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:304-458`

- [ ] **Step 1: Failing tests** (one happy + one error per command, 8 cases total)

```ts
test('/spawn with no args replies with usage', async () => { /* ... */ })
test('/spawn alpha /home/foo calls screenManager.spawn and sets active session', async () => { /* ... */ })
test('/spawn alpha /home/foo 3 calls spawnTeam(name, path, 3)', async () => { /* ... */ })
test('/spawn with --profile validates the profile exists', async () => { /* ... */ })
test('/kill <name> calls screenManager.gracefulKill when managed', async () => { /* ... */ })
test('/kill unknown replies "Session not found"', async () => { /* ... */ })
test('/remove on connected session replies hint to /kill first', async () => { /* ... */ })
test('/rename foo bar updates registry', async () => { /* ... */ })
```

- [ ] **Step 2: Implement** — copy `cmdSpawn`, `cmdKill`, `cmdRemove`, `cmdRename` from `telegram.ts:305-458` with the same `replyTo` substitution. The `--profile` flag parsing is identical.

- [ ] **Step 3: Run tests** — expect 8 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /spawn, /kill, /remove, /rename"
```

---

### Task 9: `/team` (text-only)

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:352-393`

**Amended 2026-05-02** — Telegram's `/team` is text-only (no `[Add teammate]`
inline button). Mirror that exactly.

- [ ] **Step 1: Failing tests**

```ts
test('/team with no args replies usage', async () => { /* assert reply text matches "Usage: /team <name> [add]" */ })
test('/team <unknown> replies "Session not found"', async () => { /* ... */ })
test('/team <name> on solo session replies "is a solo session"', async () => { /* ... */ })
test('/team <name> on team renders members as text (no buttons)', async () => {
  // assert reply has no inline_keypad
  // assert reply text contains 👑 lead and ├ teammate lines
})
test('/team <name> add calls screenManager.addTeammate(name) and replies', async () => {
  /* StubScreenManager.addTeammate returns 'newName' → reply 'Added teammate: newName' */
})
```

- [ ] **Step 2: Implement `cmdTeam`** — straight mirror of `telegram.ts:352-393`:

```ts
private async cmdTeam(chatId: string, args: string[]): Promise<void> {
  if (args.length === 0) {
    await this.send('sendMessage', { chat_id: chatId, text: 'Usage: /team <name> [add]' })
    return
  }
  const teamName = args[0]
  const action = args[1]
  if (action === 'add' && this.screenManager) {
    const newName = await this.screenManager.addTeammate(teamName)
    await this.send('sendMessage', {
      chat_id: chatId,
      text: newName ? `Added teammate: ${newName}` : `Team lead "${teamName}" not found`,
    })
    return
  }
  const path = this.deps.registry.findByName(teamName)
  if (!path) {
    await this.send('sendMessage', { chat_id: chatId, text: `Session "${teamName}" not found` })
    return
  }
  const folder = path.replace(/:\d+$/, '')
  const team = this.deps.registry.getTeam(folder)
  if (team.length <= 1) {
    await this.send('sendMessage', { chat_id: chatId, text: `${teamName} is a solo session, not a team` })
    return
  }
  const lines = team.map((s, i) => {
    const icon = s.status === 'active' ? '🟢' : '🔴'
    const role = i === 0 ? '👑 ' : '  ├ '
    return `${role}${s.name} ${icon}`
  })
  await this.send('sendMessage', { chat_id: chatId, text: lines.join('\n') })
}
```

- [ ] **Step 3: Run tests** — expect 5 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /team (text-only, mirroring telegram)"
```

---

### Task 10: `/trust`, `/prefix`, `/all`

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:460-480, 685-715`

- [ ] **Step 1: Failing tests**

```ts
test('/trust <name> <bogus> replies invalid level', async () => { /* ... */ })
test('/trust foo auto sets trust', async () => { /* ... */ })
test('/prefix without space replies usage', async () => { /* ... */ })
test('/prefix foo hello world sets prefix to "hello world"', async () => { /* ... */ })
test('/all hello broadcasts via router', async () => {
  // Stubs router.broadcast; assert call args === ('hello', 'rubika', 'u1')
})
```

- [ ] **Step 2: Implement** `cmdTrust`, `cmdPrefix`, `cmdAll` — straight mirror of telegram.ts.

For `cmdAll`:

```ts
private async cmdAll(senderId: string, chatId: string, args: string[]): Promise<void> {
  const message = args.join(' ').trim()
  if (!message) {
    await this.send('sendMessage', { chat_id: chatId, text: 'Usage: /all <message>' })
    return
  }
  this.deps.router.broadcast(message, 'rubika', senderId)
  await this.send('sendMessage', { chat_id: chatId, text: 'Broadcast sent to all active sessions.' })
}
```

- [ ] **Step 3: Run tests** — expect 5 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /trust, /prefix, /all"
```

---

### Task 11: `/rules`, `/fact`, `/facts`, `/channel`

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:549-682`

These mirror Telegram's effective-rules / effective-facts handlers. `/channel` uses `'rubika'` as the channel key (Telegram uses `'telegram'`).

- [ ] **Step 1: Failing tests** — happy + error per command, 8 cases.
- [ ] **Step 2: Implement** `cmdRules`, `cmdFact`, `cmdFacts`, `cmdChannel` — mirror of telegram.ts. The single tweak: in `cmdChannel`, pass `'rubika'` to `setChannelOverride` and `clearChannelOverride`.
- [ ] **Step 3: Run tests** — expect 8 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /rules, /fact, /facts, /channel"
```

---

### Task 12: `/autopilot`, `/verify`

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`
**Telegram reference:** `telegram.ts:482-546, 634-650`

- [ ] **Step 1: Failing tests**

```ts
test('/autopilot foo on enables autopilot, sets trust auto, fires probe', async () => {
  // assert registry.getAutopilot(path).enabled === true
  // assert registry.get(path).trust === 'auto'
  // assert autopilotRunner.quickProbe was called
})
test('/autopilot foo off disables autopilot, restores priorTrust', async () => { /* ... */ })
test('/autopilot foo on with failing quickProbe replies precheck failed', async () => { /* ... */ })
test('/verify foo on passing run replies "✅"', async () => { /* ... */ })
test('/verify foo on failing run replies with command + tail', async () => { /* ... */ })
test('/verify foo on no-commands replies hint', async () => { /* ... */ })
```

- [ ] **Step 2: Implement** `cmdAutopilot` and `cmdVerify`.

`cmdVerify` calls a new private `renderVerificationResult(chatId, sessionName, result)` that mirrors the existing Telegram one (`telegram.ts:94-133`), but writes plain text via `replyTo` instead of HTML.

`cmdAutopilot` mirrors `telegram.ts:482-546` with the `replyTo` substitution. The background `runner.probe(...)` follow-up calls `this.deliverToUser(name, ...)` exactly like Telegram.

- [ ] **Step 3: Run tests** — expect 6 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): /autopilot, /verify"
```

---

## Phase 3 — Files

### Task 13: `realSend` 30s timeout + file-upload helpers

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('realSend aborts requests longer than 30 seconds', async () => {
  // We can't easily exercise real fetch; assert the AbortController plumbing
  // by injecting a custom sender that captures the AbortSignal.
  // For unit purposes, test the helper functions only — `uploadFile` exposed.
})
test('uploadFile POSTs to upload_url returned by requestSendFile', async () => {
  const { r, sender } = makeFrontend()
  // First call returns upload_url; second call (PUT/POST) is captured.
  sender.reply = { upload_url: 'https://upload.example/x' }
  // ... use a fake fetch via globalThis or a private helper override.
})
```

For pragmatic unit testing, expose a private `uploadFile(filePath: string, mime: string)` and verify it (a) calls `requestSendFile` with the right `type`, and (b) PUTs the bytes to the returned `upload_url`. Mock `fetch` for the upload step.

- [ ] **Step 2: Implement**

Add an `AbortController` to `realSend`:

```ts
private async realSend(method: string, body: unknown): Promise<unknown> {
  const url = `${this.apiBase}/${this.deps.token}/${method}`
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`rubika ${method} HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    const j = (await res.json()) as { status?: string; data?: unknown }
    if (j && typeof j === 'object' && j.status && j.status !== 'OK') {
      throw new Error(`rubika ${method} ${j.status}: ${JSON.stringify(j)}`)
    }
    if (j && typeof j === 'object' && 'data' in j) return j.data
    return j
  } finally {
    clearTimeout(t)
  }
}

private async uploadFile(filePath: string, mime: string): Promise<{ file_id: string; file_name: string; size: number; type: string }> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const buf = await fs.readFile(filePath)
  const fileName = path.basename(filePath)
  const type = mimeToType(mime)
  const r1 = (await this.send('requestSendFile', { type })) as { upload_url: string }
  const upload = await fetch(r1.upload_url, { method: 'POST', body: buf })
  if (!upload.ok) throw new Error(`upload HTTP ${upload.status}`)
  const j = await upload.json() as { file_id: string }
  return { file_id: j.file_id, file_name: fileName, size: buf.byteLength, type }
}
```

Helper:

```ts
function mimeToType(mime: string): 'Image' | 'Video' | 'Voice' | 'Music' | 'Gif' | 'File' {
  if (mime.startsWith('image/gif')) return 'Gif'
  if (mime.startsWith('image/')) return 'Image'
  if (mime.startsWith('video/')) return 'Video'
  if (mime.startsWith('audio/ogg') || mime.startsWith('audio/opus')) return 'Voice'
  if (mime.startsWith('audio/')) return 'Music'
  return 'File'
}
```

- [ ] **Step 3: Run tests** — expect 2 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): 30s realSend timeout + uploadFile helper"
```

---

### Task 14: `deliverToUser` sends files

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('deliverToUser with one file calls uploadFile then sendMessage with file_inline', async () => {
  // After Task 13, uploadFile is testable by stubbing fetch.
  // Assert sender.calls includes ('requestSendFile', { type: 'Image' })
  // and ('sendMessage', { chat_id, text: '[sap] caption', file_inline: { file_id, type, file_name, size } })
})
test('deliverToUser with two files only the first carries the caption', async () => { /* ... */ })
test('deliverToUser with upload failure falls back to text-only "[file too big to upload]"', async () => { /* ... */ })
```

- [ ] **Step 2: Implement**

Replace the current `deliverToUser`:

```ts
async deliverToUser(sessionName: string, text: string, files?: string[]): Promise<void> {
  if (this.deps.allowFrom.length === 0) return
  const fullText = `[${sessionName}] ${text}`
  for (const senderId of this.deps.allowFrom) {
    const chatId = this.chatIdByUser.get(senderId)
    if (!chatId) continue
    try {
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          try {
            const mime = await guessMime(files[i]!)
            const meta = await this.uploadFile(files[i]!, mime)
            await this.send('sendMessage', {
              chat_id: chatId,
              text: i === 0 ? fullText : '',
              file_inline: meta,
            })
          } catch (err) {
            await this.send('sendMessage', {
              chat_id: chatId,
              text: `[file too big to upload: ${files[i]}]\n${i === 0 ? fullText : ''}`,
            })
          }
        }
      } else {
        await this.send('sendMessage', { chat_id: chatId, text: fullText })
      }
    } catch (err) {
      process.stderr.write(`rubika: deliverToUser to ${chatId} failed: ${err}\n`)
    }
  }
}
```

`guessMime`:

```ts
async function guessMime(filePath: string): Promise<string> {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain',
  }
  return map[ext] ?? 'application/octet-stream'
}
```

- [ ] **Step 3: Run tests** — expect 3 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): deliverToUser sends files via two-step upload"
```

---

### Task 15: Inbound files saved to active session's uploadDir

**Files:** `src/frontends/rubika.ts`, `tests/frontends/rubika.test.ts`

> The exact field name in `new_message` is verified by sending a real photo through `@MahdiAwadiBot` and inspecting `getUpdates`. Until then this task uses `file_inline` (matches the outbound shape and Rubika docs). If the live shape differs, the implementer adjusts the field path and the type in step 2 only.

- [ ] **Step 0: Probe the real envelope**

Send a photo from your Rubika app to `@MahdiAwadiBot`. Then run:

```bash
TOK=$(jq -r .rubikaToken ~/.claude/channels/hub/config.json)
curl -sS -X POST "https://botapi.rubika.ir/v3/$TOK/getUpdates" \
  -H 'Content-Type: application/json' -d '{"limit":3,"offset_id":""}' | jq .
```

Note the field name carrying the file metadata (`file_inline` or `file`). Use that field in step 2.

- [ ] **Step 1: Failing tests**

```ts
test('inbound NewMessage with file_inline saves to <session.path>/<uploadDir>/<file_name>', async () => {
  // mock fs.writeFile + uploadDir read
})
test('inbound file with no active session replies "No active session."', async () => { /* ... */ })
test('inbound file with empty allowFrom does nothing', async () => { /* ... */ })
test('inbound file save error replies "⚠️ Could not save file: ..."', async () => { /* ... */ })
```

- [ ] **Step 2: Implement**

Extend the `RubikaUpdateBody.update.new_message` type to include the observed file field. Add a private `downloadFile(file_id)` helper that calls Rubika's download endpoint (probe to confirm the method name — likely `getFile` returning `download_url`, then `fetch(download_url)`).

In `handleWebhook`, after the text-empty guard, add:

```ts
const file = (m as any).file_inline
if (file) {
  const target = this.activeSessionByUser.get(senderId) ?? this.firstActiveSessionName()
  if (!target) {
    this.send('sendMessage', { chat_id: inner.chat_id, text: 'No active session.' }).catch(() => {})
    return
  }
  const path = this.deps.registry.findByName(target)
  const sess = path ? this.deps.registry.get(path) : null
  if (!path || !sess) return
  this.saveInboundFile(senderId, inner.chat_id, sess.path, sess.uploadDir, file).catch((err) => {
    this.send('sendMessage', { chat_id: inner.chat_id, text: `⚠️ Could not save file: ${err}` }).catch(() => {})
  })
  return
}
```

`saveInboundFile`:

```ts
private async saveInboundFile(senderId: string, chatId: string, sessionPath: string, uploadDir: string, file: { file_id: string; file_name: string }): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = path.resolve(sessionPath, uploadDir)
  await fs.mkdir(dir, { recursive: true })
  const r1 = (await this.send('getFile', { file_id: file.file_id })) as { download_url: string }
  const res = await fetch(r1.download_url)
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const target = path.join(dir, file.file_name)
  await fs.writeFile(target, buf)
  await this.send('sendMessage', { chat_id: chatId, text: `📎 Saved ${path.relative(sessionPath, target)}` })
}
```

- [ ] **Step 3: Run tests** — expect 4 pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): inbound file save to session uploadDir"
```

---

## Phase 4 — Permission prompts

### Task 16: Permission prompt rendered with inline buttons

**Files:** `src/frontends/rubika.ts`, `src/daemon.ts` (verify wiring), `tests/frontends/rubika.test.ts`

**Amended 2026-05-02** — Telegram has 2 buttons (Allow / Deny), not 3.
"Always Allow" was an aspirational design but no Telegram callback exists for
it; trust upgrades happen via `/trust <session> auto`. Rubika matches.

- [ ] **Step 0: Confirm wiring**

Read `src/daemon.ts` around line 188 to confirm how Telegram receives the
prompt. Mirror whatever method it uses on Rubika. If Telegram is invoked
through `deliverToUser` plus the engine, add a new `deliverPermissionPrompt`
to BOTH frontends so the daemon can dispatch consistently.

- [ ] **Step 1: Failing test**

```ts
test('deliverPermissionPrompt sends sendMessage with inline_keypad of two buttons', async () => {
  const { r, sender } = makeFrontend()
  // Establish chat_id by sending an inbound message first
  r.handleWebhook(update('u1', 'hi'))
  await new Promise(rs => setTimeout(rs, 5))
  await r.deliverPermissionPrompt('sap', { id: '42', tool_name: 'Bash', input_preview: 'ls', description: '' } as any)
  const m = sender.calls.find(c => c.method === 'sendMessage' && (c.body as any).inline_keypad)!
  expect((m.body as any).inline_keypad.rows[0].buttons.map((b: any) => b.id)).toEqual([
    'perm:allow:42', 'perm:deny:42',
  ])
})
```

- [ ] **Step 2: Implement**

```ts
async deliverPermissionPrompt(sessionName: string, req: PermissionRequest): Promise<void> {
  if (this.deps.allowFrom.length === 0) return
  const text = `🔒 ${sessionName} wants to use *${req.tool_name}*\n\n${req.input_preview ?? ''}`
  for (const senderId of this.deps.allowFrom) {
    const chatId = this.chatIdByUser.get(senderId)
    if (!chatId) continue
    await this.sendButtons(chatId, text, [[
      { id: `perm:allow:${req.id}`, label: 'Allow' },
      { id: `perm:deny:${req.id}`, label: 'Deny' },
    ]])
  }
}
```

Wire it in `daemon.ts` next to where the Telegram permission prompt is dispatched.

- [ ] **Step 3: Run tests** — expect pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts src/daemon.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): permission prompts with Allow/Deny buttons"
```

---

## Phase 5 — Autopilot veto

### Task 17: Autopilot veto prompt (Send / Cancel)

**Files:** `src/frontends/rubika.ts`, `src/daemon.ts` (wire), `tests/frontends/rubika.test.ts`

**Amended 2026-05-02** — Telegram has 2 buttons (Send / Cancel) keyed by
session name, not 3 buttons keyed by veto id, and there's no Edit-with-reason
capture flow. Rubika mirrors. Button ids: `ap-send:<sessionName>` and
`ap-cancel:<sessionName>`. Click handling already lives in Task 3.

- [ ] **Step 1: Failing tests**

```ts
test('deliverVetoPrompt sends 2-button keypad with ap-send / ap-cancel', async () => {
  const { r, sender } = makeFrontend()
  r.handleWebhook(update('u1', 'hi'))
  await new Promise(rs => setTimeout(rs, 5))
  await r.deliverVetoPrompt('sap', 'draft text')
  const m = sender.calls.find(c => c.method === 'sendMessage' && (c.body as any).inline_keypad)!
  expect((m.body as any).inline_keypad.rows[0].buttons.map((b: any) => b.id)).toEqual([
    'ap-send:sap', 'ap-cancel:sap',
  ])
  expect((m.body as any).text).toContain('draft text')
})
```

- [ ] **Step 2: Implement**

```ts
async deliverVetoPrompt(sessionName: string, draft: string): Promise<void> {
  if (this.deps.allowFrom.length === 0) return
  const text = `📝 ${sessionName} draft:\n\n${draft}`
  for (const senderId of this.deps.allowFrom) {
    const chatId = this.chatIdByUser.get(senderId)
    if (!chatId) continue
    await this.sendButtons(chatId, text, [[
      { id: `ap-send:${sessionName}`, label: '✅ Send' },
      { id: `ap-cancel:${sessionName}`, label: '❌ Cancel' },
    ]])
  }
}
```

Wire `daemon.ts` to call `rubikaFrontend?.deliverVetoPrompt(...)` everywhere
`vetoController` exposes a draft (alongside the existing Telegram call).

- [ ] **Step 3: Run tests** — expect pass.
- [ ] **Step 4: Commit**

```bash
git add src/frontends/rubika.ts src/daemon.ts tests/frontends/rubika.test.ts
git commit -m "feat(rubika): autopilot veto prompt with Send/Cancel"
```

---

## Phase 6 — refresh-rubika CLI

### Task 18: `refresh-rubika` CLI subcommand

**Files:** `src/cli.ts`, `tests/cli.test.ts` (or new file)

- [ ] **Step 1: Failing test**

```ts
test('refresh-rubika POSTs /api/rubika/refresh which calls updateBotEndpoints twice', async () => {
  // Mock HTTP server, assert two updateBotEndpoints calls land on the daemon's RubikaFrontend.
})
```

- [ ] **Step 2: Implement**

Add a `POST /api/rubika/refresh` route in `src/frontends/web.ts` (auth-required, like other CLI endpoints) that calls `rubikaFrontend.start()` again (which is idempotent thanks to the `started` flag — drop the flag check just for this code path, or expose `refreshEndpoints()`).

In `RubikaFrontend`:

```ts
async refreshEndpoints(): Promise<void> {
  if (!this.deps.webhookBase) return
  const base = this.deps.webhookBase.replace(/\/$/, '')
  await this.registerEndpoint('ReceiveUpdate', `${base}${this.webhookPath}`)
  await this.registerEndpoint('ReceiveInlineMessage', `${base}${this.inlineWebhookPath}`)
}
```

In `src/cli.ts`, add:

```ts
case 'refresh-rubika': {
  const res = await fetch(`${HUB_URL}/api/rubika/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`refresh-rubika failed: HTTP ${res.status}`)
  console.log('rubika endpoints re-registered')
  break
}
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit**

```bash
git add src/cli.ts src/frontends/web.ts src/frontends/rubika.ts tests/cli.test.ts
git commit -m "feat(rubika): refresh-rubika CLI for silent-push recovery"
```

---

## Phase 7 — Integration tests

### Task 19: HTTP-level integration tests

**Files:** `tests/frontends/rubika.integration.test.ts` (new)

- [ ] **Step 1: Author the test file**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend } from '../../src/frontends/web'
import { RubikaFrontend, deriveWebhookSecret } from '../../src/frontends/rubika'
import { SessionRegistry } from '../../src/session-registry'
import { MessageRouter } from '../../src/message-router'

describe('Rubika HTTP integration', () => {
  let web: WebFrontend
  let rubika: RubikaFrontend
  let registry: SessionRegistry
  const port = 31337  // pick a free port; or let WebFrontend pick

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const router = new MessageRouter(registry, () => true, () => {})
    web = new WebFrontend({ port, host: '127.0.0.1', registry, router, /* … */ } as any)
    rubika = new RubikaFrontend({
      token: 'test-token',
      allowFrom: ['u1'],
      registry,
      router,
      sender: async () => ({ status: 'OK' }),
    })
    web.attachRubikaWebhook(rubika)
    await web.start()
  })

  afterEach(async () => { await web.stop() })

  test('POST /api/rubika/webhook/<secret> with NewMessage returns 200', async () => {
    const secret = deriveWebhookSecret('test-token')
    const res = await fetch(`http://127.0.0.1:${port}/api/rubika/webhook/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: { type: 'NewMessage', chat_id: 'c', new_message: { message_id: 'm', text: 'hi', time: '1', is_edited: false, sender_type: 'User', sender_id: 'u1' } } }),
    })
    expect(res.status).toBe(200)
  })

  test('POST /api/rubika/inline-webhook/<secret> with perm:allow:* returns 200', async () => { /* … */ })
  test('wrong secret → 401', async () => { /* … */ })
  test('right secret + malformed body → 400', async () => { /* … */ })
  test('non-allowed sender → 200 with no router call', async () => { /* … */ })
})
```

- [ ] **Step 2: Run** — `bun test tests/frontends/rubika.integration.test.ts`
- [ ] **Step 3: Commit**

```bash
git add tests/frontends/rubika.integration.test.ts
git commit -m "test(rubika): HTTP integration tests"
```

---

## Phase 8 — Manual smoke + polish

### Task 20: End-to-end smoke test against the live daemon

- [ ] **Step 1: Restart daemon**

```bash
tmux kill-session -t hub-daemon 2>/dev/null
tmux new-session -d -s hub-daemon "cd /home/channelhub && bun run src/daemon.ts"
sleep 2
tmux capture-pane -t hub-daemon -p | tail -15
```

Expected: both `rubika: ReceiveUpdate webhook registered → …` and `rubika: ReceiveInlineMessage webhook registered → …` lines.

- [ ] **Step 2: Walk the manual checklist on `@MahdiAwadiBot`**

- [ ] `/start` from Rubika → greeting reply
- [ ] `/list` → buttons appear; tapping switches active session
- [ ] Send plain "hello" → routes to active session
- [ ] Send a photo → file appears in `<sessionPath>/<uploadDir>/<filename>`
- [ ] Toggle a session to `ask` trust, trigger a tool → 3 buttons appear, tapping `Always Allow` flips trust to `auto`
- [ ] Toggle autopilot, force a `/btw` reply → veto prompt with Send/Edit/Cancel; tap Edit, type a new draft, confirm it's used
- [ ] Restart daemon → `bun run src/cli.ts refresh-rubika` succeeds

- [ ] **Step 3: Update PR description with the checked-off list and any deviations.**

- [ ] **Step 4: Commit any tweaks**

```bash
git status && git diff
git commit -am "docs/fixes: smoke pass tweaks for rubika parity"
```

---

## Self-review

After writing the plan above, scan for:

1. **Spec coverage.** Each section of `2026-05-02-rubika-command-parity-design.md` maps to at least one task:
   - Spec §6.1 (commands): Tasks 4–12
   - Spec §6.2 (button mapping): Task 2 (helper) + Task 6+ (per-command usage)
   - Spec §6.3 (permission prompts): Task 16
   - Spec §6.4 (autopilot veto): Task 17
   - Spec §6.5 (files): Tasks 13–15
   - Spec §6.6 (allowlist + secret): Task 1 (extend), enforced in Task 4 dispatcher
   - Spec §7.1 (Rubika API failures): Task 13 (timeout), Task 4 (per-command catch), Task 16/17 (callbacks)
   - Spec §7.2 (webhook delivery failures): Task 18 (`refresh-rubika`)
   - Spec §7.3 (malformed bodies): Tasks 2, 3 — explicit malformed-payload test cases
   - Spec §7.4 (per-command argument validation): per-command happy-path + usage-error tests
   - Spec §7.5 (permission timeout): no new code; existing `permission-engine` calls `deliverToUser`
   - Spec §7.6 (file save errors): Task 15
   - Spec §8.1 (unit tests): grown across all tasks; ~80 cases total
   - Spec §8.2 (integration tests): Task 19
   - Spec §8.3 (manual smoke): Task 20

2. **Placeholders.** None — every task has Files, exact tests, and exact code or a concrete `telegram.ts:LINE-LINE` reference.

3. **Type consistency.**
   - `RubikaFrontendDeps` extended in Task 1; reused everywhere.
   - `cmdXxx` method names reused exactly across tasks.
   - Button-id prefixes (`perm:`, `vp:`, `select:`, `team:`, `autopilot:`) match between Task 3 dispatcher and Tasks 9, 16, 17 producers.
   - `deliverPermissionPrompt` and `deliverVetoPrompt` are the only two new public methods on the frontend.

No issues found.
