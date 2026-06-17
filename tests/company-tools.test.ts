// tests/company-tools.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { handleCompanyTool, COMPANY_TOOL_DEFS } from '../src/company/tools'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('company tools', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-tools-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('defs cover the 8 tools', () => {
    const names = COMPANY_TOOL_DEFS.map(t => t.name)
    const expectedTools = ['company_get_tasks','company_create_task','company_claim_task','company_update_task','company_create_handoff','company_write_memory','company_search_memory','company_request_approval'] as const
    for (const n of expectedTools) {
      expect(names).toContain(n)
    }
  })

  test('create_task then get_tasks for caller dept', async () => {
    await handleCompanyTool(store, 'secretary', 'company_create_task', { title: 'Brief Mahdi', dept_id: 'secretary' })
    const out = await handleCompanyTool(store, 'secretary', 'company_get_tasks', { status: 'assigned' })
    expect(out).toContain('Brief Mahdi')
  })

  test('request_approval creates a pending approval', async () => {
    const out = await handleCompanyTool(store, 'sales', 'company_request_approval', { kind: 'send_external', summary: 'send email' })
    expect(out).toContain('appr_')
    expect(store.listPendingApprovals().length).toBe(1)
  })

  test('emits_on_done auto-handoff creates follow-up task in target dept', async () => {
    await handleCompanyTool(store, 'ops', 'company_create_task', { title: 'Prepare report', dept_id: 'ops', emits_on_done: 'sales' })
    const tasks = store.listTasks({ dept_id: 'ops' })
    expect(tasks.length).toBe(1)
    const taskId = tasks[0].id
    const out = await handleCompanyTool(store, 'ops', 'company_update_task', { id: taskId, status: 'done' })
    expect(out).toContain('handed off to sales')
    const salesTasks = store.listTasks({ dept_id: 'sales' })
    expect(salesTasks.length).toBeGreaterThan(0)
  })
})
