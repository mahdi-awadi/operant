# Company Engine MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn operant from a window-switcher into a one-person AI company by adding a shared "company brain" (SQLite) plus one working department (the Secretary), so future departments plug in by writing YAML.

**Architecture:** A new `src/company/*` module set on top of operant. The daemon owns one SQLite store (`hub.sqlite`) holding org/tasks/memory/approvals — the single writer. Departments are Claude Code sessions spawned in their own desk folder with a per-seat skill/MCP loadout; they read/write the shared store via `company_*` MCP tools registered in the existing shim and executed by the daemon. The org is declared as YAML in `/home/company/`. The native `/goal` command is the per-department wake prompt; the daemon's scheduler is the company clock. All external/irreversible actions route to Mahdi's Telegram via the existing permission-relay path.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@modelcontextprotocol/sdk` ^1.0.0, `grammy` ^1.21, `bun:test`, `yaml` ^2 (new dep). Spec: `docs/superpowers/specs/2026-06-17-company-engine-design.md`.

## Global Constraints

- Runtime is **Bun**; tests are **`bun:test`** in `/home/operant/tests/<name>.test.ts`. Run all with `bun test`, one file with `bun test tests/FILE.test.ts`.
- Typecheck must pass: `bunx tsc --noEmit`.
- **No API key, no proxy.** Nothing in this plan calls the Anthropic API directly; agents run via the official `claude` CLI (`--dangerously-load-development-channels server:hub`). `ANTHROPIC_API_KEY` stays unset.
- **The daemon is the only writer of company state.** Departments never open `hub.sqlite` directly; they call `company_*` tools the daemon executes.
- SQLite access pattern: `db.prepare(sql).run(...) | .get(...) | .all(...)` (bun:sqlite). Use `?` placeholders.
- Company config repo lives at `/home/company/` (git). Department desks at `/home/company/desks/<seat>/`. Human-readable memory mirror at `/home/company/memory/<scope>.md`. The Dev department (later) runs inside the real project repo, not a desk.
- Atomic JSON writes already exist (`writeJson` in `config.ts`); reuse `bun:sqlite` transactions for multi-row atomicity.
- Commit after every task with the shown message.

**Setup step (do once, before Task 1):**

```bash
cd /home/operant
bun add yaml
git add package.json bun.lock && git commit -m "chore: add yaml dep for company org files"
```

---

### Task 1: Company schema tables

**Files:**
- Create: `src/company/schema.ts`
- Modify: `src/hub-db.ts` (apply company statements in the migration loop)
- Test: `tests/company-schema.test.ts`

**Interfaces:**
- Produces: `export const COMPANY_SCHEMA_STATEMENTS: string[]` — appended to the existing `SCHEMA_STATEMENTS` loop in `openHubDb()`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-schema.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('company schema', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-schema-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('creates all company tables', () => {
    const { db, close } = openHubDb(dir)
    try {
      const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name)
      for (const t of ['departments', 'tasks', 'handoffs', 'memory', 'approvals', 'compute_ledger', 'activity_log']) {
        expect(names).toContain(t)
      }
      // FTS5 virtual table exists
      expect(names).toContain('memory_fts')
    } finally { close() }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/company-schema.test.ts`
Expected: FAIL — tables not found (`expect(names).toContain('departments')`).

- [ ] **Step 3: Write `src/company/schema.ts`**

```typescript
// src/company/schema.ts
// SQLite DDL for the shared "company brain". Appended to hub-db's migration loop.
export const COMPANY_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    folder TEXT NOT NULL,
    reports_to TEXT,
    manages_json TEXT NOT NULL DEFAULT '[]',
    profile_name TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    mcp_json TEXT NOT NULL DEFAULT '[]',
    schedule_cron TEXT,
    budget_minutes_week INTEGER NOT NULL DEFAULT 120,
    approval_policy TEXT NOT NULL DEFAULT 'ask',
    autonomy_level INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'idle',
    active INTEGER NOT NULL DEFAULT 1,
    company_id TEXT NOT NULL DEFAULT 'default'
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    project TEXT,
    dept_id TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
    priority INTEGER NOT NULL DEFAULT 3,
    origin TEXT,
    blocked_by TEXT NOT NULL DEFAULT '[]',
    emits_on_done TEXT,
    corr_id TEXT,
    checkout_run_id TEXT,
    execution_locked_at INTEGER,
    request_depth INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    due_at INTEGER,
    result_ref TEXT,
    company_id TEXT NOT NULL DEFAULT 'default'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_dept ON tasks(dept_id, status)`,
  `CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    from_dept TEXT,
    to_dept TEXT,
    reason TEXT,
    payload TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source_task TEXT,
    author_dept TEXT,
    ts INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1.0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_scope_key ON memory(scope, key)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(value, key, scope)`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    dept_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    requested_at INTEGER NOT NULL,
    resolved_at INTEGER,
    decision_note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS compute_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dept_id TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    minutes REAL,
    week TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT,
    actor TEXT,
    action TEXT,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT,
    ts INTEGER NOT NULL
  )`,
]
```

- [ ] **Step 4: Wire it into `src/hub-db.ts`**

At the top of `src/hub-db.ts`, add the import:
```typescript
import { COMPANY_SCHEMA_STATEMENTS } from './company/schema'
```
Change the migration loop (currently `for (const stmt of SCHEMA_STATEMENTS) { db.exec(stmt) }`, lines ~137-139) to:
```typescript
for (const stmt of [...SCHEMA_STATEMENTS, ...COMPANY_SCHEMA_STATEMENTS]) {
  db.exec(stmt)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/company-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/company/schema.ts src/hub-db.ts tests/company-schema.test.ts
git commit -m "feat(company): add company-brain SQLite schema"
```

---

### Task 2: CompanyStore — departments

**Files:**
- Create: `src/company/store.ts`
- Test: `tests/company-store-departments.test.ts`

