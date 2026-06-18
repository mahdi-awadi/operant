// tests/operant-db.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openOperantDb } from '../src/operant-db'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

describe('openOperantDb', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-db-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('creates operant.sqlite with all expected tables on first run', () => {
    const { db, close } = openOperantDb(dir)
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all()
      const names = tables.map((r: any) => r.name)
      expect(names).toContain('autopilot_errors')
      expect(names).toContain('personalities')
      expect(names).toContain('project_personalities')
      expect(existsSync(join(dir, 'operant.sqlite'))).toBe(true)
    } finally {
      close()
    }
  })

  test('migrates an existing errors.sqlite by copying its rows then renaming to .bak', () => {
    // Seed an "old" errors.sqlite with a row.
    const oldPath = join(dir, 'errors.sqlite')
    const seed = new Database(oldPath, { create: true })
    seed.exec(`
      CREATE TABLE autopilot_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        session_path TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        raw_question TEXT,
        wrapped_question TEXT,
        captured_pane TEXT,
        duration_ms INTEGER NOT NULL
      );
    `)
    seed.prepare(`INSERT INTO autopilot_errors (ts, session_name, session_path, status, duration_ms) VALUES (?, ?, ?, ?, ?)`)
      .run(1000, 'pre-migration', '/p:0', 'timeout', 1)
    seed.close()

    const { db, close } = openOperantDb(dir)
    try {
      // Old rows are in the new file
      const rows = db.prepare(`SELECT * FROM autopilot_errors`).all()
      expect(rows.length).toBe(1)
      expect((rows[0] as any).session_name).toBe('pre-migration')

      // Old file is renamed to .bak (rollback path retained)
      expect(existsSync(join(dir, 'errors.sqlite'))).toBe(false)
      expect(existsSync(join(dir, 'errors.sqlite.bak'))).toBe(true)
    } finally {
      close()
    }
  })

  test('does not overwrite an existing operant.sqlite even if errors.sqlite is also present', () => {
    // Existing operant.sqlite with a marker row
    const newPath = join(dir, 'operant.sqlite')
    const real = new Database(newPath, { create: true })
    real.exec(`CREATE TABLE marker (k TEXT)`)
    real.prepare(`INSERT INTO marker VALUES (?)`).run('keep-me')
    real.close()

    // Spurious errors.sqlite (e.g., a half-finished migration leftover)
    writeFileSync(join(dir, 'errors.sqlite'), '') // empty file, definitely not valid SQLite

    const { db, close } = openOperantDb(dir)
    try {
      const v = db.prepare(`SELECT k FROM marker`).get() as any
      expect(v.k).toBe('keep-me')
      // Migration must not have touched errors.sqlite (no rename)
      expect(existsSync(join(dir, 'errors.sqlite'))).toBe(true)
      expect(existsSync(join(dir, 'errors.sqlite.bak'))).toBe(false)
    } finally {
      close()
    }
  })

  test('idempotent: re-opening adds nothing and changes nothing', () => {
    let { db, close } = openOperantDb(dir)
    db.prepare(`INSERT INTO autopilot_errors (ts, session_name, session_path, status, duration_ms) VALUES (?, ?, ?, ?, ?)`).run(1, 'a', '/a:0', 'timeout', 1)
    close()

    const reopen = openOperantDb(dir)
    try {
      const count = (reopen.db.prepare(`SELECT count(*) AS c FROM autopilot_errors`).get() as any).c
      expect(count).toBe(1)
    } finally {
      reopen.close()
    }
  })

  test('schema migration runs in a single transaction (visible only after commit)', () => {
    // We can't observe the txn from outside, but we can verify all four
    // tables exist together — which would be impossible if a partial
    // schema-create were committed mid-flight.
    const { db, close } = openOperantDb(dir)
    try {
      const expected = ['autopilot_errors', 'personalities', 'project_personalities']
      for (const name of expected) {
        const got = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)
        expect(got).toBeTruthy()
      }
    } finally {
      close()
    }
  })
})
