# Agent Teams Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent teams support to Claude Code Operant — multiple sessions per folder form a team (first=lead, rest=teammates), with grouped sidebar UI, task monitoring, and spawn dialog with team checkbox.

**Architecture:** The session registry changes from path-keyed to sessionId-keyed (`path:index`). The socket server allows multiple connections from the same folder, assigning incrementing indices. A new TaskMonitor module watches `~/.claude/tasks/` for agent team task files. The web UI groups teammates under their lead in the sidebar, and the spawn dialog gets a team checkbox.

**Tech Stack:** Bun, TypeScript (existing stack). fs.watch for task monitoring.

---

## File Structure

```
Modified:
  src/types.ts               # Add teamIndex, teamSize to SessionState/Config
  src/session-registry.ts     # path:index keys, getTeam(), allow multi-session per path
  src/socket-server.ts        # Allow duplicate paths, assign team indices
  src/screen-manager.ts       # spawnTeam() method, AGENT_TEAMS env var
  src/frontends/web-client.html  # Grouped sidebar, team spawn checkbox, [+] button, task view
  src/frontends/web.ts        # /api/team-tasks endpoint
  src/frontends/telegram.ts   # /team command
  src/daemon.ts               # Wire task monitor

Created:
  src/task-monitor.ts         # Watch ~/.claude/tasks/ for agent team task files
  tests/task-monitor.test.ts
```

---

## Task 1: Update Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add team fields to SessionState and SessionConfig**

Add to `SessionConfig`:
```typescript
export type SessionConfig = {
  name: string
  trust: TrustLevel
  prefix: string
  uploadDir: string
  managed: boolean
  teamIndex: number       // 0 = lead or solo, 1+ = teammate
  teamSize: number        // 0 = solo, N = team of N
}
```

Add to `SessionState` (already extends SessionConfig, so it inherits the fields).

- [ ] **Step 2: Commit**

```bash
git add src/types.ts && git commit -m "feat: add teamIndex and teamSize to session types"
```

---

## Task 2: Update Session Registry

**Files:**
- Modify: `src/session-registry.ts`
- Modify: `tests/session-registry.test.ts`

- [ ] **Step 1: Write failing tests for team support**

```typescript
// Add to tests/session-registry.test.ts

test('register allows multiple sessions from same folder with different indices', () => {
  const s1 = registry.register('/home/user/app:0')
  const s2 = registry.register('/home/user/app:1')
  expect(s1.name).toBe('app')
  expect(s2.name).toBe('app-2')
  expect(registry.list().length).toBe(2)
})

test('getTeam returns all sessions for a folder path', () => {
  registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 3 })
  registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 3 })
  registry.register('/home/user/app:2', { teamIndex: 2, teamSize: 3 })
  const team = registry.getTeam('/home/user/app')
  expect(team.length).toBe(3)
  expect(team[0].teamIndex).toBe(0)
})

test('getTeamLead returns the index-0 session', () => {
  registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 2 })
  registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 2 })
  const lead = registry.getTeamLead('/home/user/app')
  expect(lead?.teamIndex).toBe(0)
})

test('nextTeamIndex returns next available index', () => {
  registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 2 })
  registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 2 })
  expect(registry.nextTeamIndex('/home/user/app')).toBe(2)
})

test('folderPath extracts path without index', () => {
  expect(registry.folderPath('/home/user/app:0')).toBe('/home/user/app')
  expect(registry.folderPath('/home/user/app')).toBe('/home/user/app')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/session-registry.test.ts
```

- [ ] **Step 3: Implement team support in registry**

Add methods to `SessionRegistry`:

```typescript
// Extract folder path from session key (strip :index suffix)
folderPath(sessionKey: string): string {
  const idx = sessionKey.lastIndexOf(':')
  if (idx > 0 && /^\d+$/.test(sessionKey.slice(idx + 1))) {
    return sessionKey.slice(0, idx)
  }
  return sessionKey
}

// Get all sessions for a folder path
getTeam(folderPath: string): SessionState[] {
  return [...this.sessions.values()]
    .filter(s => this.folderPath(s.path) === folderPath)
    .sort((a, b) => (a.teamIndex ?? 0) - (b.teamIndex ?? 0))
}

// Get team lead (index 0) for a folder
getTeamLead(folderPath: string): SessionState | undefined {
  return this.getTeam(folderPath).find(s => s.teamIndex === 0)
}

// Get next available team index for a folder
nextTeamIndex(folderPath: string): number {
  const team = this.getTeam(folderPath)
  if (team.length === 0) return 0
  return Math.max(...team.map(s => s.teamIndex ?? 0)) + 1
}
```

Update `register()` to set default `teamIndex: 0` and `teamSize: 0`:

```typescript
register(path: string, overrides?: Partial<SessionConfig>): SessionState {
  if (this.sessions.has(path)) {
    throw new Error(`Session for ${path} already registered`)
  }
  const folder = this.folderPath(path)
  const baseName = overrides?.name ?? basename(folder)
  const name = this.uniqueName(baseName)
  const session: SessionState = {
    path,
    name,
    trust: overrides?.trust ?? this.options.defaultTrust,
    prefix: overrides?.prefix ?? '',
    uploadDir: overrides?.uploadDir ?? this.options.defaultUploadDir,
    managed: overrides?.managed ?? false,
    teamIndex: overrides?.teamIndex ?? 0,
    teamSize: overrides?.teamSize ?? 0,
    status: 'active',
    connectedAt: Date.now(),
  }
  this.sessions.set(path, session)
  return session
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/session-registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/session-registry.ts tests/session-registry.test.ts && git commit -m "feat: session registry supports teams with path:index keys"
```

---

## Task 3: Update Socket Server for Teams

**Files:**
- Modify: `src/socket-server.ts`
- Modify: `tests/socket-server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to tests/socket-server.test.ts

test('allows second connection from same folder as teammate', async () => {
  // First connection (lead)
  const sock1 = connect(TEST_SOCK)
  await new Promise<void>(r => sock1.on('connect', r))
  sendLine(sock1, { type: 'register', cwd: '/home/user/myproject' })
  const data1 = await new Promise<string>(resolve => {
    sock1.once('data', (chunk) => resolve(chunk.toString()))
  })
  const msg1 = JSON.parse(data1.trim())
  expect(msg1.type).toBe('registered')
  expect(msg1.sessionName).toBe('myproject')

  // Second connection (teammate)
  const sock2 = connect(TEST_SOCK)
  await new Promise<void>(r => sock2.on('connect', r))
  sendLine(sock2, { type: 'register', cwd: '/home/user/myproject' })
  const data2 = await new Promise<string>(resolve => {
    sock2.once('data', (chunk) => resolve(chunk.toString()))
  })
  const msg2 = JSON.parse(data2.trim())
  expect(msg2.type).toBe('registered')
  expect(msg2.sessionName).toBe('myproject-2')
  expect(registry.list().length).toBe(2)

  sock1.end()
  sock2.end()
})
```

- [ ] **Step 2: Run tests to verify it fails**

```bash
bun test tests/socket-server.test.ts
```

- [ ] **Step 3: Update handleMessage register logic**

Replace the register case in `handleMessage`:

```typescript
case 'register': {
  const folder = msg.cwd
  const nextIndex = this.registry.nextTeamIndex(folder)
  const sessionKey = `${folder}:${nextIndex}`

  // Check if this exact key is active (shouldn't happen, but safety check)
  const existing = this.registry.get(sessionKey)
  if (existing && existing.status === 'active') {
    this.send(socket, { type: 'rejected', reason: `Session ${sessionKey} already active` })
    socket.end()
    return
  }

  if (existing && existing.status === 'disconnected') {
    this.registry.reconnect(sessionKey)
  } else {
    const teamSize = this.registry.getTeam(folder).length + 1
    this.registry.register(sessionKey, {
      teamIndex: nextIndex,
      teamSize,
    })
  }

  setPath(sessionKey)
  this.connections.set(sessionKey, socket)
  const session = this.registry.get(sessionKey)!
  this.send(socket, { type: 'registered', sessionName: session.name })
  this.emit('session:connected', sessionKey)
  break
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/socket-server.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/socket-server.ts tests/socket-server.test.ts && git commit -m "feat: socket server allows multiple sessions per folder as team"
```

