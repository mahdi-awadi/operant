# Restart-with-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the web dashboard restart button (`↻` on disconnected sessions) to open a popover offering **Resume** (pick from prior conversations for this project's cwd) or **New** (fresh session), wired to `claude --continue` / `claude --resume <id>` / plain `claude`.

**Architecture:** A pure backend module (`src/claude-sessions.ts`) handles path encoding, safety, and JSONL metadata reads so logic is easy to unit-test without the web layer. `ScreenManager.spawn()` gains an optional `resume` param that toggles between three command templates. A new `GET /api/sessions/:name/prior` endpoint surfaces the list, and `POST /api/spawn` passes `resume` through. The frontend replaces the bare `restartSession()` with a popover widget whose pure helper (`formatRelativeTime`) is unit-tested; popover DOM behavior is verified by manual smoke test (no DOM harness in the repo).

**Tech Stack:** Bun, TypeScript, Bun HTTP/WebSocket, tmux, Claude CLI.

**Spec:** `docs/superpowers/specs/2026-04-22-restart-resume-design.md`

---

## File Map

**Create:**
- `src/claude-sessions.ts` — pure module: encode project path, validate, list prior sessions
- `tests/claude-sessions.test.ts`
- `tests/frontends/web-client-helpers.test.ts`

**Modify:**
- `src/screen-manager.ts` — resume param, session ID validator
- `src/frontends/web.ts` — `GET /api/sessions/:name/prior`, `POST /api/spawn` resume passthrough
- `src/frontends/web-client.html` — replace `restartSession()` with popover
- `tests/screen-manager.test.ts` — resume param coverage
- `tests/frontends/web-auth.test.ts` — endpoint + spawn resume param coverage
- `CHANGELOG.md`

---

## Task 1: Path encoding + safety in `claude-sessions.ts`

**Files:**
- Create: `src/claude-sessions.ts`
- Create: `tests/claude-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/claude-sessions.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { encodeProjectPath, isInsideProjectsRoot } from '../src/claude-sessions'
import { homedir } from 'os'
import { join } from 'path'

describe('encodeProjectPath', () => {
  test('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/home/user/proj')).toBe('-home-user-proj')
  })

  test('handles trailing slash', () => {
    expect(encodeProjectPath('/home/user/proj/')).toBe('-home-user-proj-')
  })

  test('handles root', () => {
    expect(encodeProjectPath('/')).toBe('-')
  })
})

describe('isInsideProjectsRoot', () => {
  const ROOT = join(homedir(), '.claude', 'projects')

  test('accepts a direct child directory', () => {
    expect(isInsideProjectsRoot(join(ROOT, '-home-user-proj'))).toBe(true)
  })

  test('rejects a path that escapes via ..', () => {
    expect(isInsideProjectsRoot(join(ROOT, '..', 'other'))).toBe(false)
  })

  test('rejects an unrelated absolute path', () => {
    expect(isInsideProjectsRoot('/etc/passwd')).toBe(false)
  })

  test('rejects the root itself (must be a child)', () => {
    expect(isInsideProjectsRoot(ROOT)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/claude-sessions.test.ts
```
Expected: module not found / function not defined.

- [ ] **Step 3: Implement the module**

Create `src/claude-sessions.ts`:

```ts
// src/claude-sessions.ts — pure helpers over ~/.claude/projects/
import { homedir } from 'os'
import { join, resolve } from 'path'

export const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/**
 * Encode a project cwd to Claude's storage directory name.
 * Claude stores conversations at ~/.claude/projects/<encoded>/<session-id>.jsonl,
 * where <encoded> is the absolute cwd with every '/' replaced by '-'.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/**
 * True iff `candidate` resolves to a path strictly inside PROJECTS_ROOT.
 * Rejects the root itself (must be a child).
 */
export function isInsideProjectsRoot(candidate: string): boolean {
  const resolved = resolve(candidate)
  const root = resolve(PROJECTS_ROOT) + '/'
  return resolved !== resolve(PROJECTS_ROOT) && resolved.startsWith(root)
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/claude-sessions.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude-sessions.ts tests/claude-sessions.test.ts
git commit -m "feat(claude-sessions): path encoding + projects-root safety"
```

---

## Task 2: `listPriorSessions()` reads JSONL metadata

