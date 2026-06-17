// tests/company-orchestrator.test.ts
import { describe, test, expect } from 'bun:test'
import { decideWakes } from '../src/company/orchestrator'
import type { Department } from '../src/company/store'

const mk = (id: string, over: Partial<Department> = {}): Department => ({ id, title: id, folder: '/d/' + id, reports_to: 'mahdi', manages: [], profile_name: null, skills: [], mcps: [], schedule_cron: '0 7 * * *', budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true, ...over })

test('wakes only due-or-has-work seats, respects max concurrent and budget', () => {
  // secretary: has cron + has work, in budget → wakes
  // sales: has cron + has work, OVER budget → excluded
  // research: schedule_cron null + NO work → excluded (not due, no work)
  const depts = [
    mk('secretary'),
    mk('sales', { budget_minutes_week: 60 }),
    mk('research', { schedule_cron: null }),
  ]
  const ids = decideWakes(new Date(), depts, {
    maxConcurrent: 2,
    isDue: (cron) => cron !== null,            // research (null cron) is not due
    hasInboxOrAssigned: (d) => d !== 'research', // research has no inbox work either
    minutesUsedThisWeek: (d) => d === 'sales' ? 60 : 0, // sales at budget limit
  })
  expect(ids).toEqual(['secretary']) // research=not due+no work, sales=over budget
})

test('a due department with an empty board still wakes (scheduled brief)', () => {
  // A department whose cron fires but has no inbox/assigned tasks must still wake
  // so it can produce its scheduled brief.
  const depts = [mk('morning-brief')]
  const ids = decideWakes(new Date(), depts, {
    maxConcurrent: 2,
    isDue: () => true,               // cron is due
    hasInboxOrAssigned: () => false, // empty board
    minutesUsedThisWeek: () => 0,    // in budget
  })
  expect(ids).toContain('morning-brief')
})