---

## Task 4: Update Screen Manager for Team Spawn

**Files:**
- Modify: `src/screen-manager.ts`
- Modify: `tests/screen-manager.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Add to tests/screen-manager.test.ts

test('spawnTeam is a function', () => {
  expect(typeof manager.spawnTeam).toBe('function')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/screen-manager.test.ts
```

- [ ] **Step 3: Add CLAUDE_TEAM_CMD and spawnTeam method**

Add constant:
```typescript
const CLAUDE_TEAM_CMD = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-load-development-channels server:operant'
```

Add method:
```typescript
async spawnTeam(name: string, projectPath: string, size: number): Promise<void> {
  // Spawn lead first
  const leadName = name
  const leadSession = `operant-${leadName}`
  try { await $`tmux kill-session -t ${leadSession}`.quiet() } catch {}
  await $`tmux new-session -d -s ${leadSession} -c ${projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
  this.managed.set(leadName, { sessionName: leadSession, projectPath, respawnEnabled: true })
  this.autoConfirm(leadSession)

  // Wait for lead to initialize
  await new Promise(r => setTimeout(r, 5000))

  // Spawn teammates
  for (let i = 2; i <= size; i++) {
    const tmName = `${name}-${i}`
    const tmSession = `operant-${tmName}`
    try { await $`tmux kill-session -t ${tmSession}`.quiet() } catch {}
    await $`tmux new-session -d -s ${tmSession} -c ${projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
    this.managed.set(tmName, { sessionName: tmSession, projectPath, respawnEnabled: true })
    this.autoConfirm(tmSession)
    // Small delay between teammates
    await new Promise(r => setTimeout(r, 2000))
  }
}

async addTeammate(leadName: string): Promise<string | null> {
  const leadEntry = this.managed.get(leadName)
  if (!leadEntry) return null

  // Find next available index
  let index = 2
  while (this.managed.has(`${leadName}-${index}`)) index++

  const tmName = `${leadName}-${index}`
  const tmSession = `operant-${tmName}`
  try { await $`tmux kill-session -t ${tmSession}`.quiet() } catch {}
  await $`tmux new-session -d -s ${tmSession} -c ${leadEntry.projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
  this.managed.set(tmName, { sessionName: tmSession, projectPath: leadEntry.projectPath, respawnEnabled: true })
  this.autoConfirm(tmSession)
  return tmName
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/screen-manager.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/screen-manager.ts tests/screen-manager.test.ts && git commit -m "feat: spawnTeam and addTeammate with AGENT_TEAMS env"
```

---

## Task 5: Task Monitor Module

**Files:**
- Create: `src/task-monitor.ts`
- Create: `tests/task-monitor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/task-monitor.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TaskMonitor, parseTaskFile } from '../src/task-monitor'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const TEST_DIR = join(import.meta.dir, '.test-tasks')

describe('TaskMonitor', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('parseTaskFile parses task JSON', () => {
    const task = parseTaskFile(JSON.stringify({
      id: '1',
      subject: 'Fix auth',
      description: 'Fix the login bug',
      status: 'in_progress',
      owner: 'teammate-2',
      blockedBy: [],
    }))
    expect(task.id).toBe('1')
    expect(task.subject).toBe('Fix auth')
    expect(task.status).toBe('in_progress')
    expect(task.owner).toBe('teammate-2')
  })

  test('readTasks returns empty array for missing directory', () => {
    const monitor = new TaskMonitor(TEST_DIR)
    const tasks = monitor.readTasks()
    expect(tasks).toEqual([])
  })

  test('readTasks finds task files', () => {
    const taskDir = join(TEST_DIR, 'my-team')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'task-1.json'), JSON.stringify({
      id: '1', subject: 'Test', status: 'pending', owner: '', blockedBy: [],
    }))
    const monitor = new TaskMonitor(TEST_DIR)
    const tasks = monitor.readTasks('my-team')
    expect(tasks.length).toBe(1)
    expect(tasks[0].subject).toBe('Test')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/task-monitor.test.ts
```

- [ ] **Step 3: Implement task monitor**

```typescript
// src/task-monitor.ts
import { readdirSync, readFileSync, existsSync, watch } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'

export type AgentTask = {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: string[]
}

export function parseTaskFile(content: string): AgentTask {
  const raw = JSON.parse(content)
  return {
    id: String(raw.id ?? ''),
    subject: String(raw.subject ?? ''),
    description: raw.description ? String(raw.description) : undefined,
    status: raw.status ?? 'pending',
    owner: raw.owner ? String(raw.owner) : undefined,
    blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [],
  }
}

export class TaskMonitor extends EventEmitter {
  private basePath: string
  private pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(basePath?: string) {
    super()
    this.basePath = basePath ?? join(homedir(), '.claude', 'tasks')
  }

  readTasks(teamName?: string): AgentTask[] {
    const tasks: AgentTask[] = []
    try {
      if (teamName) {
        return this.readTeamTasks(join(this.basePath, teamName))
      }
      // Read all team directories
      const dirs = readdirSync(this.basePath, { withFileTypes: true })
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          tasks.push(...this.readTeamTasks(join(this.basePath, dir.name)))
        }
      }
    } catch {}
    return tasks
  }

  private readTeamTasks(dir: string): AgentTask[] {
    const tasks: AgentTask[] = []
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf8')
          tasks.push(parseTaskFile(content))
        } catch {}
      }
    } catch {}
    return tasks
  }

  startPolling(intervalMs: number = 2000): void {
    this.stopPolling()
    let lastSnapshot = ''
    this.pollInterval = setInterval(() => {
      const tasks = this.readTasks()
      const snapshot = JSON.stringify(tasks)
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot
        this.emit('tasks:updated', tasks)
      }
    }, intervalMs)
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/task-monitor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/task-monitor.ts tests/task-monitor.test.ts && git commit -m "feat: task monitor watches Claude agent team task files"
```

---

## Task 6: Update Web UI — Grouped Sidebar and Team Spawn

**Files:**
- Modify: `src/frontends/web-client.html`

- [ ] **Step 1: Update sidebar rendering to group teams**

Replace `renderSidebar()` function:

```javascript
function renderSidebar() {
  const list = document.getElementById('session-list')
  list.innerHTML = ''

  // Group sessions by folder path (strip :index)
  const groups = new Map()
  for (const s of sessions) {
    const folder = s.path.replace(/:\d+$/, '')
    if (!groups.has(folder)) groups.set(folder, [])
    groups.get(folder).push(s)
  }

  for (const [folder, members] of groups) {
    // Sort: lead (index 0) first
    members.sort((a, b) => (a.teamIndex ?? 0) - (b.teamIndex ?? 0))
    const lead = members[0]
    const isTeam = members.length > 1 || (lead.teamSize ?? 0) > 1

    // Lead item
    const item = document.createElement('div')
    item.className = 'session-item' + (lead.name === activeSession ? ' active' : '')
    item.onclick = () => selectSession(lead.name)

    const dot = document.createElement('div')
    dot.className = `status-dot ${lead.status}`

    const name = document.createElement('div')
    name.className = 'session-name'
    name.textContent = lead.name + (isTeam ? ' (lead)' : '')

    item.appendChild(dot)
    item.appendChild(name)

    // [+] button for teams
    if (isTeam || lead.teamSize > 0) {
      const addBtn = document.createElement('button')
      addBtn.textContent = '+'
      addBtn.title = 'Add teammate'
      addBtn.style.cssText = 'background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:0 5px;cursor:pointer;font-size:12px;margin-left:auto;line-height:18px;'
      addBtn.onclick = (e) => { e.stopPropagation(); addTeammate(lead.name) }
      item.appendChild(addBtn)
    }

    // Restart button for disconnected
    if (lead.status === 'disconnected') {
      const restartBtn = document.createElement('button')
      restartBtn.textContent = '↻'
      restartBtn.title = 'Restart session'
      restartBtn.style.cssText = 'background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px;margin-left:4px;'
      restartBtn.onclick = (e) => { e.stopPropagation(); restartSession(lead.name, lead.path) }
      item.appendChild(restartBtn)
    }

    const unread = unreadBySession[lead.name]
    if (unread && lead.name !== activeSession) {
      const badge = document.createElement('div')
      badge.className = 'badge'
      badge.textContent = unread > 99 ? '99+' : String(unread)
      item.appendChild(badge)
    }

    list.appendChild(item)

    // Teammate items (indented)
    for (let i = 1; i < members.length; i++) {
      const tm = members[i]
      const tmItem = document.createElement('div')
      tmItem.className = 'session-item' + (tm.name === activeSession ? ' active' : '')
      tmItem.style.paddingLeft = '32px'
      tmItem.onclick = () => selectSession(tm.name)

      const tmDot = document.createElement('div')
      tmDot.className = `status-dot ${tm.status}`

      const tmName = document.createElement('div')
      tmName.className = 'session-name'
      tmName.textContent = tm.name

      tmItem.appendChild(tmDot)
      tmItem.appendChild(tmName)

      if (tm.status === 'disconnected') {
        const restartBtn = document.createElement('button')
        restartBtn.textContent = '↻'
        restartBtn.title = 'Restart'
        restartBtn.style.cssText = 'background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px;margin-left:auto;'
        restartBtn.onclick = (e) => { e.stopPropagation(); restartSession(tm.name, tm.path) }
        tmItem.appendChild(restartBtn)
      }

      list.appendChild(tmItem)
    }

    // Task summary for teams
    if (isTeam && currentTasks[folder]) {
      const tasks = currentTasks[folder]
      const done = tasks.filter(t => t.status === 'completed').length
      const summary = document.createElement('div')
      summary.style.cssText = 'padding:4px 16px 8px 32px;font-size:11px;color:var(--text-muted);'
      summary.textContent = `Tasks: ${done}/${tasks.length} done`
      list.appendChild(summary)
    }
  }
}
```

- [ ] **Step 2: Add team checkbox to spawn dialog**

In `promptSpawn()`, add after the path input:

```javascript
// Inside the modal.innerHTML template, after the path input and suggestions div:
<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);margin-bottom:12px;cursor:pointer;">
  <input type="checkbox" id="spawn-team" />
  Run as team
  <input type="number" id="spawn-team-size" value="3" min="2" max="10" style="width:50px;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;padding:4px;color:var(--text);font-size:12px;display:none;" />