**Files:**
- Modify: `src/claude-sessions.ts`
- Modify: `tests/claude-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/claude-sessions.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'

describe('listPriorSessions', () => {
  let tmpProjectsRoot: string
  let projectDir: string

  beforeEach(() => {
    tmpProjectsRoot = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
    projectDir = join(tmpProjectsRoot, '-home-user-proj')
    mkdirSync(projectDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpProjectsRoot, { recursive: true, force: true })
  })

  function writeJsonl(id: string, lines: unknown[], mtimeSec: number) {
    const file = join(projectDir, `${id}.jsonl`)
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    utimesSync(file, mtimeSec, mtimeSec)
  }

  test('returns sessions newest-first with first user message', async () => {
    writeJsonl('aaaa1111-2222-3333-4444-555555555555', [
      { type: 'summary', text: 'meta' },
      { type: 'user', message: { role: 'user', content: 'fix the bug' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ], 1_700_000_100)

    writeJsonl('bbbb1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: 'add multi theme dark light' } },
    ], 1_700_000_200)

    const list = await listPriorSessions(projectDir, { rootOverride: tmpProjectsRoot })
    expect(list.length).toBe(2)
    expect(list[0].id).toBe('bbbb1111-2222-3333-4444-555555555555')
    expect(list[0].firstUserMessage).toBe('add multi theme dark light')
    expect(list[1].id).toBe('aaaa1111-2222-3333-4444-555555555555')
    expect(list[1].firstUserMessage).toBe('fix the bug')
    expect(list[0].mtime).toBeGreaterThan(list[1].mtime)
  })

  test('truncates long first user messages to 120 chars', async () => {
    const long = 'x'.repeat(500)
    writeJsonl('cccc1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: long } },
    ], 1_700_000_300)
    const list = await listPriorSessions(projectDir, { rootOverride: tmpProjectsRoot })
    expect(list[0].firstUserMessage.length).toBeLessThanOrEqual(120)
  })

  test('returns empty array when directory does not exist', async () => {
    const list = await listPriorSessions('/tmp/does-not-exist-zzz', { rootOverride: tmpProjectsRoot })
    expect(list).toEqual([])
  })

  test('caps results at 10 entries', async () => {
    for (let i = 0; i < 15; i++) {
      writeJsonl(`cap0${i.toString().padStart(3, '0')}-2222-3333-4444-555555555555`, [
        { type: 'user', message: { role: 'user', content: `msg ${i}` } },
      ], 1_700_000_400 + i)
    }
    const list = await listPriorSessions(projectDir, { rootOverride: tmpProjectsRoot })
    expect(list.length).toBe(10)
  })

  test('skips files that cannot be parsed', async () => {
    writeJsonl('good1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: 'good' } },
    ], 1_700_000_500)
    writeFileSync(join(projectDir, 'bad1111-2222-3333-4444-555555555555.jsonl'), '\x00not-json\x00')
    const list = await listPriorSessions(projectDir, { rootOverride: tmpProjectsRoot })
    // bad file has no parseable user message → firstUserMessage falls back to '(no messages)'
    // but should still be listed so the user can attempt to resume
    expect(list.some(s => s.id.startsWith('good1111'))).toBe(true)
  })

  test('falls back to "(no messages)" when no user line is present', async () => {
    writeJsonl('meta1111-2222-3333-4444-555555555555', [
      { type: 'summary', text: 'only meta' },
    ], 1_700_000_600)
    const list = await listPriorSessions(projectDir, { rootOverride: tmpProjectsRoot })
    expect(list[0].firstUserMessage).toBe('(no messages)')
  })

  test('rejects a project path that escapes the projects root', async () => {
    await expect(
      listPriorSessions('/etc/passwd', { rootOverride: tmpProjectsRoot })
    ).resolves.toEqual([])
  })
})
```

Also update the import line at the top of the test file to add:

```ts
import { encodeProjectPath, isInsideProjectsRoot, listPriorSessions } from '../src/claude-sessions'
import { beforeEach, afterEach } from 'bun:test'
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/claude-sessions.test.ts
```
Expected: `listPriorSessions is not a function`.

- [ ] **Step 3: Implement `listPriorSessions`**

Append to `src/claude-sessions.ts`:

```ts
import { readdir, stat, open } from 'fs/promises'

const MAX_RESULTS = 10
const HEAD_BYTES = 4096
const PREVIEW_CHARS = 120

export type PriorSession = {
  id: string
  firstUserMessage: string
  mtime: number  // unix seconds
}

export type ListOptions = {
  rootOverride?: string  // for tests; defaults to PROJECTS_ROOT
}

export async function listPriorSessions(
  projectPath: string,
  opts: ListOptions = {}
): Promise<PriorSession[]> {
  const root = opts.rootOverride ?? PROJECTS_ROOT
  const storageDir = `${root}/${encodeProjectPath(projectPath)}`

  // Path-safety gate — only allow paths inside the configured root
  if (!opts.rootOverride && !isInsideProjectsRoot(storageDir)) return []

  let entries: string[]
  try {
    entries = await readdir(storageDir)
  } catch {
    return []
  }

  const jsonl = entries.filter(e => e.endsWith('.jsonl'))
  const metadata: Array<PriorSession & { _file: string }> = []

  for (const file of jsonl) {
    const full = `${storageDir}/${file}`
    try {
      const s = await stat(full)
      const firstUserMessage = await readFirstUserMessage(full)
      metadata.push({
        id: file.slice(0, -'.jsonl'.length),
        firstUserMessage,
        mtime: Math.floor(s.mtimeMs / 1000),
        _file: full,
      })
    } catch {
      // Skip files we cannot stat or read
      continue
    }
  }

  metadata.sort((a, b) => b.mtime - a.mtime)
  return metadata.slice(0, MAX_RESULTS).map(({ _file, ...rest }) => rest)
}

async function readFirstUserMessage(file: string): Promise<string> {
  let handle
  try {
    handle = await open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    const text = buf.slice(0, bytesRead).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        const content = extractUserContent(obj)
        if (content != null) return content.slice(0, PREVIEW_CHARS)
      } catch { continue }
    }
    return '(no messages)'
  } finally {
    await handle?.close()
  }
}

function extractUserContent(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const msg = o.message as Record<string, unknown> | undefined
  const isUser = o.type === 'user' || o.role === 'user' || msg?.role === 'user'
  if (!isUser) return null
  const content = (msg?.content ?? o.content) as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
    }
  }
  return null
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/claude-sessions.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude-sessions.ts tests/claude-sessions.test.ts
git commit -m "feat(claude-sessions): listPriorSessions reads JSONL metadata"
```

---

## Task 3: `ScreenManager` resume param + session ID validator

**Files:**
- Modify: `src/screen-manager.ts`
- Modify: `tests/screen-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/screen-manager.test.ts`:

```ts
import { buildClaudeCmd, isValidSessionId } from '../src/screen-manager'

describe('isValidSessionId', () => {
  test('accepts a UUID', () => {
    expect(isValidSessionId('aaaa1111-2222-3333-4444-555555555555')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  test('rejects path traversal', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false)
  })

  test('rejects shell metacharacters', () => {
    expect(isValidSessionId('abc; rm -rf /')).toBe(false)
    expect(isValidSessionId('abc$(whoami)')).toBe(false)
  })

  test('rejects spaces', () => {
    expect(isValidSessionId('a b c')).toBe(false)
  })
})

describe('buildClaudeCmd', () => {
  test('no resume → bare claude', () => {
    const cmd = buildClaudeCmd({ team: false })
    expect(cmd).toBe('claude --dangerously-load-development-channels server:operant')
  })

  test('resume=continue → claude --continue', () => {
    const cmd = buildClaudeCmd({ team: false, resume: { mode: 'continue' } })
    expect(cmd).toBe('claude --continue --dangerously-load-development-channels server:operant')
  })

  test('resume=session → claude --resume <id>', () => {
    const cmd = buildClaudeCmd({ team: false, resume: { mode: 'session', id: 'aaaa1111-2222-3333-4444-555555555555' } })
    expect(cmd).toBe('claude --resume aaaa1111-2222-3333-4444-555555555555 --dangerously-load-development-channels server:operant')
  })

  test('team mode preserves CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS prefix', () => {
    const cmd = buildClaudeCmd({ team: true })
    expect(cmd).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1')
    expect(cmd).toContain('claude --dangerously-load-development-channels server:operant')
  })

  test('rejects a resume session with an invalid id', () => {
    expect(() =>
      buildClaudeCmd({ team: false, resume: { mode: 'session', id: '; rm -rf /' } })
    ).toThrow(/invalid session id/i)
  })
})
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/screen-manager.test.ts
```
Expected: `buildClaudeCmd is not a function` / `isValidSessionId is not a function`.

- [ ] **Step 3: Edit `src/screen-manager.ts` to add exports**

Near the top, after the existing `CLAUDE_CMD` / `CLAUDE_TEAM_CMD` constants, replace them with a builder:

```ts
// Replace the two const CLAUDE_CMD / CLAUDE_TEAM_CMD lines with:

const CHANNELS_FLAG = '--dangerously-load-development-channels server:operant'
const TEAM_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'

export type ResumeSpec =
  | { mode: 'continue' }
  | { mode: 'session', id: string }

export function isValidSessionId(id: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(id)
}

export function buildClaudeCmd(opts: { team: boolean; resume?: ResumeSpec }): string {
  let flag = ''
  if (opts.resume?.mode === 'continue') {
    flag = '--continue '
  } else if (opts.resume?.mode === 'session') {
    if (!isValidSessionId(opts.resume.id)) {
      throw new Error(`invalid session id: ${opts.resume.id}`)
    }
    flag = `--resume ${opts.resume.id} `
  }
  const base = `claude ${flag}${CHANNELS_FLAG}`
  return opts.team ? `${TEAM_ENV} ${base}` : base
}

// Keep CLAUDE_CMD / CLAUDE_TEAM_CMD as lazy getters for callers that still reference them:
const CLAUDE_CMD = buildClaudeCmd({ team: false })
const CLAUDE_TEAM_CMD = buildClaudeCmd({ team: true })
```

Then update `spawn()` to accept a `resume` parameter (still the 5th positional, keeping `profileName` as the 4th for compatibility):

```ts
async spawn(
  name: string,
  projectPath: string,
  instructions?: string,
  profileName?: string,
  resume?: ResumeSpec,
): Promise<void> {
  const sessionName = `operant-${name}`
  ensureProjectDir(projectPath)

  try { await $`tmux kill-session -t ${sessionName}`.quiet() } catch {}

  const cmd = buildClaudeCmd({ team: false, resume })
  await $`tmux new-session -d -s ${sessionName} -c ${projectPath} ${cmd}`.quiet()
  this.managed.set(name, { sessionName, projectPath, respawnEnabled: true, profileName })

  this.autoConfirm(sessionName, instructions)
}
```

Leave `scheduleRespawn` as-is (crash recovery stays resume-free).

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/screen-manager.test.ts
```
Expected: all new tests pass, all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/screen-manager.ts tests/screen-manager.test.ts
git commit -m "feat(screen-manager): resume param + session id validator"
```

---

## Task 4: `GET /api/sessions/:name/prior` endpoint

**Files:**
- Modify: `src/frontends/web.ts`
- Modify: `tests/frontends/web-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/frontends/web-auth.test.ts` inside the existing `describe('WebFrontend')` block (or a new block if none). Pattern the tests after the existing ones that use `authCookie()`:

```ts
describe('GET /api/sessions/:name/prior', () => {
  let tmpDir: string
  let registry: SessionRegistry
  let frontend: WebFrontend

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'web-prior-'))
    registry = new SessionRegistry()
    registry.register('alpha', join(tmpDir, 'project'), undefined)
    frontend = new WebFrontend({
      port: 0,
      registry,
      telegramToken: TOKEN,
      telegramAllowFrom: [ALLOWED],
      sessionTtlSec: 3600,
      projectsRootOverride: tmpDir,  // wire for tests
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('requires auth', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/sessions/alpha/prior'))
    expect(res.status).toBe(401)
  })

  test('returns 404 for unknown session', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/sessions/ghost/prior', {
      headers: { cookie: authCookie() },
    }))
    expect(res.status).toBe(404)
  })

  test('returns empty list when project has no prior sessions', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/sessions/alpha/prior', {
      headers: { cookie: authCookie() },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toEqual([])
  })

  test('returns sessions newest-first with first message preview', async () => {
    const storageDir = join(tmpDir, '-' + join(tmpDir, 'project').replace(/\//g, '-').replace(/^-/, ''))
    // simpler: write under the encoded project directory the module expects
    const encoded = join(tmpDir, 'project').replace(/\//g, '-')
    const dir = join(tmpDir, encoded)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'aaaa1111-2222-3333-4444-555555555555.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi claude' } }) + '\n')

    const res = await frontend.handleTest(new Request('http://x/api/sessions/alpha/prior', {
      headers: { cookie: authCookie() },
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions.length).toBe(1)
    expect(body.sessions[0].id).toBe('aaaa1111-2222-3333-4444-555555555555')
    expect(body.sessions[0].firstUserMessage).toBe('hi claude')
  })
})
```

