import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { CompanyStore } from '../src/company/store'
import { loadOrg } from '../src/company/org-loader'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('loadOrg', () => {
  let dir: string, close: () => void, store: CompanyStore, company: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-org-')); const h = openOperantDb(dir); close = h.close; store = new CompanyStore(h.db)
    company = join(dir, 'company'); mkdirSync(join(company, 'seats'), { recursive: true })
    writeFileSync(join(company, 'seats', 'secretary.yaml'),
`id: secretary
title: Chief of Staff
folder: ${company}/desks/secretary
reports_to: mahdi
manages: [dev]
profile: careful
skills: [brainstorming, writing-plans]
mcps: [operant]
schedule_cron: "0 7 * * *"
budget_minutes_week: 240
approval_policy: ask
autonomy_level: 1
`)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('loads seat yaml into departments table', () => {
    const res = loadOrg(company, store)
    expect(res.loaded).toContain('secretary')
    const d = store.getDepartment('secretary')!
    expect(d.title).toBe('Chief of Staff')
    expect(d.skills).toEqual(['brainstorming', 'writing-plans'])
    expect(d.approval_policy).toBe('ask')
  })
})
