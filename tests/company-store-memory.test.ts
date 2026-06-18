import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore memory', () => {
  let dir: string, close: () => void, store: CompanyStore, mirror: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-mem-')); const h = openOperantDb(dir); close = h.close
    store = new CompanyStore(h.db); mirror = join(dir, 'memory'); store.setMemoryMirrorDir(mirror)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('write is searchable and mirrored to markdown', () => {
    store.writeMemory({ scope: 'project:eticket', key: 'ota.status', value: 'OTA partner is weak; quiet 6 days', author_dept: 'secretary' })
    const hits = store.searchMemory('OTA partner')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].key).toBe('ota.status')
    const file = join(mirror, 'project_eticket.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('ota.status')
  })
})
