// tests/frontends/web.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend, signSession } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'

const TOKEN = 'test-bot-token'
const ALLOWED_USER = '123'

function authCookie(userId = ALLOWED_USER): string {
  return `operant_session=${signSession(userId, TOKEN)}`
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
    expect(data.pane).toContain('pane for operant-frontend')
    expect(data.pane).toContain('120 lines')
  })

  test('GET /api/peek/:name returns 404 when tmux session is missing', async () => {
    await web.stop()
    const stubScreen = {
      capturePaneWithScrollback: async () => { throw new Error('No tmux session "operant-frontend"') },
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

  // === Company engine routes ===============================================

  test('GET /api/company/board returns 503 when no companyStore', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/board`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(503)
    const data = await res.json() as any
    expect(data.error).toContain('Company store not available')
  })

  test('GET /api/company/departments returns 503 when no companyStore', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/departments`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(503)
  })

  test('GET /api/company/approvals returns 503 when no companyStore', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/approvals`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(503)
  })

  test('POST /api/company/approvals/resolve returns 503 when no companyStore', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/approvals/resolve`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'appr_abc', decision: 'approved' }),
    })
    expect(res.status).toBe(503)
  })
})

describe('WebFrontend — company store wired', () => {
  let web: WebFrontend
  let registry: SessionRegistry
  let mockStore: any

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    // Minimal stub that satisfies the CompanyStore interface for these tests.
    mockStore = {
      listTasks: () => [{ id: 'task_1', title: 'Test task', status: 'inbox' }],
      listDepartments: () => [{ id: 'eng', title: 'Engineering', folder: '/home/eng' }],
      listPendingApprovals: () => [{ id: 'appr_1', summary: 'Deploy?', state: 'pending' }],
      resolveApproval: (id: string, decision: string) => {
        if (id === 'appr_1') return { id, dept_id: null, summary: 'Deploy?', state: decision }
        return null
      },
      getDepartment: () => null,
    }
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
      companyStore: mockStore,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/company/board returns task list', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/board`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data.length).toBe(1)
    expect(data[0].id).toBe('task_1')
  })

  test('GET /api/company/departments returns department list', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/departments`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data[0].id).toBe('eng')
  })

  test('GET /api/company/approvals returns pending approvals', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/approvals`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data[0].id).toBe('appr_1')
  })

  test('POST /api/company/approvals/resolve returns ok:true for existing approval', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/approvals/resolve`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'appr_1', decision: 'approved' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })

  test('POST /api/company/approvals/resolve returns ok:false for unknown approval', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/company/approvals/resolve`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'appr_unknown', decision: 'denied' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(false)
  })

  test('POST /api/company/approvals/resolve routes channel_message when dept found', async () => {
    await web.stop()
    registry.register('/home/eng')
    let sentPath: string | null = null
    let sentMsg: any = null
    const stubSocket = {
      sendToSession: (path: string, msg: any) => { sentPath = path; sentMsg = msg },
    }
    const storeWithDept = {
      ...mockStore,
      resolveApproval: (id: string, decision: string) =>
        ({ id, dept_id: 'eng', summary: 'Deploy?', state: decision }),
      getDepartment: (id: string) =>
        id === 'eng' ? { id: 'eng', title: 'Engineering', folder: '/home/eng' } : null,
    }
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: stubSocket as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED_USER],
      taskMonitor: null,
      companyStore: storeWithDept as any,
    })
    await web.start()

    const res = await fetch(`http://localhost:${web.port}/api/company/approvals/resolve`, {
      method: 'POST',
      headers: { Cookie: authCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'appr_1', decision: 'approved' }),
    })
    expect(res.status).toBe(200)
    expect(sentPath).not.toBeNull()
    expect(sentMsg?.type).toBe('channel_message')
    expect(sentMsg?.content).toContain('APPROVED')
    expect(sentMsg?.content).toContain('appr_1')
  })

  test('deliverApprovalRequest broadcasts company_approval to WS clients', () => {
    const broadcasts: any[] = []
    // Spy on broadcastToClients by monkey-patching the internal clients set
    // (we can't subscribe to WS in unit tests, so we reach into the method).
    const origBroadcast = (web as any).broadcastToClients.bind(web)
    ;(web as any).broadcastToClients = (msg: any) => { broadcasts.push(msg); origBroadcast(msg) }

    const fakeApproval = { id: 'appr_x', summary: 'Test', state: 'pending', dept_id: null }
    web.deliverApprovalRequest(fakeApproval as any)
    expect(broadcasts.length).toBe(1)
    expect(broadcasts[0].type).toBe('company_approval')
    expect(broadcasts[0].approval.id).toBe('appr_x')
  })
})
