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
    const due = opts.isDue(d.schedule_cron, now)
    const hasWork = opts.hasInboxOrAssigned(d.id)
    if (!due && !hasWork) continue                                          // wake if due OR has work
    wake.push(d.id)
    if (wake.length >= opts.maxConcurrent) break
  }
  return wake
}
