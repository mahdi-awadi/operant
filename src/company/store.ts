import type { Database } from 'bun:sqlite'
import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

export type Task = {
  id: string; title: string; body: string | null; project: string | null
  dept_id: string | null; status: string; priority: number; origin: string | null
  emits_on_done: string | null; corr_id: string | null; request_depth: number
  created_at: number; updated_at: number
}

function taskFromRow(r: any): Task {
  return {
    id: r.id, title: r.title, body: r.body ?? null, project: r.project ?? null,
    dept_id: r.dept_id ?? null, status: r.status, priority: r.priority,
    origin: r.origin ?? null, emits_on_done: r.emits_on_done ?? null,
    corr_id: r.corr_id ?? null, request_depth: r.request_depth,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

export type Approval = {
  id: string; task_id: string | null; dept_id: string | null
  kind: string; summary: string; payload: string | null; state: string; requested_at: number
}

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

function approvalFromRow(r: any): Approval {
  return { id: r.id, task_id: r.task_id ?? null, dept_id: r.dept_id ?? null, kind: r.kind, summary: r.summary, payload: r.payload ?? null, state: r.state, requested_at: r.requested_at }
}

export class CompanyStore {
  private mirrorDir: string | null = null
  constructor(private db: Database) {}

  setMemoryMirrorDir(dir: string): void { this.mirrorDir = dir }

  writeMemory(input: { scope: string; key: string; value: string; author_dept?: string; source_task?: string }): void {
    const ts = Date.now()
    const res = this.db.prepare(
      'INSERT INTO memory (scope,key,value,source_task,author_dept,ts) VALUES (?,?,?,?,?,?)',
    ).run(input.scope, input.key, input.value, input.source_task ?? null, input.author_dept ?? null, ts)
    this.db.prepare('INSERT INTO memory_fts (rowid,value,key,scope) VALUES (?,?,?,?)')
      .run(res.lastInsertRowid, input.value, input.key, input.scope)
    if (this.mirrorDir) {
      mkdirSync(this.mirrorDir, { recursive: true })
      const file = join(this.mirrorDir, input.scope.replace(/[:/]/g, '_') + '.md')
      appendFileSync(file, `- **${input.key}** (${input.author_dept ?? 'system'}): ${input.value}\n`)
    }
  }

  searchMemory(query: string, scope?: string): Array<{ scope: string; key: string; value: string }> {
    // FTS5 match; scope optional narrowing. Escape double-quotes for the MATCH string.
    const q = `"${query.replace(/"/g, '""')}"`
    if (scope) {
      return this.db.prepare(
        `SELECT scope,key,value FROM memory_fts WHERE memory_fts MATCH ? AND scope = ? LIMIT 20`,
      ).all(q, scope) as any
    }
    return this.db.prepare(`SELECT scope,key,value FROM memory_fts WHERE memory_fts MATCH ? LIMIT 20`).all(q) as any
  }

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

  createTask(input: { title: string; body?: string; project?: string; dept_id?: string; priority?: number; origin?: string; emits_on_done?: string; corr_id?: string; request_depth?: number }): Task {
    const id = newId('task')
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO tasks (id,title,body,project,dept_id,status,priority,origin,emits_on_done,corr_id,request_depth,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, input.title, input.body ?? null, input.project ?? null, input.dept_id ?? null,
      input.dept_id ? 'assigned' : 'inbox', input.priority ?? 3, input.origin ?? null,
      input.emits_on_done ?? null, input.corr_id ?? null, input.request_depth ?? 0, now, now,
    )
    return this.getTask(id)!
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return r ? taskFromRow(r) : null
  }

  listTasks(filter?: { dept_id?: string; status?: string }): Task[] {
    const where: string[] = [], args: (string | undefined)[] = []
    if (filter?.dept_id) { where.push('dept_id = ?'); args.push(filter.dept_id) }
    if (filter?.status) { where.push('status = ?'); args.push(filter.status) }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at ASC`
    return this.db.prepare(sql).all(...(args as any)).map(taskFromRow)
  }

  claimTask(id: string, runId: string): boolean {
    const res = this.db.prepare(
      `UPDATE tasks SET checkout_run_id = ?, execution_locked_at = ?, status = 'in_progress', updated_at = ?
       WHERE id = ? AND checkout_run_id IS NULL`,
    ).run(runId, Date.now(), Date.now(), id)
    return res.changes === 1
  }

  updateTaskStatus(id: string, status: string, resultRef?: string): void {
    this.db.prepare('UPDATE tasks SET status = ?, result_ref = COALESCE(?, result_ref), updated_at = ? WHERE id = ?')
      .run(status, resultRef ?? null, Date.now(), id)
  }

  createHandoff(input: { task_id: string; from_dept: string; to_dept: string; reason?: string; payload?: string }): void {
    this.db.prepare('INSERT INTO handoffs (task_id,from_dept,to_dept,reason,payload,ts) VALUES (?,?,?,?,?,?)')
      .run(input.task_id, input.from_dept, input.to_dept, input.reason ?? null, input.payload ?? null, Date.now())
  }

  listHandoffs(toDept: string): Array<{ task_id: string; from_dept: string; to_dept: string; reason: string | null }> {
    return this.db.prepare('SELECT task_id, from_dept, to_dept, reason FROM handoffs WHERE to_dept = ? ORDER BY ts DESC').all(toDept) as any
  }

  logActivity(a: { actor_type: string; actor: string; action: string; entity_type?: string; entity_id?: string; details?: string }): void {
    this.db.prepare('INSERT INTO activity_log (actor_type,actor,action,entity_type,entity_id,details,ts) VALUES (?,?,?,?,?,?,?)')
      .run(a.actor_type, a.actor, a.action, a.entity_type ?? null, a.entity_id ?? null, a.details ?? null, Date.now())
  }

  createApproval(input: { task_id?: string; dept_id?: string; kind: string; summary: string; payload?: string }): Approval {
    const id = newId('appr'); const now = Date.now()
    this.db.prepare('INSERT INTO approvals (id,task_id,dept_id,kind,summary,payload,state,requested_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.task_id ?? null, input.dept_id ?? null, input.kind, input.summary, input.payload ?? null, 'pending', now)
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any
  }

  resolveApproval(id: string, state: 'approved' | 'denied', note?: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND state = ?').get(id, 'pending')
    if (!r) return null
    this.db.prepare('UPDATE approvals SET state = ?, resolved_at = ?, decision_note = ? WHERE id = ?')
      .run(state, Date.now(), note ?? null, id)
    return approvalFromRow({ ...r, state })
  }

  listPendingApprovals(): Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at ASC").all().map(approvalFromRow)
  }
}
