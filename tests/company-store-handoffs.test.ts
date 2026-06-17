import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore handoffs + activity', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-h-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('handoff is recorded and listed by target dept', () => {
    store.createHandoff({ task_id: 't1', from_dept: 'research', to_dept: 'sales', reason: 'draft outreach' })
    const hs = store.listHandoffs('sales')
    expect(hs.length).toBe(1)
    expect(hs[0].from_dept).toBe('research')
    store.logActivity({ actor_type: 'agent', actor: 'research', action: 'handoff', entity_type: 'task', entity_id: 't1' })
    // no throw == pass
  })
})