**Interfaces:**
- Produces:
  - `export type Department = { id: string; title: string; folder: string; reports_to: string | null; manages: string[]; profile_name: string | null; skills: string[]; mcps: string[]; schedule_cron: string | null; budget_minutes_week: number; approval_policy: string; autonomy_level: number; status: string; active: boolean }`
  - `export class CompanyStore { constructor(db: Database) }`
  - `upsertDepartment(d: Department): void`
  - `getDepartment(id: string): Department | null`
  - `listDepartments(): Department[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-store-departments.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CompanyStore departments', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-store-'))
    const h = openHubDb(dir); close = h.close
    store = new CompanyStore(h.db)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('upsert then get round-trips, and update overwrites', () => {
    store.upsertDepartment({
      id: 'secretary', title: 'Chief of Staff', folder: '/home/company/desks/secretary',
      reports_to: 'mahdi', manages: ['dev'], profile_name: 'careful',
      skills: ['brainstorming'], mcps: ['hub'], schedule_cron: '0 7 * * *',
      budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1,
      status: 'idle', active: true,
    })
    const got = store.getDepartment('secretary')!
    expect(got.title).toBe('Chief of Staff')
    expect(got.manages).toEqual(['dev'])
    expect(got.skills).toEqual(['brainstorming'])
    store.upsertDepartment({ ...got, title: 'COS v2' })
    expect(store.getDepartment('secretary')!.title).toBe('COS v2')
    expect(store.listDepartments().length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/company-store-departments.test.ts`
Expected: FAIL — `CompanyStore` not exported.

- [ ] **Step 3: Write `src/company/store.ts`**

```typescript
// src/company/store.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/company-store-departments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/store.ts tests/company-store-departments.test.ts
git commit -m "feat(company): CompanyStore departments CRUD"
```

---

### Task 3: CompanyStore — tasks (create, list, atomic claim, update)

**Files:**
- Modify: `src/company/store.ts`
- Test: `tests/company-store-tasks.test.ts`

**Interfaces:**
- Produces (added to `CompanyStore`):
  - `export type Task = { id: string; title: string; body: string | null; project: string | null; dept_id: string | null; status: string; priority: number; origin: string | null; emits_on_done: string | null; corr_id: string | null; request_depth: number; created_at: number; updated_at: number }`
  - `createTask(input: { title: string; body?: string; project?: string; dept_id?: string; priority?: number; origin?: string; emits_on_done?: string; corr_id?: string; request_depth?: number }): Task`
  - `getTask(id: string): Task | null`
  - `listTasks(filter?: { dept_id?: string; status?: string }): Task[]`
  - `claimTask(id: string, runId: string): boolean` — atomic; true if this caller won the claim
  - `updateTaskStatus(id: string, status: string, resultRef?: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-store-tasks.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CompanyStore tasks', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-tasks-'))
    const h = openHubDb(dir); close = h.close
    store = new CompanyStore(h.db)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('create, list by filter, atomic claim once, update status', () => {
    const t = store.createTask({ title: 'Follow up eticket OTA', dept_id: 'secretary', project: 'eticket', status: undefined as any })
    expect(t.id).toBeTruthy()
    expect(store.getTask(t.id)!.title).toBe('Follow up eticket OTA')
    expect(store.listTasks({ dept_id: 'secretary' }).length).toBe(1)

    expect(store.claimTask(t.id, 'run-1')).toBe(true)
    expect(store.claimTask(t.id, 'run-2')).toBe(false) // already claimed

    store.updateTaskStatus(t.id, 'done', 'memory:eticket.ota')
    expect(store.getTask(t.id)!.status).toBe('done')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/company-store-tasks.test.ts`
Expected: FAIL — `createTask` not a function.

- [ ] **Step 3: Add to `src/company/store.ts`**

Add near the top (after `Department`):
```typescript
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
```
Add these methods inside `CompanyStore`:
```typescript
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
    const where: string[] = [], args: unknown[] = []
    if (filter?.dept_id) { where.push('dept_id = ?'); args.push(filter.dept_id) }
    if (filter?.status) { where.push('status = ?'); args.push(filter.status) }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at ASC`
    return this.db.prepare(sql).all(...args).map(taskFromRow)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/company-store-tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/store.ts tests/company-store-tasks.test.ts
git commit -m "feat(company): tasks CRUD + atomic claim"
```

---

### Task 4: CompanyStore — handoffs + activity log

**Files:**
- Modify: `src/company/store.ts`
- Test: `tests/company-store-handoffs.test.ts`

**Interfaces:**
- Produces:
  - `createHandoff(input: { task_id: string; from_dept: string; to_dept: string; reason?: string; payload?: string }): void`
  - `listHandoffs(toDept: string): Array<{ task_id: string; from_dept: string; to_dept: string; reason: string | null }>`
  - `logActivity(a: { actor_type: string; actor: string; action: string; entity_type?: string; entity_id?: string; details?: string }): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-store-handoffs.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore handoffs + activity', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-h-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('handoff is recorded and listed by target dept', () => {
    store.createHandoff({ task_id: 't1', from_dept: 'research', to_dept: 'sales', reason: 'draft outreach' })
    const hs = store.listHandoffs('sales')
    expect(hs.length).toBe(1)
    expect(hs[0].from_dept).toBe('research')
    store.logActivity({ actor_type: 'agent', actor: 'research', action: 'handoff', entity_type: 'task', entity_id: 't1' })
    // no throw == pass
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-store-handoffs.test.ts` → FAIL (`createHandoff` not a function).

- [ ] **Step 3: Add to `src/company/store.ts` (inside `CompanyStore`)**

```typescript
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
```

- [ ] **Step 4: Run** `bun test tests/company-store-handoffs.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/store.ts tests/company-store-handoffs.test.ts
git commit -m "feat(company): handoffs + activity log"
```

---

### Task 5: CompanyStore — shared memory (FTS5 + Markdown mirror)

**Files:**
- Modify: `src/company/store.ts`
- Test: `tests/company-store-memory.test.ts`

**Interfaces:**
- Produces:
  - `writeMemory(input: { scope: string; key: string; value: string; author_dept?: string; source_task?: string }): void` — also appends to `<mirrorDir>/<scope>.md` when a mirror dir is set
  - `searchMemory(query: string, scope?: string): Array<{ scope: string; key: string; value: string }>`
  - `setMemoryMirrorDir(dir: string): void` — where Markdown mirrors are written (e.g. `/home/company/memory`); scope `:` replaced with `_` in filename

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-store-memory.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore memory', () => {
  let dir: string, close: () => void, store: CompanyStore, mirror: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-mem-')); const h = openHubDb(dir); close = h.close
    store = new CompanyStore(h.db); mirror = join(dir, 'memory'); store.setMemoryMirrorDir(mirror)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('write is searchable and mirrored to markdown', () => {
    store.writeMemory({ scope: 'project:eticket', key: 'ota.status', value: 'OTA partner is weak; quiet 6 days', author_dept: 'secretary' })
    const hits = store.searchMemory('OTA partner')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].key).toBe('ota.status')
    const file = join(mirror, 'project_eticket.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('ota.status')
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-store-memory.test.ts` → FAIL.