</label>
```

Add JS to show/hide team size:
```javascript
const teamCheck = document.getElementById('spawn-team')
const teamSize = document.getElementById('spawn-team-size')
teamCheck.addEventListener('change', () => {
  teamSize.style.display = teamCheck.checked ? '' : 'none'
})
```

Update submit to include team info:
```javascript
document.getElementById('spawn-submit').onclick = () => {
  const name = nameInput.value.trim()
  const path = pathInput.value.trim()
  if (!name || !path) return
  const isTeam = document.getElementById('spawn-team').checked
  const size = isTeam ? parseInt(document.getElementById('spawn-team-size').value) || 3 : 1
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'spawn', name, path, teamSize: size }))
  }
  overlay.remove()
}
```

- [ ] **Step 3: Add addTeammate function and task state**

```javascript
// At top of script, add:
let currentTasks = {} // folder path → AgentTask[]

// Add function:
async function addTeammate(leadName) {
  try {
    const res = await fetch('/api/team/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadName })
    })
    if (!res.ok) throw new Error(await res.text())
  } catch (err) {
    alert('Failed to add teammate: ' + err)
  }
}
```

Update `handleWsMessage` to handle task updates:
```javascript
} else if (msg.type === 'tasks') {
  currentTasks = msg.data  // { folderPath: AgentTask[] }
  renderSidebar()
}
```

- [ ] **Step 4: Commit**

```bash
git add src/frontends/web-client.html && git commit -m "feat: web UI grouped team sidebar, spawn checkbox, task summary"
```

---

## Task 7: Update Web Server — Team API Endpoints

**Files:**
- Modify: `src/frontends/web.ts`

- [ ] **Step 1: Add /api/team/add endpoint**

In the fetch handler, add:

```typescript
if (url.pathname === '/api/team/add' && req.method === 'POST') {
  const body = await req.json() as { leadName: string }
  const newName = await self.deps.screenManager?.addTeammate(body.leadName)
  if (newName) {
    return Response.json({ ok: true, name: newName })
  }
  return new Response('Lead not found', { status: 404 })
}

