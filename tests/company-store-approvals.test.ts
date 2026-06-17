import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore approvals', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-ap-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('create -> pending list -> resolve removes from pending', () => {
    const a = store.createApproval({ dept_id: 'sales', kind: 'send_external', summary: 'Send outreach email to OTA partner' })
    expect(store.listPendingApprovals().length).toBe(1)
    const r = store.resolveApproval(a.id, 'approved', 'looks good')!
    expect(r.state).toBe('approved')
    expect(store.listPendingApprovals().length).toBe(0)
    expect(store.resolveApproval('missing', 'denied')).toBeNull()
  })
})
