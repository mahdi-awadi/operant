// tests/messages.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Messages } from '../src/messages'
import { openOperantDb } from '../src/operant-db'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OperantDbHandle } from '../src/operant-db'

describe('Messages', () => {
  let dir: string
  let handle: OperantDbHandle
  let m: Messages

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-messages-test-'))
    handle = openOperantDb(dir)
    m = new Messages(handle.db)
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('record + recent round-trip user message', () => {
    m.record({ ts: 1000, sessionName: 'sap', role: 'user', text: 'hello' })
    const rows = m.recent({ session: 'sap' })
    expect(rows.length).toBe(1)
    expect(rows[0]?.role).toBe('user')
    expect(rows[0]?.text).toBe('hello')
    expect(rows[0]?.files).toBeUndefined()
  })

  test('record + recent round-trip claude message with file attachments', () => {
    m.record({
      ts: 2000, sessionName: 'sap', role: 'claude',
      text: 'see attached', files: ['/tmp/foo.png', '/tmp/bar.md'],
    })
    const [row] = m.recent({ session: 'sap' })
    expect(row?.role).toBe('claude')
    expect(row?.files).toEqual(['/tmp/foo.png', '/tmp/bar.md'])
  })

  test('recent returns newest-first', () => {
    m.record({ ts: 1, sessionName: 's', role: 'user', text: 'first' })
    m.record({ ts: 3, sessionName: 's', role: 'user', text: 'third' })
    m.record({ ts: 2, sessionName: 's', role: 'user', text: 'second' })
    expect(m.recent({ session: 's' }).map((r) => r.text)).toEqual(['third', 'second', 'first'])
  })

  test('recent filters by session', () => {
    m.record({ ts: 1, sessionName: 'a', role: 'user', text: 'a-msg' })
    m.record({ ts: 2, sessionName: 'b', role: 'user', text: 'b-msg' })
    expect(m.recent({ session: 'a' }).length).toBe(1)
    expect(m.recent({ session: 'a' })[0]?.text).toBe('a-msg')
  })

  test('recent honors limit', () => {
    for (let i = 0; i < 30; i++) m.record({ ts: i, sessionName: 's', role: 'user', text: `m${i}` })
    expect(m.recent({ session: 's', limit: 5 }).length).toBe(5)
  })

  test('purgeKeepLastPerSession bounds storage to N per session', () => {
    for (let i = 0; i < 30; i++) m.record({ ts: i, sessionName: 'a', role: 'user', text: 'x' })
    for (let i = 0; i < 30; i++) m.record({ ts: i, sessionName: 'b', role: 'user', text: 'x' })
    m.purgeKeepLastPerSession(10)
    expect(m.recent({ session: 'a', limit: 100 }).length).toBe(10)
    expect(m.recent({ session: 'b', limit: 100 }).length).toBe(10)
  })

  test('files_json is gracefully ignored when malformed', () => {
    // Direct row insert with invalid JSON in files_json — recent() should
    // return undefined rather than throwing.
    handle.db.prepare(
      `INSERT INTO messages (ts, session_name, role, text, files_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, 's', 'user', 'x', '{not json')
    const [row] = m.recent({ session: 's' })
    expect(row?.text).toBe('x')
    expect(row?.files).toBeUndefined()
  })
})