if (url.pathname === '/api/team-tasks' && req.method === 'GET') {
  const tasks = self.deps.taskMonitor?.readAllGrouped() ?? {}
  return Response.json(tasks)
}
```

- [ ] **Step 2: Update spawn handler for team size**

In the WebSocket `spawn` message handler, update:

```typescript
case 'spawn': {
  const size = msg.teamSize ?? 1
  if (size > 1) {
    self.deps.screenManager?.spawnTeam(msg.name, msg.path, size)
  } else {
    self.deps.screenManager?.spawn(msg.name, msg.path)
  }
  break
}
```

- [ ] **Step 3: Add taskMonitor to deps type**

```typescript
type WebFrontendDeps = {
  // ... existing fields ...
  taskMonitor: TaskMonitor | null
}
```

- [ ] **Step 4: Broadcast task updates to clients**

Add method:
```typescript
deliverTaskUpdate(tasks: Record<string, AgentTask[]>): void {
  this.broadcastToClients({ type: 'tasks', data: tasks })
}
```

- [ ] **Step 5: Commit**

```bash
git add src/frontends/web.ts && git commit -m "feat: web server team API endpoints and task broadcasting"
```

---

## Task 8: Update Telegram — /team Command

**Files:**
- Modify: `src/frontends/telegram.ts`

- [ ] **Step 1: Add /team command handler**

In `registerHandlers()`, add:

```typescript
bot.command('team', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  const args = ctx.match?.trim().split(/\s+/) ?? []
  if (args.length === 0 || !args[0]) {
    await ctx.reply('Usage: /team <name> [add]')
    return
  }
  const teamName = args[0]
  const action = args[1]

  if (action === 'add') {
    const newName = await this.screenManager.addTeammate(teamName)
    if (newName) {
      await ctx.reply(`Added teammate: ${newName}`)
    } else {
      await ctx.reply(`Team lead "${teamName}" not found`)
    }
    return
  }

  // Show team status
  const path = this.registry.findByName(teamName)
  if (!path) {
    await ctx.reply(`Session "${teamName}" not found`)
    return
  }
  const folder = path.replace(/:\d+$/, '')
  const team = this.registry.getTeam(folder)
  if (team.length <= 1) {
    await ctx.reply(`${teamName} is a solo session, not a team`)
    return
  }

  const lines = team.map((s, i) => {
    const icon = s.status === 'active' ? '🟢' : '🔴'
    const role = i === 0 ? '👑 ' : '  ├ '
    return `${role}${s.name} ${icon}`
  })

  // Read tasks if available
  const taskMonitor = this.deps.taskMonitor
  if (taskMonitor) {
    const tasks = taskMonitor.readTasks()
    if (tasks.length > 0) {
      const done = tasks.filter(t => t.status === 'completed').length
      lines.push('')
      lines.push(`Tasks: ${done}/${tasks.length} done`)
      for (const t of tasks.slice(0, 10)) {
        const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳'
        const owner = t.owner ? ` (${t.owner})` : ''
        lines.push(`  ${icon} ${t.subject}${owner}`)
      }
    }
  }

  await ctx.reply(lines.join('\n'))
})
```

- [ ] **Step 2: Update /spawn to support team size**

Update the existing spawn handler:

```typescript
bot.command('spawn', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  const args = ctx.match?.trim().split(/\s+/) ?? []
  if (args.length < 2 || !args[0] || !args[1]) {
    await ctx.reply('Usage: /spawn <name> <path> [team-size]')
    return
  }
  const [name, projectPath, sizeStr] = args
  const teamSize = sizeStr ? parseInt(sizeStr) : 1
  try {
    if (teamSize > 1) {
      await this.screenManager.spawnTeam(name, projectPath, teamSize)
      await ctx.reply(`Spawned team ${name} (${teamSize} agents) at ${projectPath}`)
    } else {
      await this.screenManager.spawn(name, projectPath)
      await ctx.reply(`Spawned session ${name} at ${projectPath}`)
    }
  } catch (err) {
    await ctx.reply(`Failed to spawn: ${err}`)
  }
})
```

- [ ] **Step 3: Update /list to show team summaries**

Replace the list command's session formatting:

```typescript
// In the /list handler, replace session text formatting:
const folder = s.path.replace(/:\d+$/, '')
const team = this.registry.getTeam(folder)
const teamInfo = team.length > 1 ? ` (team: ${team.length} agents)` : ''
// Use: `${icon} ${s.name}${trustLabel}${teamInfo}${active}`
```

- [ ] **Step 4: Add taskMonitor to TelegramFrontendDeps**

```typescript
type TelegramFrontendDeps = {
  // ... existing fields ...
  taskMonitor: TaskMonitor | null
}
```

Store in constructor:
```typescript
this.deps = { ...deps, taskMonitor: deps.taskMonitor }
// or store as this.taskMonitor = deps.taskMonitor
```

- [ ] **Step 5: Commit**

```bash
git add src/frontends/telegram.ts && git commit -m "feat: telegram /team command, team spawn, task display"
```

---

## Task 9: Wire Everything in Daemon

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Import and create TaskMonitor**

```typescript
import { TaskMonitor } from './task-monitor'

