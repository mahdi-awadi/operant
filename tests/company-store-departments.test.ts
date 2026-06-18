import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CompanyStore departments', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-store-'))
    const h = openOperantDb(dir); close = h.close
    store = new CompanyStore(h.db)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('upsert then get round-trips, and update overwrites', () => {
    store.upsertDepartment({
      id: 'secretary', title: 'Chief of Staff', folder: '/home/company/desks/secretary',
      reports_to: 'mahdi', manages: ['dev'], profile_name: 'careful',
      skills: ['brainstorming'], mcps: ['operant'], schedule_cron: '0 7 * * *',
      budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1,
      status: 'idle', active: true,
    })
    const got = store.getDepartment('secretary')!
    expect(got.title).toBe('Chief of Staff')
    expect(got.manages).toEqual(['dev'])
    expect(got.skills).toEqual(['brainstorming'])
    store.upsertDepartment({ ...got, title: 'COS v2' })
    expect(store.getDepartment('secretary')!.title).toBe('COS v2')
    expect(store.listDepartments().length).toBe(1)
  })

  test('listDepartments filters by active flag, getDepartment does not', () => {
    store.upsertDepartment({
      id: 'active-dept', title: 'Active Department', folder: '/home/company/desks/active',
      reports_to: 'mahdi', manages: ['dev'], profile_name: 'careful',
      skills: ['brainstorming'], mcps: ['operant'], schedule_cron: '0 7 * * *',
      budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1,
      status: 'idle', active: true,
    })
    store.upsertDepartment({
      id: 'inactive-dept', title: 'Inactive Department', folder: '/home/company/desks/inactive',
      reports_to: 'mahdi', manages: ['qa'], profile_name: 'careful',
      skills: ['testing'], mcps: ['operant'], schedule_cron: '0 8 * * *',
      budget_minutes_week: 120, approval_policy: 'ask', autonomy_level: 1,
      status: 'idle', active: false,
    })
    expect(store.listDepartments().map(d => d.id)).toEqual(['active-dept'])
    expect(store.getDepartment('inactive-dept')).not.toBeNull()
  })
})