Add at the top of `web-auth.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'fs'
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/frontends/web-auth.test.ts
```
Expected: 404 for all routes (endpoint doesn't exist), or `handleTest is not a function` / `projectsRootOverride` unknown.

- [ ] **Step 3: Add handler + test hook in `src/frontends/web.ts`**

At the top, add the import:

```ts
import { listPriorSessions } from '../claude-sessions'
```

Extend the `WebFrontend` deps type to accept `projectsRootOverride?: string` (test-only hook). Find the deps-type declaration near the top of the class and add it.

Inside the request router (around line 216 where other `/api/sessions` routes live), add:

```ts
// GET /api/sessions/:name/prior
{
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prior$/)
  if (m && req.method === 'GET') {
    const name = decodeURIComponent(m[1])
    const s = self.deps.registry.get(name)
    if (!s) return new Response('Session not found', { status: 404 })
    try {
      const sessions = await listPriorSessions(s.projectPath, {
        rootOverride: self.deps.projectsRootOverride,
      })
      return Response.json({ sessions })
    } catch (err) {
      process.stderr.write(`operant: /api/sessions/${name}/prior error: ${err}\n`)
      return Response.json({ sessions: [], error: 'read-failed' }, { status: 200 })
    }
  }
}
```

If `registry.get(name)` doesn't exist, grep for the equivalent lookup used elsewhere (e.g., `handleKill` uses `this.deps.registry.list().find(s => s.name === name)`). Match that pattern exactly — do not invent new registry methods.

Finally, expose a `handleTest()` helper so tests can exercise routes without binding a port. If it already exists, reuse it; otherwise add at the bottom of the class:

```ts
// Test-only: route a Request directly (bypasses server binding)
async handleTest(req: Request): Promise<Response> {
  return (this as unknown as { _dispatch: (r: Request) => Promise<Response> })._dispatch(req)
}
```

Wiring `_dispatch` requires factoring the existing `fetch(req, server)` body into a method. If that refactor is too invasive, alternative: start the server on port 0 in test setup and use real `fetch('http://localhost:<port>/...')`. Use whichever the existing tests already use — look at `web-auth.test.ts` for the pattern. Do not introduce both.

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/frontends/web-auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/frontends/web.ts tests/frontends/web-auth.test.ts
git commit -m "feat(web): GET /api/sessions/:name/prior for restart picker"
```

---

## Task 5: `POST /api/spawn` accepts `resume` param

**Files:**
- Modify: `src/frontends/web.ts`
- Modify: `tests/frontends/web-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `web-auth.test.ts`:

```ts
describe('POST /api/spawn with resume', () => {
  let registry: SessionRegistry
  let spawnCalls: Array<{ name: string; path: string; instr?: string; profile?: string; resume?: unknown }>
  let frontend: WebFrontend

  beforeEach(() => {
    spawnCalls = []
    registry = new SessionRegistry()
    const fakeScreen = {
      spawn: async (name: string, path: string, instr?: string, profile?: string, resume?: unknown) => {
        spawnCalls.push({ name, path, instr, profile, resume })
      },
      spawnTeam: async () => {},
    } as unknown
    frontend = new WebFrontend({
      port: 0,
      registry,
      telegramToken: TOKEN,
      telegramAllowFrom: [ALLOWED],
      sessionTtlSec: 3600,
      screenManager: fakeScreen as never,
    })
  })

  test('resume="continue" passes through to ScreenManager', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/spawn', {
      method: 'POST',
      headers: { cookie: authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj', resume: 'continue' }),
    }))
    expect(res.status).toBe(200)
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].resume).toEqual({ mode: 'continue' })
  })

  test('resume={sessionId} passes through as session mode', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/spawn', {
      method: 'POST',
      headers: { cookie: authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj', resume: { sessionId: 'aaaa1111-2222-3333-4444-555555555555' } }),
    }))
    expect(res.status).toBe(200)
    expect(spawnCalls[0].resume).toEqual({ mode: 'session', id: 'aaaa1111-2222-3333-4444-555555555555' })
  })

  test('rejects invalid session id with 400', async () => {
    const res = await frontend.handleTest(new Request('http://x/api/spawn', {
      method: 'POST',
      headers: { cookie: authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj', resume: { sessionId: '../../etc/passwd' } }),
    }))
    expect(res.status).toBe(400)
    expect(spawnCalls.length).toBe(0)
  })

  test('no resume field → spawn called without resume', async () => {
    await frontend.handleTest(new Request('http://x/api/spawn', {
      method: 'POST',
      headers: { cookie: authCookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alpha', path: '/tmp/proj' }),
    }))
    expect(spawnCalls[0].resume).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/frontends/web-auth.test.ts
```
Expected: resume is not passed through.

- [ ] **Step 3: Edit `handleSpawn()` in `src/frontends/web.ts`**

Add `isValidSessionId` to the screen-manager import:

```ts
import { ScreenManager, isValidSessionId, type ResumeSpec } from '../screen-manager'
```

Replace the body of `handleSpawn` with:

```ts
private async handleSpawn(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      name: string
      path: string
      teamSize?: number
      instructions?: string
      resume?: 'continue' | { sessionId: string }
    }
    const { name, path, teamSize, instructions, resume } = body
    if (!this.deps.screenManager) return new Response('No screen manager', { status: 503 })

    let resumeSpec: ResumeSpec | undefined
    if (resume === 'continue') {
      resumeSpec = { mode: 'continue' }
    } else if (resume && typeof resume === 'object' && typeof resume.sessionId === 'string') {
      if (!isValidSessionId(resume.sessionId)) {
        return new Response('Invalid session id', { status: 400 })
      }
      resumeSpec = { mode: 'session', id: resume.sessionId }
    }

    const size = teamSize ?? 1
    if (size > 1) {
      if (resumeSpec) return new Response('Resume not supported with teamSize > 1', { status: 400 })
      this.deps.screenManager.spawnTeam(name, path, size, instructions).catch(err => {
        process.stderr.write(`operant: spawnTeam error: ${err}\n`)
      })
    } else {
      await this.deps.screenManager.spawn(name, path, instructions, undefined, resumeSpec)
    }
    return Response.json({ ok: true })
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/frontends/web-auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/frontends/web.ts tests/frontends/web-auth.test.ts
git commit -m "feat(web): /api/spawn accepts resume=continue|{sessionId}"
```

---

## Task 6: Frontend — popover CSS + `formatRelativeTime` helper

**Files:**
- Modify: `src/frontends/web-client.html`
- Create: `tests/frontends/web-client-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/frontends/web-client-helpers.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Extract and eval the formatRelativeTime function from the client HTML
// so we can test it as a pure helper.
function loadHelper(name: string): Function {
  const html = readFileSync(join(__dirname, '../../src/frontends/web-client.html'), 'utf8')
  const m = html.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'm'))
  if (!m) throw new Error(`${name} not found in web-client.html`)
  return new Function(`${m[0]}\nreturn ${name};`)()
}

describe('formatRelativeTime', () => {
  const fn = loadHelper('formatRelativeTime') as (sec: number, nowSec?: number) => string
  const NOW = 1_700_100_000

  test('seconds ago → "just now"', () => {
    expect(fn(NOW - 20, NOW)).toBe('just now')
  })

  test('minutes ago', () => {
    expect(fn(NOW - 300, NOW)).toBe('5m ago')
  })

  test('hours ago', () => {
    expect(fn(NOW - 7200, NOW)).toBe('2h ago')
  })

  test('one day → "yesterday"', () => {
    expect(fn(NOW - 86400, NOW)).toBe('yesterday')
  })

  test('multiple days → "Nd ago" up to 7 days', () => {
    expect(fn(NOW - 3 * 86400, NOW)).toBe('3d ago')
  })

  test('older than 7 days → absolute date', () => {
    const sec = NOW - 30 * 86400
    const out = fn(sec, NOW)
    // Format like "Oct 17" — test shape, not exact locale
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })
})
```

- [ ] **Step 2: Run test — expect failure**

```bash
bun test tests/frontends/web-client-helpers.test.ts
```
Expected: `formatRelativeTime not found in web-client.html`.

- [ ] **Step 3: Add CSS + helper to `web-client.html`**

Add the popover CSS inside the existing `<style>` block, near the end before the `@media` query (around line 272):

```css
/* Restart popover */
.restart-popover {
  position: absolute;
  z-index: 150;
  background: var(--sidebar);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  min-width: 280px;
  max-width: 360px;
  padding: 6px 0;
  font-size: 12px;
}
.restart-popover .rp-section {
  padding: 6px 12px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.restart-popover .rp-item {
  padding: 8px 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
}
.restart-popover .rp-item:hover,
.restart-popover .rp-item.focused { background: rgba(255,255,255,0.06); }
.restart-popover .rp-item.disabled { opacity: 0.4; cursor: default; }
.restart-popover .rp-preview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.restart-popover .rp-time {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}
.restart-popover hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}
```

Add the helper inside the existing `<script>` block. A good place is alongside other small helpers; if you can't find a block, add it just before the existing `restartSession` definition (to be removed in Task 7):

```js
function formatRelativeTime(sec, nowSec) {
  const now = nowSec ?? Math.floor(Date.now() / 1000)
  const diff = now - sec
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  const days = Math.floor(diff / 86400)
  if (days === 1) return 'yesterday'
  if (days <= 7) return `${days}d ago`
  const d = new Date(sec * 1000)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' })
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
bun test tests/frontends/web-client-helpers.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/web-client.html tests/frontends/web-client-helpers.test.ts
git commit -m "feat(web-client): popover styles + formatRelativeTime helper"
```

---

## Task 7: Frontend — `openRestartPopover`: fetch, render, actions

**Files:**
- Modify: `src/frontends/web-client.html`

- [ ] **Step 1: Replace the existing `restartSession` function and update the click handler**

Find the existing `restartSession` function (~line 734). Replace it with `spawnResume`, `loadPriorSessions`, and `openRestartPopover`:

```js
async function loadPriorSessions(name) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/prior`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body.sessions) ? body.sessions : []
}

