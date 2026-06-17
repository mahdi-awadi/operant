import { describe, test, expect } from 'bun:test'
import { buildWakePrompt } from '../src/company/wake-prompt'

test('wake prompt is a /goal that drains the board and parks external actions', () => {
  const p = buildWakePrompt({ id: 'secretary', title: 'COS', folder: '/d', reports_to: 'mahdi', manages: [], profile_name: null, skills: [], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
  expect(p.startsWith('/goal')).toBe(true)
  expect(p).toContain('company_get_tasks')
  expect(p).toContain('company_request_approval')
  expect(p).toContain('secretary')
})
