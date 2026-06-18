# Company Engine — Design Spec (full structure + MVP)

Date: 2026-06-17
Status: design, pending approval
Owner: Mahdi (sole human / CEO)

## Context

Mahdi is a solo founder running many projects (his startups, some SaaS) plus client work. He needs one system that lets him operate like a fully-staffed company: AI "employees" staff departments and do real work across **all** functions (not just code), while he directs and approves from his phone. Today `operant` only shows isolated windows — one Claude session per project, no shared state, no company. This spec defines a **centralized company engine** that extends operant into an actual company, and an **MVP** to start.

The structure below is the **final target** so future work plugs in without re-architecting. Each piece is tagged **[MVP]** (built first) or **[later]** (structure defined now, built in a later phase).

## Hard constraints (non-negotiable)

- Runs ONLY on Mahdi's $200 Claude Max subscription via the official `claude` CLI. **No API key, no token proxies.** `ANTHROPIC_API_KEY` stays unset.
- Only first-party features: `claude` CLI, `/loop`, `/goal`, Channels, Agent Teams, subagents, skills, MCP.
- **Solo / individual use** — only Mahdi; agents serve him; no other humans, no external users routed through his credentials. This is what keeps it compliant.
- Built by **extending operant** (Bun/TypeScript daemon, Unix-socket shim, Telegram/web/CLI frontends, permission relay, profiles, SQLite `hub.sqlite`, systemd). Reuse primitives; don't rebuild.
- Runs on Mahdi's VPSes (Germany/UK/US, open internet) for dev + prod; controlled from Iraq via the Rubika→Telegram bridge (mobile, can be fragile → async, not real-time).
- Rate budget: Max 20x ≈ ~300 weekly active-compute hours, **pooled across all sessions**. Keep sessions idle by default; few active at once; staggered.

## Architecture (recommended)

A graft of three approaches:
- **Engine = a shared "company brain":** one SQLite store the daemon owns (the single source of truth). This is the fix for "isolated windows" — departments coordinate by reading/writing the same rows, never by talking directly.
- **Org = declarative YAML** (`/home/company/`): Mahdi edits the company as version-controlled config; the daemon runs it from the DB.
- **Handoffs = data:** a finished task auto-creates the next task for the next department (no live event bus — just rows + an orchestrator that polls and routes).

One writer (the daemon), many readers (departments call `company_*` MCP tools the daemon executes). SQLite WAL for concurrent reads.

## Repository / directory structure (full target)

```
/home/company/                      # NEW config repo (git), the editable company  [MVP: minimal]
  company.yaml                      # company-level settings, budget, defaults     [MVP]
  seats/                            # one file per department (the org chart)
    secretary.yaml                  # [MVP]
    dev.yaml                        # [Phase 2]
    cto.yaml  research.yaml  sales.yaml  marketing.yaml  support.yaml  ops.yaml   [Phase 3]
  registry/
    skills.yaml                     # catalog of available skills + trust level    [MVP: seed]
    mcp.yaml                        # catalog of available MCP servers             [MVP: seed]
  policy/
    approval.yaml                   # what always needs human approval             [MVP]
  goals/                            # company/project goals (the "why")            [later]
  memory/                           # human-readable shared memory mirror (md)     [MVP: secretary]

/home/operant/src/company/       # NEW engine modules (operant style)
  schema.ts        # append company tables to hub.sqlite                           [MVP]
  store.ts         # typed CRUD; the ONLY writer of company state                  [MVP]
  org-loader.ts    # read+validate /home/company/*.yaml -> departments table       [MVP]
  loadout.ts       # resolve a seat's skills/mcps -> write .claude config at spawn  [MVP]
  router.ts        # route(task) -> seatId via org-graph edges; create handoffs     [MVP: basic]
  orchestrator.ts  # tick loop: read board+schedule, wake 1-3 seats, dispatch       [MVP: basic]
  scheduler.ts     # cron per seat + rate-budget token bucket                       [MVP: basic]
  approval.ts      # company action -> existing Telegram approval relay             [MVP]
  dept-bridge.ts   # the company_* MCP tools depts call (via the shim)              [MVP]
  taskboard-mcp.ts # CORE MCP server: the task board (local stdio)                  [MVP]
  memory-mcp.ts    # CORE MCP server: shared memory, FTS5 (local stdio)             [MVP]
```