async function spawnResume(name, folderPath, resume) {
  const body = { name, path: folderPath }
  if (resume) body.resume = resume
  const res = await fetch('/api/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
}

function openRestartPopover(name, rawPath, anchorEl) {
  // Strip :N session-key suffix to get the real folder path.
  const folderPath = rawPath ? rawPath.replace(/:\d+$/, '') : ''

  // Close any existing popover
  document.querySelectorAll('.restart-popover').forEach(el => el.remove())

  const pop = document.createElement('div')
  pop.className = 'restart-popover'
  pop.tabIndex = -1

  // Position anchored to the button
  const rect = anchorEl.getBoundingClientRect()
  pop.style.top = `${rect.bottom + 4}px`
  pop.style.left = `${rect.left}px`
  document.body.appendChild(pop)
  // Flip if it overflows the viewport
  const pr = pop.getBoundingClientRect()
  if (pr.right > window.innerWidth - 8) {
    pop.style.left = `${Math.max(8, rect.right - pr.width)}px`
  }

  pop.innerHTML = '<div class="rp-section">Loading…</div>'

  const focusables = []
  let focusIdx = 0

  function setFocus(i) {
    focusIdx = Math.max(0, Math.min(focusables.length - 1, i))
    focusables.forEach((el, j) => el.classList.toggle('focused', j === focusIdx))
    focusables[focusIdx]?.scrollIntoView({ block: 'nearest' })
  }

  function close() {
    pop.remove()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onOutside)
  }

  async function doAction(resume) {
    close()
    try {
      await spawnResume(name, folderPath, resume)
    } catch (err) {
      alert('Restart failed: ' + err.message)
    }
  }

  function render(sessions) {
    pop.innerHTML = ''
    focusables.length = 0

    if (sessions.length > 0) {
      const header = document.createElement('div')
      header.className = 'rp-section'
      header.textContent = 'Resume'
      pop.appendChild(header)

      for (const s of sessions) {
        const item = document.createElement('div')
        item.className = 'rp-item'
        item.innerHTML = `
          <span class="rp-preview"></span>
          <span class="rp-time"></span>
        `
        item.querySelector('.rp-preview').textContent = s.firstUserMessage || '(no messages)'
        item.querySelector('.rp-time').textContent = formatRelativeTime(s.mtime)
        item.onclick = () => doAction({ sessionId: s.id })
        pop.appendChild(item)
        focusables.push(item)
      }

      const hr = document.createElement('hr')
      pop.appendChild(hr)
    }

    const newItem = document.createElement('div')
    newItem.className = 'rp-item'
    newItem.innerHTML = '<span class="rp-preview">✨ New session</span>'
    newItem.onclick = () => doAction(undefined)
    pop.appendChild(newItem)
    focusables.push(newItem)

    setFocus(0)
    pop.focus()
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(focusIdx + 1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(focusIdx - 1); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      focusables[focusIdx]?.click()
    }
  }

  function onOutside(e) {
    if (!pop.contains(e.target) && e.target !== anchorEl) close()
  }

  document.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onOutside)

  loadPriorSessions(name)
    .then(render)
    .catch(() => render([]))  // treat fetch errors as "no prior sessions" → only New shown
}
```

Find the click handler on the restart button (~line 512):

```js
restartBtn.onclick = (e) => { e.stopPropagation(); restartSession(s.name, s.path) }
```

Change it to:

```js
restartBtn.onclick = (e) => { e.stopPropagation(); openRestartPopover(s.name, s.path, restartBtn) }
```

Delete the old `restartSession` function body if still present (it's replaced by `spawnResume` + `openRestartPopover`).

- [ ] **Step 2: Run existing tests**

```bash
bun test
```
Expected: all 70+ tests pass (new endpoint + screen-manager + helpers + existing).

- [ ] **Step 3: Commit**

```bash
git add src/frontends/web-client.html
git commit -m "feat(web-client): restart popover with resume picker"
```

---

## Task 8: Manual verification

**Files:** none

- [ ] **Step 1: Start the daemon**

```bash
tmux kill-session -t operant-daemon 2>/dev/null
tmux new-session -d -s operant-daemon "bun run src/daemon.ts"
sleep 2
tmux capture-pane -t operant-daemon -p | tail -10
```
Expected: see `operant: listening on http://localhost:<port>` without errors.