// After screenManager creation:
const taskMonitor = new TaskMonitor()
taskMonitor.startPolling(2000)

taskMonitor.on('tasks:updated', (tasks) => {
  // Group tasks by team name and broadcast to frontends
  webFrontend?.deliverTaskUpdate(tasks)
})
```

- [ ] **Step 2: Pass taskMonitor to frontends**

Add `taskMonitor` to WebFrontend and TelegramFrontend constructor calls:

```typescript
// In WebFrontend creation:
taskMonitor,

// In TelegramFrontend creation:
taskMonitor,
```

- [ ] **Step 3: Update shutdown to stop polling**

```typescript
async function shutdown(): Promise<void> {
  process.stderr.write('operant: shutting down...\n')
  taskMonitor.stopPolling()
  saveSessions(registry.toSaveFormat())
  // ... rest unchanged
}
```

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts && git commit -m "feat: wire task monitor to daemon and frontends"
```

---

## Task 10: Register Telegram /team Command

**Files:** None (API call only)

- [ ] **Step 1: Update bot commands**

```bash
curl -s "https://api.telegram.org/bot8385195319:AAGYHary3uJBoBQzG2Vohm4FgZ7kJ2gYgbA/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "list", "description": "Show all sessions, pick active"},
      {"command": "status", "description": "Dashboard: all sessions and details"},
      {"command": "spawn", "description": "Launch Claude: /spawn name /path [team-size]"},
      {"command": "kill", "description": "Stop a session: /kill name"},
      {"command": "team", "description": "Team info: /team name [add]"},
      {"command": "trust", "description": "Toggle auto-approve: /trust name [auto|ask]"},
      {"command": "prefix", "description": "Set command prefix: /prefix name text"},
      {"command": "rename", "description": "Rename session: /rename old new"},
      {"command": "all", "description": "Broadcast to all: /all message"}
    ]
  }'
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: register /team command with Telegram BotFather"
```