## The shared company data model (in `hub.sqlite`)

Full target schema (all tables defined now; MVP populates a subset).

```sql
-- ORG / SEATS (mirrors /home/company/seats/*.yaml)                       [MVP]
CREATE TABLE departments (
  id TEXT PRIMARY KEY,            -- 'secretary','dev','cto','sales',...
  title TEXT NOT NULL, folder TEXT NOT NULL,        -- its own claude cwd
  reports_to TEXT, manages_json TEXT,               -- org-graph edges
  profile_name TEXT,                                -- reuses profiles.json
  skills_json TEXT NOT NULL, mcp_json TEXT NOT NULL,-- the per-role loadout
  schedule_cron TEXT, budget_minutes_week INTEGER,  -- rate-pool slice
  approval_policy TEXT NOT NULL,                    -- strict|ask|auto|yolo
  autonomy_level INTEGER NOT NULL DEFAULT 1,        -- earned-autonomy ladder L1..L3
  status TEXT NOT NULL DEFAULT 'idle',              -- idle|computing|blocked
  active INTEGER NOT NULL DEFAULT 1,
  company_id TEXT NOT NULL DEFAULT 'default'        -- multi-venture ready
);

-- TASK BOARD (the shared work surface)                                   [MVP]
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  project TEXT, dept_id TEXT REFERENCES departments(id),
  status TEXT NOT NULL,           -- inbox|assigned|in_progress|blocked|needs_approval|done|cancelled
  priority INTEGER DEFAULT 3, origin TEXT,          -- 'mahdi'|'dept:secretary'|'schedule'
  blocked_by TEXT,                                  -- JSON array of task ids
  emits_on_done TEXT,                               -- auto-handoff target
  corr_id TEXT,                                     -- threads one "story"
  checkout_run_id TEXT, execution_locked_at INTEGER,-- atomic claim
  request_depth INTEGER DEFAULT 0,                  -- delegation hops (cap = 3)
  created_at INTEGER, updated_at INTEGER, due_at INTEGER, result_ref TEXT,
  company_id TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX idx_tasks_status ON tasks(status, priority DESC);
CREATE INDEX idx_tasks_dept   ON tasks(dept_id, status);

-- HANDOFFS (inter-department coordination, first-class)                  [MVP]
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
  from_dept TEXT, to_dept TEXT, reason TEXT, payload TEXT, ts INTEGER
);

-- SHARED MEMORY (FTS5, not embeddings -> offline, no API)               [MVP]
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,            -- 'company'|'project:eticket'|'dept:sales'|'client:X'
  key TEXT NOT NULL, value TEXT NOT NULL,
  source_task TEXT, author_dept TEXT, ts INTEGER NOT NULL,
  pinned INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0   -- decay/prune [later]
);
CREATE INDEX idx_memory_scope_key ON memory(scope, key);
CREATE VIRTUAL TABLE memory_fts USING fts5(value, key, scope);

-- APPROVALS (the human gate, company-level)                             [MVP]
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), dept_id TEXT,
  kind TEXT,                       -- send_external|deploy|spend|irreversible|new_seat
  summary TEXT NOT NULL, payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired
  requested_at INTEGER, resolved_at INTEGER, decision_note TEXT
);

-- COMPUTE LEDGER (rate-pool accounting, in minutes not dollars)         [MVP: write]
CREATE TABLE compute_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dept_id TEXT,
  started_at INTEGER, ended_at INTEGER, minutes REAL, week TEXT
);

-- ACTIVITY LOG (append-only audit)                                      [MVP]
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
  details TEXT, ts INTEGER NOT NULL
);
```

## The full department roster (org chart)

Mahdi = human CEO (no agent seat; the approver). AI departments:

| Dept | Job | Phase |
|---|---|---|
| Secretary / Chief-of-Staff | Daily brief, watches the whole board, routes work, drafts follow-ups, chases stale items | MVP |
| Dev | Per-project coding (`/goal` "work until done"), staggered | Phase 2 |
| CTO | Triages tech work, turns intent into dev tasks, reviews | Phase 3 |
| Research | Market/competitor/customer briefs | Phase 3 |
| Sales / BD | Drafts outreach/proposals, tracks pipeline | Phase 3 |
| Marketing | Landing copy, posts, announcements | Phase 3 |
| Support | Watches product inboxes, drafts replies, files bugs | Phase 3 |
| Ops / Bookkeeper | Deploys (gated), invoices, runway prep | Phase 3 |

### Seat YAML schema (the shape every department uses)

```yaml
# /home/company/seats/secretary.yaml
id: secretary
title: Chief of Staff
folder: /home/company/desks/secretary       # its claude cwd
reports_to: mahdi
manages: [dev, cto, research, sales, marketing, support, ops]
profile: careful                              # reuses operant profiles
skills: [brainstorming, writing-plans, schedule, loop, route-task, approval-digest]
mcps:   [hub, taskboard, memory, telegram, web-search]   # hub/taskboard/memory = CORE
schedule_cron: "0 7,13,19 * * *"              # 3x/day, staggered
budget_minutes_week: 240
approval_policy: ask                          # strict|ask|auto|yolo
autonomy_level: 1                             # earned-autonomy ladder
```

## How it works (the coordination model)

1. One shared world — all tasks/memory/decisions live in `hub.sqlite`. A department holds nothing in its own head; it queries at wake, writes back at sleep.
2. Tasks carry `dept_id` + `project`, not a window — work crosses departments as data.
3. Handoffs are first-class + automatic — on task done, the orchestrator reads `emits_on_done` and creates the next task for the receiving dept.
4. Shared memory replaces re-explaining — "eticket's OTA partner is weak" is one memory row every dept reads.
5. `corr_id` threads one story — all activity for one deal/project reads as one narrative.
6. The daemon is the integration point — not Mahdi's head over a flaky link.

### Per-department skills + MCP (the "right tools" requirement)
The loadout is data in the seat YAML, enforced automatically at spawn by `loadout.ts`:
- Skills: write `<folder>/.claude/settings.local.json` enabling only the seat's skills; bespoke skills in `<folder>/.claude/skills/`.
- MCP: write `<folder>/.mcp.json` with only the seat's servers (least privilege — no `telegram`/send MCP means a Dev seat physically cannot message a customer).
- CORE in every seat: `hub` (permission relay + channels), `taskboard` (the board), `memory` (FTS5 store), and `/loop`.

### The loop's place (one tool, not the center)
- Company clock = the daemon orchestrator tick + cron.
- `/goal` = the wake prompt for one department ("drain your assigned tasks, write results to memory, set status, emit handoffs; stop when none remain or you hit an approval gate"). Bounded by board state → no runaway.
- `/loop` = used sparingly, only where a heartbeat is needed; daemon owns its on/off; exits on empty inbox so it never burns the pool idling.

### Human-approval gate
Reuse operant's permission relay + autopilot + veto. Add a company-level tier: a dept calls `company_request_approval` instead of doing the external/irreversible thing → writes an `approvals` row → routed to Telegram (same buttons, same race-to-respond, same veto window).
- Always-human (never automatic, ever): money, auth/credentials, legal, anything external or irreversible.
- `approval_policy` per dept sets the baseline; **earned-autonomy ladder**: a dept starts L1 (approval-required); only after measured clean runs may Mahdi raise it to L2 (supervised auto for low-risk) / L3. The always-human list never graduates.

### Rate-budget protection (the #1 risk)
- Every wake is daemon-owned; default state idle.
- Two-tier check: a cheap deterministic script decides whether to wake a Claude session at all.
- `scheduler.ts` token-bucket enforces `max_concurrent_sessions` (1–3) + `budget_minutes_week` from `compute_ledger`; refuse-to-wake-past-budget (queue instead); staggered cron.

