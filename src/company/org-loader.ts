import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'
import type { CompanyStore, Department } from './store'

export function loadOrg(companyDir: string, store: CompanyStore): { loaded: string[] } {
  const seatsDir = join(companyDir, 'seats')
  const loaded: string[] = []
  if (!existsSync(seatsDir)) return { loaded }
  for (const file of readdirSync(seatsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    const raw = parse(readFileSync(join(seatsDir, file), 'utf8')) ?? {}
    if (!raw.id || !raw.title || !raw.folder) {
      throw new Error(`seat ${file} missing required field id/title/folder`)
    }
    const d: Department = {
      id: raw.id, title: raw.title, folder: raw.folder,
      reports_to: raw.reports_to ?? null,
      manages: raw.manages ?? [],
      profile_name: raw.profile ?? null,
      skills: raw.skills ?? [],
      mcps: raw.mcps ?? [],
      schedule_cron: raw.schedule_cron ?? null,
      budget_minutes_week: raw.budget_minutes_week ?? 120,
      approval_policy: raw.approval_policy ?? 'ask',
      autonomy_level: raw.autonomy_level ?? 1,
      status: 'idle', active: raw.active ?? true,
    }
    store.upsertDepartment(d)
    loaded.push(d.id)
  }
  return { loaded }
}
