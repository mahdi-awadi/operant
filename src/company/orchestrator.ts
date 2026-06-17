// src/company/orchestrator.ts
import type { Department } from './store'

export function decideWakes(
  now: Date,
  depts: Department[],
  opts: {
    maxConcurrent: number
    isDue: (cron: string | null, now: Date) => boolean
    hasInboxOrAssigned: (deptId: string) => boolean
    minutesUsedThisWeek: (deptId: string) => number
  },
): string[] {
  const wake: string[] = []
  for (const d of depts) {
    if (!d.active) continue
    if (d.status === 'computing') continue
    if (opts.minutesUsedThisWeek(d.id) >= d.budget_minutes_week) continue   // over budget -> skip
    const hasWork = opts.hasInboxOrAssigned(d.id)
    const due = opts.isDue(d.schedule_cron, now)
    // Wake only if there is actual inbox/assigned work (due cron alone is not enough for MVP)
    if (!hasWork) continue
    if (!due) continue                                                      // cron not matched yet
    wake.push(d.id)
    if (wake.length >= opts.maxConcurrent) break
  }
  return wake
}