- [ ] **Step 3: Add to `src/company/store.ts`**

Add imports at top of file:
```typescript
import { mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
```
Add a private field + methods inside `CompanyStore`:
```typescript
  private mirrorDir: string | null = null
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
```

- [ ] **Step 4: Run** `bun test tests/company-store-memory.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/store.ts tests/company-store-memory.test.ts
git commit -m "feat(company): shared memory (FTS5 + markdown mirror)"
```

---

### Task 6: CompanyStore — approvals

**Files:**
- Modify: `src/company/store.ts`
- Test: `tests/company-store-approvals.test.ts`

**Interfaces:**
- Produces:
  - `export type Approval = { id: string; task_id: string | null; dept_id: string | null; kind: string; summary: string; payload: string | null; state: string; requested_at: number }`
  - `createApproval(input: { task_id?: string; dept_id?: string; kind: string; summary: string; payload?: string }): Approval`
  - `resolveApproval(id: string, state: 'approved' | 'denied', note?: string): Approval | null`
  - `listPendingApprovals(): Approval[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-store-approvals.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('CompanyStore approvals', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-ap-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('create -> pending list -> resolve removes from pending', () => {
    const a = store.createApproval({ dept_id: 'sales', kind: 'send_external', summary: 'Send outreach email to OTA partner' })
    expect(store.listPendingApprovals().length).toBe(1)
    const r = store.resolveApproval(a.id, 'approved', 'looks good')!
    expect(r.state).toBe('approved')
    expect(store.listPendingApprovals().length).toBe(0)
    expect(store.resolveApproval('missing', 'denied')).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-store-approvals.test.ts` → FAIL.

- [ ] **Step 3: Add to `src/company/store.ts`**

```typescript
export type Approval = {
  id: string; task_id: string | null; dept_id: string | null
  kind: string; summary: string; payload: string | null; state: string; requested_at: number
}
function approvalFromRow(r: any): Approval {
  return { id: r.id, task_id: r.task_id ?? null, dept_id: r.dept_id ?? null, kind: r.kind, summary: r.summary, payload: r.payload ?? null, state: r.state, requested_at: r.requested_at }
}
```
Inside `CompanyStore`:
```typescript
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
```

- [ ] **Step 4: Run** `bun test tests/company-store-approvals.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/store.ts tests/company-store-approvals.test.ts
git commit -m "feat(company): approvals store"
```

---

### Task 7: Org loader (YAML seats → departments) + seed config

**Files:**
- Create: `src/company/org-loader.ts`
- Create: `/home/company/company.yaml`, `/home/company/seats/secretary.yaml`
- Test: `tests/company-org-loader.test.ts`

