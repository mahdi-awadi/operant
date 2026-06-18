// tests/decisions.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Decisions } from '../src/decisions'
import { Personalities } from '../src/personalities'
import { openOperantDb } from '../src/operant-db'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OperantDbHandle } from '../src/operant-db'

describe('Decisions', () => {
  let dir: string
  let handle: OperantDbHandle
  let dec: Decisions
  let people: Personalities

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-decisions-test-'))
    handle = openOperantDb(dir)
    dec = new Decisions(handle.db)
    people = new Personalities(handle.db)
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('record + recent round-trip', () => {
    dec.record({
      ts: 1700000000000,
      sessionName: 'sap',
      sessionPath: '/home/sap:0',
      personalityId: undefined,
      personalityName: undefined,
      rawQuestion: 'A or B?',
      answer: 'Pick A.',
      durationMs: 1234,
    })
    const rows = dec.recent()
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessionName).toBe('sap')
    expect(rows[0]?.rawQuestion).toBe('A or B?')
    expect(rows[0]?.answer).toBe('Pick A.')
    expect(rows[0]?.personalityId).toBeUndefined()
  })

  test('recent returns newest first', () => {
    dec.record({ ts: 1000, sessionName: 's', sessionPath: '/p:0', rawQuestion: 'q1', answer: 'a1', durationMs: 1 })
    dec.record({ ts: 3000, sessionName: 's', sessionPath: '/p:0', rawQuestion: 'q3', answer: 'a3', durationMs: 1 })
    dec.record({ ts: 2000, sessionName: 's', sessionPath: '/p:0', rawQuestion: 'q2', answer: 'a2', durationMs: 1 })
    expect(dec.recent().map((r) => r.ts)).toEqual([3000, 2000, 1000])
  })

  test('filters by session', () => {
    dec.record({ ts: 1, sessionName: 'a', sessionPath: '/a:0', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    dec.record({ ts: 2, sessionName: 'b', sessionPath: '/b:0', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    expect(dec.recent({ session: 'a' }).length).toBe(1)
    expect(dec.recent({ session: 'a' })[0]?.sessionName).toBe('a')
  })

  test('filters by personalityId', () => {
    const a = people.getByName('Architect')!
    const r = people.getByName('Researcher')!
    dec.record({ ts: 1, sessionName: 's', sessionPath: '/p:0', personalityId: a.id, personalityName: 'Architect', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    dec.record({ ts: 2, sessionName: 's', sessionPath: '/p:0', personalityId: r.id, personalityName: 'Researcher', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    const onlyA = dec.recent({ personalityId: a.id })
    expect(onlyA.length).toBe(1)
    expect(onlyA[0]?.personalityName).toBe('Architect')
  })

  test('preserves personality_name even after the personality is deleted (FK SET NULL keeps the row)', () => {
    const created = people.create({ name: 'Throwaway', systemPrompt: 'x' })
    dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      personalityId: created.id, personalityName: 'Throwaway',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    people.deleteById(created.id)
    const rows = dec.recent()
    expect(rows.length).toBe(1)
    expect(rows[0]?.personalityName).toBe('Throwaway')
    expect(rows[0]?.personalityId).toBeUndefined()  // FK was nulled
  })

  test('limit caps the result set', () => {
    for (let i = 0; i < 25; i++) {
      dec.record({ ts: i, sessionName: 's', sessionPath: '/p:0', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    }
    expect(dec.recent({ limit: 5 }).length).toBe(5)
  })

  test('record returns the inserted decision id (so callers can attach feedback)', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
    expect(dec.getById(id)?.rawQuestion).toBe('q')
  })

  test('recordFeedback + recent({ withFeedback: true }) round-trips veto reasons', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    dec.recordFeedback(id, { ts: 2, action: 'cancel', reason: 'too verbose' })
    const rows = dec.recent({ withFeedback: true })
    expect(rows[0]?.feedback).toEqual([
      expect.objectContaining({ action: 'cancel', reason: 'too verbose' }),
    ])
  })

  test('recordFeedback for an edit captures the edited answer', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'A', durationMs: 1,
    })
    dec.recordFeedback(id, {
      ts: 2, action: 'edit',
      reason: 'preferred B for compatibility',
      editedAnswer: 'B',
    })
    const [row] = dec.recent({ withFeedback: true })
    expect(row?.feedback?.[0]).toMatchObject({
      action: 'edit',
      reason: 'preferred B for compatibility',
      editedAnswer: 'B',
    })
  })

  test('multiple feedback entries on one decision are returned newest first', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    dec.recordFeedback(id, { ts: 100, action: 'cancel', reason: 'first' })
    dec.recordFeedback(id, { ts: 200, action: 'cancel', reason: 'second' })
    const [row] = dec.recent({ withFeedback: true })
    const reasons = (row?.feedback ?? []).map((f) => f.reason)
    expect(reasons).toEqual(['second', 'first'])
  })

  test('feedback rows cascade-delete when their decision row is removed (FK CASCADE)', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    dec.recordFeedback(id, { ts: 2, action: 'cancel', reason: 'x' })
    handle.db.prepare(`DELETE FROM autopilot_decisions WHERE id = ?`).run(id)
    const orphans = handle.db.prepare(`SELECT count(*) AS c FROM decision_feedback`).get() as any
    expect(orphans.c).toBe(0)
  })

  test('recent({ withFeedback: false }) does NOT include the feedback array', () => {
    const id = dec.record({
      ts: 1, sessionName: 's', sessionPath: '/p:0',
      rawQuestion: 'q', answer: 'a', durationMs: 1,
    })
    dec.recordFeedback(id, { ts: 2, action: 'cancel', reason: 'x' })
    const [row] = dec.recent()  // default: no feedback
    expect((row as any).feedback).toBeUndefined()
  })

  test('purgeKeepLast keeps only the N most recent rows per session', () => {
    for (let i = 0; i < 30; i++) {
      dec.record({ ts: i, sessionName: 'a', sessionPath: '/a:0', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    }
    for (let i = 0; i < 30; i++) {
      dec.record({ ts: i, sessionName: 'b', sessionPath: '/b:0', rawQuestion: 'q', answer: 'a', durationMs: 1 })
    }
    dec.purgeKeepLastPerSession(10)
    expect(dec.recent({ session: 'a', limit: 100 }).length).toBe(10)
    expect(dec.recent({ session: 'b', limit: 100 }).length).toBe(10)
  })
})
