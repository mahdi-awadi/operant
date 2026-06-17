import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CompanyStore tasks', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-tasks-'))
    const h = openHubDb(dir); close = h.close
    store = new CompanyStore(h.db)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('create, list by filter, atomic claim once, update status', () => {
    const t = store.createTask({ title: 'Follow up eticket OTA', dept_id: 'secretary', project: 'eticket' })
    expect(t.id).toBeTruthy()
    expect(store.getTask(t.id)!.title).toBe('Follow up eticket OTA')
    expect(store.listTasks({ dept_id: 'secretary' }).length).toBe(1)

    expect(store.claimTask(t.id, 'run-1')).toBe(true)
    expect(store.claimTask(t.id, 'run-2')).toBe(false) // already claimed

    store.updateTaskStatus(t.id, 'done', 'memory:eticket.ota')
    expect(store.getTask(t.id)!.status).toBe('done')
  })
})