**Interfaces:**
- Consumes: `CompanyStore.upsertDepartment`, `Department`.
- Produces: `export function loadOrg(companyDir: string, store: CompanyStore): { loaded: string[] }` — reads every `seats/*.yaml`, validates required fields, upserts each as a Department; returns the loaded seat ids.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-org-loader.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { loadOrg } from '../src/company/org-loader'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('loadOrg', () => {
  let dir: string, close: () => void, store: CompanyStore, company: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-org-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db)
    company = join(dir, 'company'); mkdirSync(join(company, 'seats'), { recursive: true })
    writeFileSync(join(company, 'seats', 'secretary.yaml'),
`id: secretary
title: Chief of Staff
folder: ${company}/desks/secretary
reports_to: mahdi
manages: [dev]
profile: careful
skills: [brainstorming, writing-plans]
mcps: [hub]
schedule_cron: "0 7 * * *"
budget_minutes_week: 240
approval_policy: ask
autonomy_level: 1
`)
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('loads seat yaml into departments table', () => {
    const res = loadOrg(company, store)
    expect(res.loaded).toContain('secretary')
    const d = store.getDepartment('secretary')!
    expect(d.title).toBe('Chief of Staff')
    expect(d.skills).toEqual(['brainstorming', 'writing-plans'])
    expect(d.approval_policy).toBe('ask')
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-org-loader.test.ts` → FAIL.

- [ ] **Step 3: Write `src/company/org-loader.ts`**

```typescript
// src/company/org-loader.ts
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
```

- [ ] **Step 4: Run** `bun test tests/company-org-loader.test.ts` → PASS.

- [ ] **Step 5: Create the real config files** (used at runtime, not by the test):

`/home/company/company.yaml`:
```yaml
name: Mahdi Co
default_approval_policy: ask
weekly_budget_minutes: 1200
```
`/home/company/seats/secretary.yaml`:
```yaml
id: secretary
title: Chief of Staff
folder: /home/company/desks/secretary
reports_to: mahdi
manages: [dev, cto, research, sales, marketing, support, ops]
profile: careful
skills: [brainstorming, writing-plans]
mcps: [hub]
schedule_cron: "0 7,13,19 * * *"
budget_minutes_week: 240
approval_policy: ask
autonomy_level: 1
```

- [ ] **Step 6: Commit**

```bash
git add src/company/org-loader.ts tests/company-org-loader.test.ts
git commit -m "feat(company): YAML org loader"
# (the /home/company config repo is committed separately, outside operant)
```

---

### Task 8: Company tool handler (the `company_*` tools)

**Files:**
- Create: `src/company/tools.ts`
- Test: `tests/company-tools.test.ts`

**Interfaces:**
- Consumes: `CompanyStore`.
- Produces:
  - `export const COMPANY_TOOL_DEFS` — array of MCP tool definitions (name + description + inputSchema) for: `company_get_tasks`, `company_create_task`, `company_claim_task`, `company_update_task`, `company_create_handoff`, `company_write_memory`, `company_search_memory`, `company_request_approval`.
  - `export async function handleCompanyTool(store: CompanyStore, deptId: string, name: string, args: Record<string, unknown>): Promise<string>` — executes the tool, returns a text result. `deptId` is the calling department (the session). For `company_request_approval` it creates a pending approval and returns its id (the daemon wiring in Task 10 forwards it to Telegram).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-tools.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { handleCompanyTool, COMPANY_TOOL_DEFS } from '../src/company/tools'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('company tools', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-tools-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db) })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('defs cover the 8 tools', () => {
    const names = COMPANY_TOOL_DEFS.map(t => t.name)
    for (const n of ['company_get_tasks','company_create_task','company_claim_task','company_update_task','company_create_handoff','company_write_memory','company_search_memory','company_request_approval']) {
      expect(names).toContain(n)
    }
  })

  test('create_task then get_tasks for caller dept', async () => {
    await handleCompanyTool(store, 'secretary', 'company_create_task', { title: 'Brief Mahdi', dept_id: 'secretary' })
    const out = await handleCompanyTool(store, 'secretary', 'company_get_tasks', { status: 'assigned' })
    expect(out).toContain('Brief Mahdi')
  })

  test('request_approval creates a pending approval', async () => {
    const out = await handleCompanyTool(store, 'sales', 'company_request_approval', { kind: 'send_external', summary: 'send email' })
    expect(out).toContain('appr_')
    expect(store.listPendingApprovals().length).toBe(1)
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-tools.test.ts` → FAIL.

- [ ] **Step 3: Write `src/company/tools.ts`**

```typescript
// src/company/tools.ts
import type { CompanyStore } from './store'

export const COMPANY_TOOL_DEFS = [
  { name: 'company_get_tasks', description: 'List tasks assigned to your department. Optional status filter.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'company_create_task', description: 'Create a task on the company board.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' }, dept_id: { type: 'string' }, emits_on_done: { type: 'string' }, corr_id: { type: 'string' } }, required: ['title'] } },
  { name: 'company_claim_task', description: 'Atomically claim a task before working it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, run_id: { type: 'string' } }, required: ['id', 'run_id'] } },
  { name: 'company_update_task', description: 'Update a task status (in_progress|blocked|needs_approval|done|cancelled).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, result_ref: { type: 'string' } }, required: ['id', 'status'] } },
  { name: 'company_create_handoff', description: 'Hand a task to another department.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, to_dept: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'to_dept'] } },
  { name: 'company_write_memory', description: 'Write a durable fact/decision to shared memory.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } }, required: ['scope', 'key', 'value'] } },
  { name: 'company_search_memory', description: 'Search shared memory (full-text).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' } }, required: ['query'] } },
  { name: 'company_request_approval', description: 'Request the CEO\'s approval for an external/irreversible action. Parks the work until approved.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, summary: { type: 'string' }, task_id: { type: 'string' }, payload: { type: 'string' } }, required: ['kind', 'summary'] } },
] as const

export async function handleCompanyTool(store: CompanyStore, deptId: string, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'company_get_tasks': {
      const tasks = store.listTasks({ dept_id: deptId, status: args.status as string | undefined })
      return tasks.length ? JSON.stringify(tasks.map(t => ({ id: t.id, title: t.title, status: t.status, project: t.project }))) : 'No tasks.'
    }
    case 'company_create_task': {
      const t = store.createTask({ title: String(args.title), body: args.body as string, project: args.project as string, dept_id: (args.dept_id as string) ?? deptId, emits_on_done: args.emits_on_done as string, corr_id: args.corr_id as string })
      store.logActivity({ actor_type: 'agent', actor: deptId, action: 'create_task', entity_type: 'task', entity_id: t.id })
      return `Created task ${t.id}: ${t.title}`
    }
    case 'company_claim_task':
      return store.claimTask(String(args.id), String(args.run_id)) ? 'claimed' : 'already-claimed'
    case 'company_update_task':
      store.updateTaskStatus(String(args.id), String(args.status), args.result_ref as string)
      return `Task ${args.id} -> ${args.status}`
    case 'company_create_handoff': {
      store.createHandoff({ task_id: String(args.task_id), from_dept: deptId, to_dept: String(args.to_dept), reason: args.reason as string })
      return `Handed off ${args.task_id} to ${args.to_dept}`
    }
    case 'company_write_memory':
      store.writeMemory({ scope: String(args.scope), key: String(args.key), value: String(args.value), author_dept: deptId })
      return 'memory written'
    case 'company_search_memory': {
      const hits = store.searchMemory(String(args.query), args.scope as string)
      return hits.length ? JSON.stringify(hits) : 'No matches.'
    }
    case 'company_request_approval': {
      const a = store.createApproval({ task_id: args.task_id as string, dept_id: deptId, kind: String(args.kind), summary: String(args.summary), payload: args.payload as string })
      if (args.task_id) store.updateTaskStatus(String(args.task_id), 'needs_approval')
      return `Approval requested (${a.id}). Work parked until the CEO approves.`
    }
    default:
      throw new Error(`unknown company tool: ${name}`)
  }
}
```

- [ ] **Step 4: Run** `bun test tests/company-tools.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/tools.ts tests/company-tools.test.ts
git commit -m "feat(company): company_* tool handler"
```

---

### Task 9: Register `company_*` tools in the shim

**Files:**
- Modify: `src/shim.ts` (add the company tool defs to the `ListToolsRequestSchema` handler)

**Interfaces:**
- Consumes: `COMPANY_TOOL_DEFS` from `src/company/tools.ts`.
- Produces: the connected `claude` session now sees the `company_*` tools; calls route through the existing `tool_call` → daemon path (handled in Task 10).

- [ ] **Step 1: Modify `src/shim.ts`**

Add the import near the top:
```typescript
import { COMPANY_TOOL_DEFS } from './company/tools'
```
In the `mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ ... ] }))` handler, append the company tools to the returned `tools` array, e.g. change the return to:
```typescript
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    /* ...existing reply/edit_message/send_to_session defs unchanged... */
    ...COMPANY_TOOL_DEFS,
  ],
}))
```
(The existing `CallToolRequestSchema` handler already forwards every call by name to the daemon — no change needed there.)

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shim.ts
git commit -m "feat(company): expose company_* tools via shim"
```

---

### Task 10: Daemon executes `company_*` tool calls and forwards approvals

**Files:**
- Modify: `src/daemon.ts`
- Test: `tests/company-daemon-toolcall.test.ts` (unit-tests the dispatch helper, not the live socket)

**Interfaces:**
- Consumes: `CompanyStore`, `handleCompanyTool`, the session registry (to map a session `path` → its department id), `socketServer.sendToSession`.
- Produces:
  - `export function deptIdForPath(path: string, store: CompanyStore): string | null` — maps a connected session's folder to a department by matching `departments.folder`.
  - daemon-side handling: when a `tool_call` whose `name` starts with `company_` arrives, run `handleCompanyTool` and send `{ type: 'tool_result', name, result }` back to that session; if it was `company_request_approval`, also forward an approval prompt to Telegram/Web via the existing permission-forward callback path.

- [ ] **Step 1: Write the failing test (the pure mapping helper)**

```typescript
// tests/company-daemon-toolcall.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openHubDb } from '../src/hub-db'
import { CompanyStore } from '../src/company/store'
import { deptIdForPath } from '../src/daemon'
import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('deptIdForPath', () => {
  let dir: string, close: () => void, store: CompanyStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-dmn-')); const h = openHubDb(dir); close = h.close; store = new CompanyStore(h.db)
    store.upsertDepartment({ id: 'secretary', title: 'COS', folder: '/home/company/desks/secretary', reports_to: 'mahdi', manages: [], profile_name: 'careful', skills: [], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
  })
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }) })

  test('maps folder to dept id, null if unknown', () => {
    expect(deptIdForPath('/home/company/desks/secretary', store)).toBe('secretary')
    expect(deptIdForPath('/home/eticket-v3', store)).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-daemon-toolcall.test.ts` → FAIL (`deptIdForPath` not exported).

- [ ] **Step 3: Modify `src/daemon.ts`**

Add imports near the top:
```typescript
import { CompanyStore } from './company/store'
import { handleCompanyTool } from './company/tools'
import { loadOrg } from './company/org-loader'
```
Add the exported helper (top-level, after imports):
```typescript
export function deptIdForPath(path: string, store: CompanyStore): string | null {
  for (const d of store.listDepartments()) {
    if (d.folder === path) return d.id
  }
  return null
}
```
Inside the daemon bootstrap (where `openHubDb`/the `db` handle is created — the same `db` already used for `hub-db`), instantiate the store, load the org, and set the memory mirror:
```typescript
const companyStore = new CompanyStore(db)            // `db` = the handle from openHubDb(HUB_DIR)
companyStore.setMemoryMirrorDir('/home/company/memory')
try { loadOrg('/home/company', companyStore) } catch (e) { console.error('org load failed', e) }
```
In the existing `tool_call` handler (where the daemon currently delegates `reply`/`send_to_session`; the socketServer emits `('tool_call', path, name, args)`), add a leading branch:
```typescript
socketServer.on('tool_call', async (path: string, name: string, args: Record<string, unknown>) => {
  if (name.startsWith('company_')) {
    const deptId = deptIdForPath(path, companyStore) ?? 'unknown'
    let result: string, isError = false
    try { result = await handleCompanyTool(companyStore, deptId, name, args) }
    catch (e) { result = String(e); isError = true }
    socketServer.sendToSession(path, { type: 'tool_result', name, result, isError })
    if (name === 'company_request_approval' && !isError) {
      // surface the newest pending approval to the CEO via the same relay as permissions
      const pending = companyStore.listPendingApprovals()
      const appr = pending[pending.length - 1]
      if (appr) {
        telegramFrontend?.deliverApprovalRequest?.(appr)
        webFrontend?.deliverApprovalRequest?.(appr)
      }
    }
    return
  }
  // ...existing reply/send_to_session handling unchanged...
})
```
(If the existing handler is structured as a `switch`/`if` rather than a fresh `.on(...)`, insert the `if (name.startsWith('company_')) { ... return }` block at the top of that handler instead of adding a second listener. `deliverApprovalRequest` is added in Task 12.)

- [ ] **Step 4: Run** `bun test tests/company-daemon-toolcall.test.ts` → PASS, and `bunx tsc --noEmit` (the `deliverApprovalRequest?.` optional calls typecheck even before Task 12 because of `?.`).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/company-daemon-toolcall.test.ts
git commit -m "feat(company): daemon executes company_* tools + forwards approvals"
```

---

### Task 11: Loadout — write a seat's `.claude` config at spawn

**Files:**
- Create: `src/company/loadout.ts`
- Test: `tests/company-loadout.test.ts`

**Interfaces:**
- Consumes: `Department`.
- Produces: `export function writeLoadout(dept: Department): void` — ensures `dept.folder` exists and writes `<folder>/.claude/settings.local.json` (enabling only the seat's skills) and `<folder>/.mcp.json` (only the seat's MCP servers, least privilege). MVP writes the files; the `hub` channel is loaded by the spawn flag, so `mcps` here are *extra* servers (empty list ⇒ `.mcp.json` with no servers).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-loadout.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeLoadout } from '../src/company/loadout'
import { mkdtempSync, rmSync, readFileSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'

describe('writeLoadout', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-lo-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('writes settings.local.json with only the seat skills', () => {
    const folder = join(dir, 'desks', 'secretary')
    writeLoadout({ id: 'secretary', title: 'COS', folder, reports_to: 'mahdi', manages: [], profile_name: 'careful', skills: ['brainstorming', 'writing-plans'], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
    const settings = JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8'))
    expect(settings.enabledSkills).toEqual(['brainstorming', 'writing-plans'])
    const mcp = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers).toEqual({})
  })
})
```

- [ ] **Step 2: Run** `bun test tests/company-loadout.test.ts` → FAIL.

- [ ] **Step 3: Write `src/company/loadout.ts`**

```typescript
// src/company/loadout.ts
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Department } from './store'

// Known extra MCP servers a seat may request (least privilege; hub is always present via the spawn flag).
const MCP_REGISTRY: Record<string, { command: string; args: string[] }> = {
  // Example: 'web-search': { command: 'npx', args: ['-y', 'some-web-search-mcp'] },
  // Populated as departments need them; empty for the Secretary MVP.
}

export function writeLoadout(dept: Department): void {
  const claudeDir = join(dept.folder, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  // Skills: only the seat's skills are enabled.
  writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({ enabledSkills: dept.skills }, null, 2))
  // MCP: only the seat's requested extra servers (hub comes from the spawn flag).
  const mcpServers: Record<string, unknown> = {}
  for (const name of dept.mcps) {
    if (name === 'hub') continue // provided by --dangerously-load-development-channels server:hub
    if (MCP_REGISTRY[name]) mcpServers[name] = MCP_REGISTRY[name]
  }
  writeFileSync(join(dept.folder, '.mcp.json'), JSON.stringify({ mcpServers, enableAllProjectMcpServers: false }, null, 2))
}
```

- [ ] **Step 4: Run** `bun test tests/company-loadout.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/company/loadout.ts tests/company-loadout.test.ts
git commit -m "feat(company): per-seat skill/MCP loadout writer"
```

---

### Task 12: spawnDepartment + the `/goal` wake prompt

**Files:**
- Create: `src/company/spawn.ts`
- Create: `src/company/wake-prompt.ts`
- Test: `tests/company-wake-prompt.test.ts`

**Interfaces:**
- Consumes: `Department`, `writeLoadout`, the existing `ScreenManager.spawn(name, projectPath, instructions?, profileName?, resume?)`.
- Produces:
  - `export function buildWakePrompt(dept: Department): string` — the `/goal` instructions string injected at spawn.
  - `export async function spawnDepartment(dept: Department, screen: { spawn: Function }): Promise<void>` — writes loadout, then calls `screen.spawn(dept.id, dept.folder, buildWakePrompt(dept), dept.profile_name ?? undefined)`.

- [ ] **Step 1: Write the failing test (pure prompt builder)**

```typescript
// tests/company-wake-prompt.test.ts
import { describe, test, expect } from 'bun:test'
import { buildWakePrompt } from '../src/company/wake-prompt'

test('wake prompt is a /goal that drains the board and parks external actions', () => {
  const p = buildWakePrompt({ id: 'secretary', title: 'COS', folder: '/d', reports_to: 'mahdi', manages: [], profile_name: null, skills: [], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
  expect(p.startsWith('/goal')).toBe(true)
  expect(p).toContain('company_get_tasks')
  expect(p).toContain('company_request_approval')
  expect(p).toContain('secretary')
})
```

- [ ] **Step 2: Run** `bun test tests/company-wake-prompt.test.ts` → FAIL.

- [ ] **Step 3: Write `src/company/wake-prompt.ts`**

```typescript
// src/company/wake-prompt.ts
import type { Department } from './store'

export function buildWakePrompt(dept: Department): string {
  return [
    `/goal You are the "${dept.title}" department (id: ${dept.id}) of a one-person company. The human CEO is Mahdi.`,
    `Work loop: 1) call company_get_tasks (status "assigned") to see your work. 2) For each task: company_claim_task, do the work, write durable findings with company_write_memory (scope "project:<name>" or "company"), then company_update_task to "done" and company_create_handoff if another department must continue.`,
    `NEVER take an external or irreversible action (sending a message/email, publishing, deploying, paying) directly. Instead call company_request_approval with a clear summary and set the task to needs_approval. Mahdi approves on Telegram.`,
    `When your assigned tasks are drained, post a short brief to the CEO via the reply tool (what you did, what is blocked on him, what is next), then stop. Do not invent new initiatives without a task.`,
  ].join('\n\n')
}
```

- [ ] **Step 4: Write `src/company/spawn.ts`** (thin wiring; the spawn itself is exercised by the manual acceptance test, not a unit test)

```typescript
// src/company/spawn.ts
import { writeLoadout } from './loadout'
import { buildWakePrompt } from './wake-prompt'
import type { Department } from './store'

export async function spawnDepartment(
  dept: Department,
  screen: { spawn: (name: string, projectPath: string, instructions?: string, profileName?: string) => Promise<void> },
): Promise<void> {
  writeLoadout(dept)
  await screen.spawn(dept.id, dept.folder, buildWakePrompt(dept), dept.profile_name ?? undefined)
}
```

- [ ] **Step 5: Run** `bun test tests/company-wake-prompt.test.ts` and `bunx tsc --noEmit` → PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add src/company/spawn.ts src/company/wake-prompt.ts tests/company-wake-prompt.test.ts
git commit -m "feat(company): spawnDepartment + /goal wake prompt"
```

---

### Task 13: Scheduler/orchestrator tick (budget-aware wake)

**Files:**
- Create: `src/company/orchestrator.ts`
- Modify: `src/daemon.ts` (start the tick)
- Test: `tests/company-orchestrator.test.ts`

**Interfaces:**
- Consumes: `CompanyStore`, a "is this seat due now?" cron check, a "minutes used this week" lookup.
- Produces: `export function decideWakes(now: Date, depts: Department[], opts: { maxConcurrent: number; isDue: (cron: string | null, now: Date) => boolean; hasInboxOrAssigned: (deptId: string) => boolean; minutesUsedThisWeek: (deptId: string) => number }): string[]` — pure function returning the seat ids to wake this tick (respects max-concurrent + weekly budget + only-if-work-or-due). The daemon calls this on an interval and `spawnDepartment`s the returned seats.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run** `bun test tests/company-orchestrator.test.ts` → FAIL.

- [ ] **Step 3: Write `src/company/orchestrator.ts`**

```typescript
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
    if (!due && !hasWork) continue                                          // nothing to do
    wake.push(d.id)
    if (wake.length >= opts.maxConcurrent) break
  }
  return wake
}
```

- [ ] **Step 4: Run** `bun test tests/company-orchestrator.test.ts` → PASS.

- [ ] **Step 5: Wire the tick into `src/daemon.ts`**

Near the other `setInterval(...).unref()` lines, add (using `companyStore` from Task 10; implement `isDue` with a tiny cron-minute check or a small cron lib — for MVP a 5-field exact-match check is fine; `minutesUsedThisWeek` sums `compute_ledger` for the ISO week; `hasInboxOrAssigned` checks `listTasks`):
```typescript
import { decideWakes } from './company/orchestrator'
import { spawnDepartment } from './company/spawn'
// ...
setInterval(async () => {
  const depts = companyStore.listDepartments()
  const wake = decideWakes(new Date(), depts, {
    maxConcurrent: 2,
    isDue: (cron, now) => cronDueNow(cron, now),                 // implement cronDueNow (5-field exact match on minute/hour/dow)
    hasInboxOrAssigned: (id) => companyStore.listTasks({ dept_id: id }).some(t => t.status === 'inbox' || t.status === 'assigned'),
    minutesUsedThisWeek: () => 0,                                // MVP: ledger summation is a Phase-4 refinement
  })
  for (const id of wake) {
    const d = companyStore.getDepartment(id)!
    if (registry.findByName(id)) continue                        // already running
    companyStore.upsertDepartment({ ...d, status: 'computing' })
    try { await spawnDepartment(d, screenManager) } catch (e) { console.error('wake failed', id, e) }
  }
}, 60 * 1000).unref()
```
Add a minimal `cronDueNow(cron: string | null, now: Date): boolean` helper in daemon.ts (or `src/company/cron.ts`) that returns false for null and otherwise matches the minute, hour, and day-of-week fields exactly (`*` = any). (Full cron parsing is a Phase-4 item; exact-match covers the Secretary's `0 7,13,19 * * *`.)

- [ ] **Step 6: Run** `bun test` (whole suite) and `bunx tsc --noEmit` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/company/orchestrator.ts src/daemon.ts tests/company-orchestrator.test.ts
git commit -m "feat(company): budget-aware orchestrator tick"
```

---

### Task 14: Telegram — approvals delivery + `/approvals` + appr callbacks

**Files:**
- Modify: `src/frontends/telegram.ts`
- Test: `tests/company-approval-format.test.ts` (pure formatter; the grammy wiring is verified by the manual acceptance test)

**Interfaces:**
- Consumes: `CompanyStore`, `Approval`, the existing `InlineKeyboard` + `bot.api.sendMessage` + `callback_query:data` patterns.
- Produces:
  - `export function formatApproval(a: Approval): string` — the message text shown to the CEO.
  - `TelegramFrontend.deliverApprovalRequest(a: Approval): Promise<void>` — sends the message with `appr:approve:<id>` / `appr:deny:<id>` inline buttons (mirrors `deliverPermissionRequest`).
  - a `/approvals` command listing pending approvals, and `callback_query:data` branches for `appr:approve:` / `appr:deny:` that call `companyStore.resolveApproval(id, ...)` and (on approve) deliver a `channel_message` back into the requesting department's session telling it the action is approved.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/company-approval-format.test.ts
import { test, expect } from 'bun:test'
import { formatApproval } from '../src/frontends/telegram'

test('formats an approval with kind and summary', () => {
  const text = formatApproval({ id: 'appr_1', task_id: 't1', dept_id: 'sales', kind: 'send_external', summary: 'Send outreach email', payload: null, state: 'pending', requested_at: 0 })
  expect(text).toContain('sales')
  expect(text).toContain('send_external')
  expect(text).toContain('Send outreach email')
})
```

- [ ] **Step 2: Run** `bun test tests/company-approval-format.test.ts` → FAIL (`formatApproval` not exported).

- [ ] **Step 3: Modify `src/frontends/telegram.ts`**

Add the exported formatter (top-level):
```typescript
import type { Approval } from '../company/store'
export function formatApproval(a: Approval): string {
  return `🏢 Approval from <b>${a.dept_id}</b>\nAction: <code>${a.kind}</code>\n${a.summary}`
}
```
Add a method on the `TelegramFrontend` class (mirror `deliverPermissionRequest`):
```typescript
async deliverApprovalRequest(a: Approval): Promise<void> {
  const recipients = this.recipients()
  if (recipients.length === 0) return
  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `appr:approve:${a.id}`)
    .text('❌ Deny', `appr:deny:${a.id}`)
  for (const userId of recipients) {
    await this.bot.api.sendMessage(userId, formatApproval(a), { parse_mode: 'HTML', reply_markup: keyboard })
  }
}
```
Register the `/approvals` command (mirror the `/list` command pattern):
```typescript
bot.command('approvals', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  const pending = this.companyStore.listPendingApprovals()
  if (pending.length === 0) { await ctx.reply('No pending approvals.'); return }
  for (const a of pending) await this.deliverApprovalRequest(a)
})
```
In the existing `bot.on('callback_query:data', ...)` handler, add branches (mirror the `perm:allow:`/`perm:deny:` branches):
```typescript
} else if (data.startsWith('appr:approve:') || data.startsWith('appr:deny:')) {
  const approve = data.startsWith('appr:approve:')
  const id = data.slice((approve ? 'appr:approve:' : 'appr:deny:').length)
  const a = this.companyStore.resolveApproval(id, approve ? 'approved' : 'denied')
  if (!a) { await ctx.answerCallbackQuery('Approval not found'); return }
  await ctx.answerCallbackQuery(approve ? 'Approved' : 'Denied')
  await ctx.editMessageText(`${approve ? '✅ Approved' : '❌ Denied'}: ${a.summary}`)
  if (a.dept_id) {
    const dept = this.companyStore.getDepartment(a.dept_id)
    const path = dept ? this.registry.findByName(dept.id) : undefined
    if (path) this.socketServer.sendToSession(path, { type: 'channel_message', content: `[CEO ${approve ? 'APPROVED' : 'DENIED'} approval ${id}: ${a.summary}]`, meta: { source: 'company', frontend: 'telegram', user: 'mahdi' } })
  }
}
```
Pass `companyStore` into the `TelegramFrontend` constructor (add a constructor param and store it as `this.companyStore`; update the instantiation in `daemon.ts` to pass `companyStore`).

- [ ] **Step 4: Run** `bun test tests/company-approval-format.test.ts` and `bunx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/telegram.ts src/daemon.ts tests/company-approval-format.test.ts
git commit -m "feat(company): Telegram approval delivery + /approvals"
```

---

### Task 15: Telegram — `/board` and `/brief`

**Files:**
- Modify: `src/frontends/telegram.ts`
- Test: `tests/company-board-format.test.ts`

**Interfaces:**
- Produces:
  - `export function formatBoard(tasks: Task[]): string` — compact list grouped by status.
  - `/board` command (lists current tasks), `/brief` command (asks the Secretary to produce a brief now by routing a `channel_message` to its session, or shows the latest memory-scoped summary if it is not running).

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run** `bun test tests/company-board-format.test.ts` → FAIL.

- [ ] **Step 3: Modify `src/frontends/telegram.ts`**

Add the exported formatter:
```typescript
import type { Task } from '../company/store'
export function formatBoard(tasks: Task[]): string {
  if (tasks.length === 0) return 'Board is empty.'
  const byStatus = new Map<string, Task[]>()
  for (const t of tasks) { (byStatus.get(t.status) ?? byStatus.set(t.status, []).get(t.status)!).push(t) }
  const lines: string[] = []
  for (const [status, ts] of byStatus) {
    lines.push(`• ${status}:`)
    for (const t of ts) lines.push(`   - [${t.dept_id ?? '—'}] ${t.title}${t.project ? ' (' + t.project + ')' : ''}`)
  }
  return lines.join('\n')
}
```
Register the commands (mirror `/list`):
```typescript
bot.command('board', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  await ctx.reply(formatBoard(this.companyStore.listTasks()))
})
bot.command('brief', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  const path = this.registry.findByName('secretary')
  if (path) {
    this.socketServer.sendToSession(path, { type: 'channel_message', content: 'Produce a short brief now: what is blocked on me and what is next.', meta: { source: 'company', frontend: 'telegram', user: 'mahdi' } })
    await ctx.reply('Asked the Secretary for a brief.')
  } else {
    await ctx.reply('Secretary is not running right now; it will brief on its next scheduled wake.')
  }
})
```

- [ ] **Step 4: Run** `bun test tests/company-board-format.test.ts` and `bunx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/telegram.ts tests/company-board-format.test.ts
git commit -m "feat(company): Telegram /board and /brief"
```

---

### Task 16: Secretary desk + end-to-end wiring + acceptance

**Files:**
- Create: `/home/company/desks/secretary/CLAUDE.md` (the persona; loadout writes `.claude/*` at spawn)
- Create: `/home/company/memory/` (dir; created on first memory write)
- Modify: `src/daemon.ts` (ensure org is loaded on boot and the Secretary desk folder exists)
- Test: full suite + manual acceptance

**Interfaces:** none new — this task wires the pieces and verifies the spec's MVP acceptance test.

- [ ] **Step 1: Write the Secretary persona**

`/home/company/desks/secretary/CLAUDE.md`:
```markdown
# Secretary / Chief of Staff

You are the Chief of Staff of Mahdi's one-person company. You do not write product code.
Your job each wake: read the company board, advance your tasks, keep shared memory current,
route work to the right department via handoffs, and brief Mahdi on what is blocked on him.
Never send anything external or irreversible — always use company_request_approval and let Mahdi decide.
Keep briefs short and concrete.
```

- [ ] **Step 2: Ensure boot wiring**

Confirm `daemon.ts` (from Tasks 10 & 13) on startup: opens `hub.sqlite`, constructs `CompanyStore`, sets the memory mirror dir to `/home/company/memory`, calls `loadOrg('/home/company', companyStore)`, passes `companyStore` to `TelegramFrontend`, and starts the orchestrator interval. Add a guard that creates `/home/company/desks/secretary` if missing (so the first spawn has a cwd):
```typescript
import { mkdirSync } from 'fs'
mkdirSync('/home/company/desks/secretary', { recursive: true })
```

- [ ] **Step 3: Run the full unit suite**

Run: `bun test`
Expected: all company tests pass alongside the existing suite; no regressions. Then `bunx tsc --noEmit` clean.

- [ ] **Step 4: Manual acceptance (the spec's MVP test)**

```bash
# 1. confirm subscription auth (no API key)
ANTHROPIC_API_KEY= claude /status          # shows subscription, not API
# 2. (re)start the daemon
sudo systemctl restart operant && sudo systemctl status operant
# 3. from Telegram, message the hub:
#    "Track the eticket OTA partner follow-up."
# 4. /board  -> shows a task for the secretary
# 5. wait for the secretary's scheduled wake (or temporarily set schedule_cron to the next minute and reload),
#    or run: operant spawn secretary /home/company/desks/secretary  (manual wake)
# 6. /brief -> secretary replies with a brief
# 7. Ask it to "send an intro email to the OTA partner" -> it calls company_request_approval;
#    Telegram shows Approve/Deny; tapping Deny cancels, Approve passes control back to the dept.
# 8. restart the daemon: sudo systemctl restart operant ; /board still shows the task (state survived).
```
Expected: task created, memory written (check `/home/company/memory/project_eticket.md`), brief delivered, an external action parks for approval, and state survives a restart — all on the subscription with no API key.

- [ ] **Step 5: Commit**

```bash
cd /home/operant
git add src/daemon.ts
git commit -m "feat(company): MVP end-to-end wiring (Secretary)"
# commit the company config repo separately:
cd /home/company && git init -q && git add -A && git commit -q -m "company: secretary seat + persona"
```

---

## Self-Review

- **Spec coverage:** shared SQLite brain (T1), CompanyStore org/tasks/handoffs/memory/approvals/activity (T2–T6), YAML org (T7), `company_*` tools + shim + daemon execution (T8–T10), per-seat skills/MCP loadout (T11), spawn + `/goal` wake prompt (T12), budget-aware orchestrator (T13), human approval gate over Telegram (T14), `/board`+`/brief` (T15), Secretary pilot + acceptance (T16). Deferred-but-structure-ready (Dev/other depts, cron-lib, ledger summation, memory decay, multi-company) are explicitly out of MVP scope per the spec and need no new tables.
- **Placeholders:** none — every code step contains real code; the two acknowledged simplifications (exact-match `cronDueNow`, `minutesUsedThisWeek` returning 0 in MVP) are labeled Phase-4 refinements, not silent TODOs.
- **Type consistency:** `Department`, `Task`, `Approval` types defined in `store.ts` (T2/T3/T6) are the ones imported by `org-loader`, `tools`, `loadout`, `wake-prompt`, `orchestrator`, and `telegram`. Tool names match between `COMPANY_TOOL_DEFS` and `handleCompanyTool` (T8). `deliverApprovalRequest` is called optionally in T10 and defined in T14.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-company-engine-mvp.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
