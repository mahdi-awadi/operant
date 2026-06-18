import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('company schema', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-schema-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('creates all company tables', () => {
    const { db, close } = openOperantDb(dir)
    try {
      const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name)
      for (const t of ['departments', 'tasks', 'handoffs', 'memory', 'approvals', 'activity_log']) {
        expect(names).toContain(t)
      }
      // FTS5 virtual table exists
      expect(names).toContain('memory_fts')
    } finally { close() }
  })
})
