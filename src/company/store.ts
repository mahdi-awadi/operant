import type { Database } from 'bun:sqlite'

export type Department = {
  id: string; title: string; folder: string
  reports_to: string | null; manages: string[]
  profile_name: string | null
  skills: string[]; mcps: string[]
  schedule_cron: string | null; budget_minutes_week: number
  approval_policy: string; autonomy_level: number
  status: string; active: boolean
}

function deptFromRow(r: any): Department {
  return {
    id: r.id, title: r.title, folder: r.folder,
    reports_to: r.reports_to ?? null,
    manages: JSON.parse(r.manages_json),
    profile_name: r.profile_name ?? null,
    skills: JSON.parse(r.skills_json),
    mcps: JSON.parse(r.mcp_json),
    schedule_cron: r.schedule_cron ?? null,
    budget_minutes_week: r.budget_minutes_week,
    approval_policy: r.approval_policy,
    autonomy_level: r.autonomy_level,
    status: r.status,
    active: !!r.active,
  }
}

export class CompanyStore {
  constructor(private db: Database) {}

  upsertDepartment(d: Department): void {
    this.db.prepare(
      `INSERT INTO departments
        (id,title,folder,reports_to,manages_json,profile_name,skills_json,mcp_json,
         schedule_cron,budget_minutes_week,approval_policy,autonomy_level,status,active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, folder=excluded.folder, reports_to=excluded.reports_to,
        manages_json=excluded.manages_json, profile_name=excluded.profile_name,
        skills_json=excluded.skills_json, mcp_json=excluded.mcp_json,
        schedule_cron=excluded.schedule_cron, budget_minutes_week=excluded.budget_minutes_week,
        approval_policy=excluded.approval_policy, autonomy_level=excluded.autonomy_level,
        status=excluded.status, active=excluded.active`,
    ).run(
      d.id, d.title, d.folder, d.reports_to, JSON.stringify(d.manages), d.profile_name,
      JSON.stringify(d.skills), JSON.stringify(d.mcps), d.schedule_cron, d.budget_minutes_week,
      d.approval_policy, d.autonomy_level, d.status, d.active ? 1 : 0,
    )
  }

  getDepartment(id: string): Department | null {
    const r = this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id)
    return r ? deptFromRow(r) : null
  }

  listDepartments(): Department[] {
    return this.db.prepare('SELECT * FROM departments WHERE active = 1 ORDER BY id').all().map(deptFromRow)
  }
}