- [ ] **Step 2: Spawn a test session, exchange messages, then kill it**

In a separate terminal:

```bash
mkdir -p /tmp/restart-test
cd /tmp/restart-test
claude --dangerously-load-development-channels server:operant
```

In the Claude TUI send: "hello, please respond with the word 'alpha'". Wait for reply. Exit with `/exit` or Ctrl+C twice so the session is disconnected in the operant.

- [ ] **Step 3: Open the web dashboard**

Navigate to `http://localhost:<webPort>` in a browser. Log in via Telegram if not already.

- [ ] **Step 4: Verify popover behaviour**

| Action | Expected |
|---|---|
| Click `↻` on the disconnected session | Popover opens next to the button, shows **Resume** with the session preview `"hello, please respond…"` + relative time, and **New session** below |
| Press **Enter** | Popover closes, tmux session relaunches, previous conversation visible |
| Click `↻` again, click a specific row | `ps aux \| grep claude` shows `--resume <that-id>` |
| Click `↻`, click **New session** | Fresh `claude` with no prior context |
| Click `↻` on a folder with no prior JSONL files | Popover shows only **New session** |
| Press **Escape** while popover is open | Popover closes |
| Click outside popover | Popover closes |

- [ ] **Step 5: Regression check**

| Action | Expected |
|---|---|
| `✕` button on disconnected session | Removes from list (unchanged) |
| `[+]` button on team lead | Adds teammate (unchanged) |
| Spawn via `/api/spawn` from CLI | Still works — no resume field required |

