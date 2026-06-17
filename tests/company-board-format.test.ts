// tests/company-board-format.test.ts
import { test, expect } from 'bun:test'
import { formatBoard } from '../src/frontends/telegram'

test('board groups tasks by status', () => {
  const text = formatBoard([
    { id: 't1', title: 'A', status: 'assigned', dept_id: 'secretary', project: 'eticket', body: null, priority: 3, origin: null, emits_on_done: null, corr_id: null, request_depth: 0, created_at: 0, updated_at: 0 },
    { id: 't2', title: 'B', status: 'needs_approval', dept_id: 'sales', project: null, body: null, priority: 3, origin: null, emits_on_done: null, corr_id: null, request_depth: 0, created_at: 0, updated_at: 0 },
  ])
  expect(text).toContain('assigned')
  expect(text).toContain('A')
  expect(text).toContain('needs_approval')
})

test('board returns empty message when no tasks', () => {
  const text = formatBoard([])
  expect(text).toBe('Board is empty.')
})

test('board includes dept and project info', () => {
  const text = formatBoard([
    { id: 't1', title: 'Deploy feature', status: 'assigned', dept_id: 'engineering', project: 'eticket', body: null, priority: 3, origin: null, emits_on_done: null, corr_id: null, request_depth: 0, created_at: 0, updated_at: 0 },
  ])
  expect(text).toContain('engineering')
  expect(text).toContain('Deploy feature')
  expect(text).toContain('eticket')
})