## How it bolts onto operant

ADD: `/home/company/` config repo; `src/company/*.ts` modules; `taskboard-mcp.ts` + `memory-mcp.ts`.
MODIFY (light): `hub-db.ts` (append tables); `types.ts` (`Profile` gains `skills[]`/`mcps[]`); `profiles.ts` (resolve loadout); `screen-manager.ts` (`spawnDepartment(seatId)` runs loadout then spawn with `/goal`); `shim.ts` (register `company_*` tools); `daemon.ts` (start orchestrator+scheduler, wire approvals into the permission-forward callback); `frontends/telegram.ts` (`/board`, `/brief`, `/approvals`, `/wake`, `/depts`).
REUSE UNCHANGED: socket server, permission engine core, autopilot/veto, verification runner, `task-monitor.ts` (intra-team), `session-registry.ts`, `sessions.json`, systemd.

## MVP (what we build first)

Goal of the MVP: stand up the full structure with ONE working department (Secretary) so it's immediately useful and everything later just plugs in.

In the MVP:
- Phase 0 — Substrate: add the company tables to `hub.sqlite` (`schema.ts`); `store.ts` (the only writer); `org-loader.ts` reading `seats/secretary.yaml`.
- Phase 1 — Secretary department: `taskboard-mcp.ts` + `memory-mcp.ts` (CORE), `dept-bridge.ts` `company_*` tools in the shim; `loadout.ts` writing the Secretary's `.claude` config; `spawnDepartment('secretary')` with the `/goal` wake prompt; `scheduler.ts` waking it on cron (staggered, budgeted); `approval.ts` + Telegram `/board`, `/brief`, `/approvals`.

Deferred but structure-ready (no refactor later): Dev (Phase 2), the other 6 departments via YAML (Phase 3), hardening — cycle-depth guard, dead-letter, approval digests, memory decay/prune, multi-company (Phase 4).

### MVP acceptance test
From Telegram, Mahdi sends: "Track the eticket OTA partner follow-up."
- Secretary creates a task on the board, writes a memory note, and on its next scheduled wake sends a daily brief ("blocked on you: …").
- An action that would go external (e.g. "send this message") parks as a `needs_approval` task and shows Mahdi an Approve/Edit/Deny prompt on Telegram; approving executes, denying cancels.
- Restart the daemon → tasks, memory, and pending approvals survive (loaded from `hub.sqlite`).
- `claude /status` confirms subscription auth (no API key) during all of the above.

## Risks + mitigations

- Rate-pool burn (highest): idle-by-default, two-tier cheap-check, 1–3 concurrent, budget gate, staggered cron, board-state stop conditions.
- Context rot: sessions are short-lived (wake → drain → write back → exit); the store is the memory.
- Over-autonomy: company approval gate mandatory for external/irreversible; least-privilege MCP; earned-autonomy ladder; money/auth/legal never automatic.
- Coordination failure: atomic `claim_task`; unmatched tasks → Secretary inbox; dead-letter + brief surfaces stuck items; call-depth ≤ 3 on handoff chains.
- Fragile phone link: everything persists; orchestrator resumes on restart; seats run on the VPS on schedule whether or not Mahdi is connected; he reads one brief and approves when reconnected; approvals batch.
- Prompt injection from inbound content: never auto-approve from channel/email/web content; human gate on all external writes.

## Compliance
Subscription-only via official `claude` CLI (no API key, no proxy); solo/individual use (only Mahdi; agents are internal plumbing); every external/irreversible action gated on Mahdi's Telegram tap. The design reinforces the single-human boundary rather than straining it.

## Decisions (confirmed by Mahdi, 2026-06-17)
1. Department desks live under `/home/company/desks/<seat>/`, separate from project repos. The Dev seat operates inside the actual project repo (e.g. `/home/eticket-v3`). CONFIRMED.
2. Keep a human-readable Markdown mirror of `memory` under `/home/company/memory/` (Mahdi can read/edit by hand) alongside the SQLite store. CONFIRMED.
3. MVP department = Secretary first. CONFIRMED.