- [ ] **Step 6: Update CHANGELOG**

Append to `CHANGELOG.md` under the current unreleased / beta heading:

```markdown
### Added
- Web dashboard: clicking `↻` on a disconnected session now opens a popover to
  **resume** a prior conversation (picker over `~/.claude/projects/<cwd>/*.jsonl`)
  or start a **new** session. Uses `claude --continue` / `claude --resume <id>`.
```

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG for restart-with-resume"
```

---

## Self-Review Notes

Spec coverage verified:
- Popover with Resume + New → Tasks 6, 7
- List up to 10 prior sessions, newest-first, with first-user preview → Task 2, 4
- `--continue` / `--resume <id>` / plain claude → Task 3
- Empty state (no prior sessions) → Task 7 (render logic)
- Error state (API failure) → Task 7 (`.catch(() => render([]))`)
- Path safety (reject escapes) → Task 1, 4
- Session ID validation → Tasks 3, 5
- Auth on new endpoint → Task 4
- `scheduleRespawn` stays resume-free → Task 3 explicit note
- Disconnected-only scope → Task 7 (button still only rendered under `if (s.status === 'disconnected')`)
- Tests at every layer → Tasks 1, 2, 3, 4, 5, 6

Placeholder scan: no TBD/TODO; all code shown; all types/functions defined before use. `handleTest()` fallback explicitly notes to follow the existing test pattern.

Type consistency: `ResumeSpec` defined in Task 3 is used in Tasks 3, 4, 5. Frontend payload shape (`resume: 'continue' | { sessionId: string }`) matches across Tasks 5, 7.

Known fragile point: the `handleTest`/`_dispatch` harness in Task 4 depends on whether the existing `web-auth.test.ts` exercises routes through `handleTest` or through a real bound server. The task instructs the implementer to match whichever exists — no new harness.
