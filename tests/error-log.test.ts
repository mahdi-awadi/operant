// tests/error-log.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ErrorLog } from '../src/error-log'
import { openHubDb } from '../src/hub-db'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HubDbHandle } from '../src/hub-db'

describe('ErrorLog', () => {
  let dir: string
  let handle: HubDbHandle
  let log: ErrorLog

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-errors-test-'))
    handle = openHubDb(dir)
    log = new ErrorLog(handle.db)
  })

  afterEach(() => {
    log.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('creates the database file on construction', () => {
    expect(existsSync(join(dir, 'hub.sqlite'))).toBe(true)
  })

  test('record + recent round-trips an entry', () => {
    log.record({
      ts: 1745000000000,
      sessionName: 'sap',
      sessionPath: '/home/sap:0',
      status: 'parse_error',
      reason: '/btw overlay did not parse',
      rawQuestion: 'Pick A or B?',
      wrappedQuestion: 'You are acting as the user delegate… Pick A or B?',
      capturedPane: 'some pane content',
      durationMs: 12345,
    })
    const rows = log.recent()
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionName).toBe('sap')
    expect(rows[0]?.status).toBe('parse_error')
    expect(rows[0]?.rawQuestion).toBe('Pick A or B?')
    expect(rows[0]?.durationMs).toBe(12345)
  })

  test('recent returns newest entries first', () => {
    log.record({ ts: 1000, sessionName: 's', sessionPath: '/p:0', status: 'timeout', durationMs: 1 })
    log.record({ ts: 3000, sessionName: 's', sessionPath: '/p:0', status: 'parse_error', durationMs: 1 })
    log.record({ ts: 2000, sessionName: 's', sessionPath: '/p:0', status: 'escalate', durationMs: 1 })
    const rows = log.recent()
    expect(rows.map(r => r.ts)).toEqual([3000, 2000, 1000])
  })

  test('recent honors limit', () => {
    for (let i = 0; i < 10; i++) {
      log.record({ ts: i, sessionName: 's', sessionPath: '/p:0', status: 'timeout', durationMs: 1 })
    }
    expect(log.recent({ limit: 3 }).length).toBe(3)
  })

  test('recent filters by session name', () => {
    log.record({ ts: 1, sessionName: 'a', sessionPath: '/a:0', status: 'timeout', durationMs: 1 })
    log.record({ ts: 2, sessionName: 'b', sessionPath: '/b:0', status: 'timeout', durationMs: 1 })
    log.record({ ts: 3, sessionName: 'a', sessionPath: '/a:0', status: 'parse_error', durationMs: 1 })
    const rows = log.recent({ session: 'a' })
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.sessionName === 'a')).toBe(true)
  })

  test('persists across handles to the same hub.sqlite', () => {
    log.record({ ts: 100, sessionName: 's', sessionPath: '/p:0', status: 'timeout', durationMs: 1 })
    log.close()
    handle.close()
    const reopen = openHubDb(dir)
    const log2 = new ErrorLog(reopen.db)
    try {
      expect(log2.recent().length).toBe(1)
    } finally {
      log2.close()
      reopen.close()
    }
  })

  test('handles long captured panes (no truncation surprises)', () => {
    const big = 'x'.repeat(200_000)
    log.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0', status: 'parse_error',
      capturedPane: big, durationMs: 1,
    })
    const rows = log.recent()
    expect(rows[0]?.capturedPane?.length).toBe(200_000)
  })

  test('purge keeps only the N most recent rows', () => {
    for (let i = 0; i < 50; i++) {
      log.record({ ts: i, sessionName: 's', sessionPath: '/p:0', status: 'timeout', durationMs: 1 })
    }
    log.purgeKeepLast(10)
    const rows = log.recent({ limit: 100 })
    expect(rows.length).toBe(10)
    expect(rows[0]?.ts).toBe(49)
    expect(rows[rows.length - 1]?.ts).toBe(40)
  })
})
