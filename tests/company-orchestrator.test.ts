// tests/company-orchestrator.test.ts
import { describe, test, expect } from 'bun:test'
import { decideWakes } from '../src/company/orchestrator'
import type { Department } from '../src/company/store'

const mk = (id: string, over: Partial<Department> = {}): Department => ({ id, title: id, folder: '/d/' + id, reports_to: 'mahdi', manages: [], profile_name: null, skills: [], mcps: [], schedule_cron: '0 7 * * *', budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true, ...over })

test('wakes only due-or-has-work seats, respects max concurrent and budget', () => {
  const depts = [mk('secretary'), mk('research'), mk('sales', { budget_minutes_week: 60 })]
  const ids = decideWakes(new Date(), depts, {
    maxConcurrent: 2,
    isDue: () => true,
    hasInboxOrAssigned: (d) => d !== 'research', // research has no work
    minutesUsedThisWeek: (d) => d === 'sales' ? 60 : 0, // sales over budget
  })
  expect(ids).toEqual(['secretary']) // research=no work, sales=over budget, cap=2
})
