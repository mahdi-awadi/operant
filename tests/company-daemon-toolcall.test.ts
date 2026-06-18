// tests/company-daemon-toolcall.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { CompanyStore } from '../src/company/store'
import { deptIdForPath } from '../src/daemon'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('deptIdForPath', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-dmn-')); const h = openOperantDb(dir); close = h.close; store = new CompanyStore(h.db)
    store.upsertDepartment({ id: 'secretary', title: 'COS', folder: '/home/company/desks/secretary', reports_to: 'mahdi', manages: [], profile_name: 'careful', skills: [], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('maps folder to dept id, null if unknown', () => {
    expect(deptIdForPath('/home/company/desks/secretary', store)).toBe('secretary')
    expect(deptIdForPath('/home/eticket-v3', store)).toBeNull()
  })

  test('resolves dept id from session-key form (folder:index)', () => {
    expect(deptIdForPath('/home/company/desks/secretary:0', store)).toBe('secretary')
  })
})
