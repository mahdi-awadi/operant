# Headless Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daemon-managed headless Chrome that exposes its CDP endpoint on `127.0.0.1:9222` so `chrome-devtools-mcp` can attach to it from every Claude session.

**Architecture:** New `BrowserController` class spawns Playwright's bundled Chromium with a persistent profile, polls `/json/version` for readiness, restarts with exponential backoff on crashes, escalates after 5 failures, and is wired into the daemon start/stop sequence. No new code in the request path — `chrome-devtools-mcp` (registered by the user in `~/.claude.json`) talks to Chrome directly via CDP.

**Tech Stack:** Bun + TypeScript, `playwright` npm package (used solely for `chromium.executablePath()` and as the source of the bundled binary), `node:events` for the controller's event emitter, `node:fs/promises` for profile-dir hygiene, `node:net` to probe the readiness socket.

**Spec:** `docs/superpowers/specs/2026-05-03-headless-chrome-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/browser-controller.ts` | Create (~250 lines) | Owns Chrome lifecycle: spawn, readiness poll, crash backoff, escalation, clean shutdown |
| `src/types.ts` | Modify (+3 lines) | Add `chromeEnabled?: boolean`, `chromePort?: number`, `chromeExecutablePath?: string` to `OperantConfig` |
| `src/config.ts` | Modify (+5 lines) | Pass through the three new fields in `loadOperantConfig` |
| `src/daemon.ts` | Modify (~12 lines) | Construct `BrowserController`, start it post-config, await `stop()` in shutdown |
| `package.json` | Modify | Add `"playwright"` to `dependencies` |
| `tests/browser-controller.test.ts` | Create (~350 lines) | Unit tests with stubbed `Bun.spawn` + `fetch` |
| `tests/browser-integration.test.ts` | Create (~70 lines) | Opt-in integration test gated by `BROWSER_E2E=1` |
| `README.md` | Modify | Add a "Browser (headless Chrome)" section + sample `~/.claude.json` block |
| `.github/workflows/browser-e2e.yml` | Create | Opt-in CI job that installs chromium and runs the integration test |

---

## Test Fixtures Used Across Tasks

Tests stub `Bun.spawn` and `globalThis.fetch`. A small fixture helper centralizes the stubbing — added in Task 1 and reused throughout:

```ts
// tests/browser-controller.test.ts (top of file, added in Task 1)
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

class FakeProc {
  pid = 12345
  killed = false
  exitCode: number | null = null
  signal: string | null = null
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = []
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void) {
    if (event === 'exit') this.exitListeners.push(cb)
    return this
  }
  kill(sig?: string) {
    this.killed = true
    this.signal = sig ?? 'SIGTERM'
  }
  fireExit(code: number | null, signal: string | null) {
    this.exitCode = code
    this.signal = signal
    for (const cb of this.exitListeners) cb(code, signal)
  }
}

function makeFetchStub(responses: Map<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const handler = responses.get(url) ?? (() => new Response('not found', { status: 404 }))
    return await handler()
  }) as unknown as typeof fetch
}
```

---

## Phase 0 — Foundation

### Task 1: Skeleton class + spawn

**Files:**
- Create: `src/browser-controller.ts`
- Create: `tests/browser-controller.test.ts`

- [ ] **Step 1: Add `playwright` to dependencies**

Edit `/home/operant/package.json` — add `"playwright": "^1.48.0"` to `dependencies`. Then:

```bash
bun install
```

Expected: install succeeds. (We're not pulling Chromium yet — that's a separate `bunx playwright install chromium` the user runs once.)

- [ ] **Step 2: Write failing test for class shape**

Append to `tests/browser-controller.test.ts`:

```ts
import { BrowserController } from '../src/browser-controller'

describe('BrowserController', () => {
  test('exposes start, stop, restart, isUp, waitUntilUp methods', () => {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/x', executablePath: '/bin/true' })
    expect(typeof c.start).toBe('function')
    expect(typeof c.stop).toBe('function')
    expect(typeof c.restart).toBe('function')
    expect(typeof c.isUp).toBe('function')
    expect(typeof c.waitUntilUp).toBe('function')
    expect(c.isUp()).toBe(false)
  })
})
```

Run: `bun test tests/browser-controller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the skeleton class**

`/home/operant/src/browser-controller.ts`:

```ts
// src/browser-controller.ts
//
// Owns the lifecycle of a single headless Chromium subprocess that
// operant uses as the shared CDP target for chrome-devtools-mcp.
// Auto-starts at daemon boot, restarts on crash with exponential
// backoff, escalates after repeated failures.

import { EventEmitter } from 'node:events'
import type { Subprocess } from 'bun'

export type BrowserControllerDeps = {
  port: number
  profileDir: string
  executablePath: string
  args?: string[]
}

export class BrowserController extends EventEmitter {
  private deps: BrowserControllerDeps
  private proc: Subprocess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private shutdown = false
  private crashCount = 0
  private startedAt = 0

  constructor(deps: BrowserControllerDeps) {
    super()
    this.deps = deps
  }

  isUp(): boolean {
    return this.proc !== null && (this.proc as any).exitCode === null
  }

  async start(): Promise<void> {
    throw new Error('not implemented yet')
  }

  async stop(): Promise<void> {
    throw new Error('not implemented yet')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async waitUntilUp(_timeoutMs: number): Promise<void> {
    throw new Error('not implemented yet')
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun test tests/browser-controller.test.ts -t "exposes start"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/browser-controller.ts tests/browser-controller.test.ts
git commit -m "feat(chrome): BrowserController skeleton + playwright dep"
```

---

### Task 2: `start()` spawns chromium with the right args

**Files:**
- Modify: `src/browser-controller.ts`
- Modify: `tests/browser-controller.test.ts`

- [ ] **Step 1: Failing test**

Append to `tests/browser-controller.test.ts`:

```ts
test('start() spawns chromium with the expected args', async () => {
  const calls: { cmd: (string | URL)[]; opts: any }[] = []
  const fakeProc = new FakeProc()
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (cmd: any, opts: any) => {
    calls.push({ cmd, opts })
    return fakeProc as any
  }

  // /json/version becomes reachable immediately
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response(JSON.stringify({ Browser: 'HeadlessChrome/130' }), { status: 200 })],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/usr/bin/chromium' })
    await c.start()
    expect(calls.length).toBe(1)
    const argv = calls[0]!.cmd as string[]
    expect(argv[0]).toBe('/usr/bin/chromium')
    expect(argv).toContain('--headless=new')
    expect(argv).toContain('--remote-debugging-port=9999')
    expect(argv).toContain('--remote-debugging-address=127.0.0.1')
    expect(argv).toContain('--user-data-dir=/tmp/p')
    expect(argv).toContain('--no-first-run')
    expect(argv).toContain('--no-default-browser-check')
    expect(argv).toContain('--disable-gpu')
    expect(argv).toContain('--disable-dev-shm-usage')
    expect(c.isUp()).toBe(true)
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
})
```

Run: `bun test tests/browser-controller.test.ts -t "spawns chromium"`
Expected: FAIL — `start()` throws "not implemented yet".

- [ ] **Step 2: Implement `start()` and `waitUntilUp()`**

Replace the `start()` and `waitUntilUp()` stubs in `src/browser-controller.ts`:

```ts
async start(): Promise<void> {
  if (this.isUp()) return
  const args = [
    this.deps.executablePath,
    '--headless=new',
    `--remote-debugging-port=${this.deps.port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${this.deps.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    ...(this.deps.args ?? []),
  ]
  this.shutdown = false
  this.proc = Bun.spawn(args, {
    stdout: 'ignore',
    stderr: 'ignore',
    onExit: (_subprocess, exitCode, signalCode) => {
      this.handleExit(exitCode, signalCode)
    },
  })
  this.startedAt = Date.now()
  await this.waitUntilUp(10_000)
  this.emit('started')
  process.stderr.write(`operant: chrome started (pid=${this.proc.pid}, port=${this.deps.port})\n`)
}

async waitUntilUp(timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${this.deps.port}/json/version`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`chrome /json/version not reachable on port ${this.deps.port} within ${timeoutMs}ms`)
}

private handleExit(_code: number | null, _signal: string | null): void {
  // Implemented in Task 4 (crash backoff). For now we just clear proc.
  this.proc = null
}
```

Note: For the test to use `FakeProc`'s `.on('exit', ...)` model, we need to bridge the `onExit` callback on `Bun.spawn`. The `FakeProc` defined in the fixture supports `fireExit`. Update `FakeProc` to also accept `Bun.spawn`'s `onExit` option-style invocation. Add to the fixture file (replace the existing FakeProc class definition):

```ts
class FakeProc {
  pid = 12345
  killed = false
  exitCode: number | null = null
  signal: string | null = null
  onExit?: (subprocess: any, exitCode: number | null, signalCode: string | null) => void
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void) {
    if (event === 'exit') this.onExit = (_p, c, s) => cb(c, s)
    return this
  }
  kill(sig?: string) {
    this.killed = true
    this.signal = sig ?? 'SIGTERM'
  }
  fireExit(code: number | null, signal: string | null) {
    this.exitCode = code
    this.signal = signal
    if (this.onExit) this.onExit(this, code, signal)
  }
}
```

And update the spawn stub to read `opts.onExit`:

```ts
;(Bun as any).spawn = (cmd: any, opts: any) => {
  fakeProc.onExit = opts.onExit
  calls.push({ cmd, opts })
  return fakeProc as any
}
```

- [ ] **Step 3: Run test, expect PASS**

Run: `bun test tests/browser-controller.test.ts -t "spawns chromium"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/browser-controller.ts tests/browser-controller.test.ts
git commit -m "feat(chrome): start() spawns headless chromium with proper args"
```

---

### Task 3: `start()` rejects on readiness timeout, idempotent

**Files:**
- Modify: `tests/browser-controller.test.ts` (only — `start()` already has the right shape)

- [ ] **Step 1: Failing tests**

Append:

```ts
test('start() rejects when /json/version never returns 200', async () => {
  const fakeProc = new FakeProc()
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; return fakeProc as any }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => { throw new Error('connection refused') }],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
    await expect(c.start()).rejects.toThrow(/not reachable/)
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
}, 12_000)

test('start() is idempotent — second call while up is a no-op', async () => {
  let spawnCalls = 0
  const fakeProc = new FakeProc()
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; spawnCalls++; return fakeProc as any }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
    await c.start()
    await c.start()
    expect(spawnCalls).toBe(1)
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
})
```

Run: `bun test tests/browser-controller.test.ts -t "start"`
Expected: 2 new tests pass (idempotency works because `if (this.isUp()) return` is already there; rejection works because `waitUntilUp` throws).

- [ ] **Step 2: Commit**

```bash
git add tests/browser-controller.test.ts
git commit -m "test(chrome): readiness timeout + idempotent start"
```

---

## Phase 1 — Lifecycle

### Task 4: `stop()` SIGTERM → SIGKILL after 5s

**Files:**
- Modify: `src/browser-controller.ts`
- Modify: `tests/browser-controller.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('stop() sends SIGTERM, then SIGKILL after 5s if still alive', async () => {
  const fakeProc = new FakeProc()
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; return fakeProc as any }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
    await c.start()

    // Don't fire exit — simulate Chrome ignoring SIGTERM
    const stopPromise = c.stop()

    // Should have sent SIGTERM
    await new Promise(r => setTimeout(r, 50))
    expect(fakeProc.signal).toBe('SIGTERM')

    // After ~5s, expect SIGKILL
    await new Promise(r => setTimeout(r, 5_100))
    expect(fakeProc.signal).toBe('SIGKILL')

    // Resolve the stop by firing exit
    fakeProc.fireExit(0, 'SIGKILL')
    await stopPromise
    expect(c.isUp()).toBe(false)
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
}, 8_000)
```

Run: `bun test tests/browser-controller.test.ts -t "SIGTERM"`
Expected: FAIL — `stop()` throws "not implemented yet".

- [ ] **Step 2: Implement `stop()`**

Replace the `stop()` stub in `src/browser-controller.ts`:

```ts
async stop(): Promise<void> {
  this.shutdown = true
  if (this.restartTimer !== null) {
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }
  const proc = this.proc
  if (!proc) return
  this.proc = null

  proc.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }, 5_000)

  await proc.exited.catch(() => {})
  clearTimeout(killTimer)
  this.emit('stopped')
  process.stderr.write('operant: chrome stopped\n')
}
```

Note: Bun's `Subprocess` has an `exited` Promise. `FakeProc` doesn't — give it one for tests:

```ts
class FakeProc {
  // ...existing fields...
  private exitedResolve!: () => void
  exited: Promise<void> = new Promise(r => { this.exitedResolve = r })
  fireExit(code: number | null, signal: string | null) {
    this.exitCode = code
    this.signal = signal
    if (this.onExit) this.onExit(this, code, signal)
    this.exitedResolve()
  }
}
```

- [ ] **Step 3: Run test, expect PASS**

Run: `bun test tests/browser-controller.test.ts -t "SIGTERM"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/browser-controller.ts tests/browser-controller.test.ts
git commit -m "feat(chrome): stop() with SIGTERM → 5s grace → SIGKILL"
```

---

### Task 5: Crash detection + exponential backoff restart

**Files:**
- Modify: `src/browser-controller.ts`
- Modify: `tests/browser-controller.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('crash triggers restart after 1s backoff', async () => {
  const procs: FakeProc[] = []
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => {
    const p = new FakeProc()
    p.onExit = opts.onExit
    procs.push(p)
    return p as any
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
    await c.start()
    expect(procs.length).toBe(1)

    // Simulate crash
    procs[0]!.fireExit(137, 'SIGKILL')

    // After ~1s the controller should respawn
    await new Promise(r => setTimeout(r, 1_200))
    expect(procs.length).toBe(2)
    expect(c.isUp()).toBe(true)

    await c.stop()
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
}, 6_000)

test('escalates after 5 crashes within 60s', async () => {
  const procs: FakeProc[] = []
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => {
    const p = new FakeProc()
    p.onExit = opts.onExit
    procs.push(p)
    return p as any
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
  ]))

  let escalated = false
  try {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
    c.on('chrome:escalated', () => { escalated = true })
    await c.start()

    // Crash 5 times in succession (the controller respawns; we crash again immediately)
    for (let i = 0; i < 5; i++) {
      procs[procs.length - 1]!.fireExit(1, null)
      // wait long enough for the backoff to fire
      await new Promise(r => setTimeout(r, (1 << i) * 1000 + 300))
    }
    expect(escalated).toBe(true)

    await c.stop()
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
  }
}, 70_000)
```

Run: `bun test tests/browser-controller.test.ts -t "crash"`
Expected: FAIL.

- [ ] **Step 2: Implement crash handling**

Replace the `handleExit()` placeholder and add restart logic:

```ts
private handleExit(code: number | null, signal: string | null): void {
  this.proc = null
  if (this.shutdown) return

  // Reset crash count if Chrome was stable for ≥60s before exiting
  if (Date.now() - this.startedAt > 60_000) this.crashCount = 0

  this.crashCount++
  process.stderr.write(`operant: chrome exited (code=${code} signal=${signal}) — crash ${this.crashCount}\n`)

  if (this.crashCount > 5) {
    process.stderr.write('operant: chrome escalated after 5 crashes\n')
    this.emit('chrome:escalated')
    return
  }

  const delay = Math.min(2 ** (this.crashCount - 1), 30) * 1000
  process.stderr.write(`operant: chrome restarting in ${delay / 1000}s\n`)
  this.restartTimer = setTimeout(() => {
    this.restartTimer = null
    this.start().catch(err => process.stderr.write(`operant: chrome restart failed: ${err}\n`))
  }, delay)
}
```

- [ ] **Step 3: Run tests, expect PASS**

Run: `bun test tests/browser-controller.test.ts -t "crash"`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/browser-controller.ts tests/browser-controller.test.ts
git commit -m "feat(chrome): crash backoff + escalation after 5 failures"
```

---

### Task 6: Profile-dir SingletonLock cleanup

**Files:**
- Modify: `src/browser-controller.ts`
- Modify: `tests/browser-controller.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('start() removes a stale SingletonLock before spawning', async () => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const tmp = await fs.mkdtemp('/tmp/cc-bc-')
  const lock = path.join(tmp, 'SingletonLock')
  await fs.writeFile(lock, '')

  const fakeProc = new FakeProc()
  const originalSpawn = Bun.spawn
  ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; return fakeProc as any }
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeFetchStub(new Map([
    ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
  ]))

  try {
    const c = new BrowserController({ port: 9999, profileDir: tmp, executablePath: '/bin/true' })
    await c.start()
    // SingletonLock should be gone
    let exists = true
    try { await fs.access(lock) } catch { exists = false }
    expect(exists).toBe(false)
    await c.stop()
  } finally {
    ;(Bun as any).spawn = originalSpawn
    globalThis.fetch = originalFetch
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
```

Run: expect FAIL.

- [ ] **Step 2: Implement lock cleanup at the top of `start()`**

Add to the top of `start()` (after `if (this.isUp()) return`):

```ts
// Clear stale SingletonLock from an unclean prior shutdown.
try {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.unlink(path.join(this.deps.profileDir, 'SingletonLock'))
} catch { /* not present, fine */ }
```

- [ ] **Step 3: Run test, expect PASS.**
- [ ] **Step 4: Commit**

```bash
git add src/browser-controller.ts tests/browser-controller.test.ts
git commit -m "feat(chrome): clear stale SingletonLock at start"
```

---

### Task 7: `chromeEnabled: false` short-circuits

**Files:**
- Modify: `src/browser-controller.ts` (no change — handled at the daemon layer)
- Modify: `tests/browser-controller.test.ts` (no change)
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Failing test**

Append to `/home/operant/tests/config.test.ts`:

```ts
test('loadOperantConfig honors chromeEnabled, chromePort, chromeExecutablePath defaults', () => {
  const cfg = loadOperantConfigFromObject({})
  expect(cfg.chromeEnabled).toBeUndefined()      // default applied at daemon level
  expect(cfg.chromePort).toBeUndefined()
  expect(cfg.chromeExecutablePath).toBeUndefined()
})

test('loadOperantConfig passes through chrome config when present', () => {
  const cfg = loadOperantConfigFromObject({
    chromeEnabled: false,
    chromePort: 9300,
    chromeExecutablePath: '/usr/bin/chromium',
  })
  expect(cfg.chromeEnabled).toBe(false)
  expect(cfg.chromePort).toBe(9300)
  expect(cfg.chromeExecutablePath).toBe('/usr/bin/chromium')
})
```

(Use whichever helper the existing `tests/config.test.ts` exposes for object-form input. If it's only file-based, write a temp JSON fixture instead.)

Run: expect FAIL — fields not on the type.

- [ ] **Step 2: Add config fields**

In `/home/operant/src/types.ts`, extend `OperantConfig`:

```ts
export type OperantConfig = {
  // ...existing fields...
  chromeEnabled?: boolean
  chromePort?: number
  chromeExecutablePath?: string
}
```

In `/home/operant/src/config.ts`, in the `loadOperantConfig` (or equivalent) result object, pass through the fields:

```ts
chromeEnabled: raw.chromeEnabled,
chromePort: raw.chromePort,
chromeExecutablePath: raw.chromeExecutablePath,
```

- [ ] **Step 3: Run tests, expect PASS.**
- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(chrome): config knobs for enable/port/executable"
```

---

## Phase 2 — Daemon wiring

### Task 8: Wire BrowserController into the daemon

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Add the import + helper**

At the top of `src/daemon.ts` near the other imports:

```ts
import { BrowserController } from './browser-controller'
```

And add a helper near the top:

```ts
async function findChromiumPath(override?: string): Promise<string | null> {
  if (override) return override
  try {
    const { chromium } = await import('playwright')
    const p = chromium.executablePath()
    if (p) return p
  } catch { /* playwright not installed or chromium not downloaded */ }
  return null
}
```

- [ ] **Step 2: Construct + start the controller**

After the existing `taskMonitor` construction (around line 146), add:

```ts
// Headless Chrome — daemon-managed, attached by chrome-devtools-mcp.
let browserController: BrowserController | null = null
if (config.chromeEnabled !== false) {
  const exec = await findChromiumPath(config.chromeExecutablePath)
  if (!exec) {
    process.stderr.write('operant: chrome disabled — chromium binary not found (run "bunx playwright install chromium")\n')
  } else {
    browserController = new BrowserController({
      port: config.chromePort ?? 9222,
      profileDir: join(OPERANT_DIR, 'chrome-profile'),
      executablePath: exec,
    })
    browserController.start().catch(err => process.stderr.write(`operant: chrome failed to start: ${err}\n`))
  }
}
```

- [ ] **Step 3: Stop on shutdown**

In the existing `shutdown()` function, add (right after the other frontend stops):

```ts
if (browserController) {
  await browserController.stop().catch(err => process.stderr.write(`operant: chrome stop error: ${err}\n`))
}
```

- [ ] **Step 4: Verify type-check + tests**

Run:
```bash
bun tsc --noEmit
bun test
```

Expected: clean type-check; full suite still passes (no behavioral change to existing tests; new chrome code only runs when daemon boots).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(chrome): wire BrowserController into daemon start/stop"
```

---

## Phase 3 — Documentation + integration test

### Task 9: README setup section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Browser (headless Chrome)" section**

Append (or insert in the appropriate spot) the following after the existing "Frontends" section in `/home/operant/README.md`:

```markdown
## Browser (headless Chrome)

Operant auto-spawns a headless Chrome on `127.0.0.1:9222` so Claude
sessions can drive a browser via Google's
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).

**One-time setup:**

```bash
# In the operant repo:
bunx playwright install chromium

# Add chrome-devtools-mcp to your ~/.claude.json mcpServers:
{
  "mcpServers": {
    "operant": { "command": "bun", "args": ["run", "/path/to/operant/src/shim.ts"] },
    "chrome": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp", "--browserURL", "http://127.0.0.1:9222"]
    }
  }
}
```

When the daemon starts, you'll see:

```
operant: chrome started (pid=…, port=9222)
```

**Disable it** by setting `chromeEnabled: false` in
`~/.claude/channels/operant/config.json`. **Override the port** with
`chromePort` or the binary path with `chromeExecutablePath`. The
persistent profile lives at `~/.claude/channels/operant/chrome-profile/`
(cookies and logins survive restarts; share carefully across
sessions).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(chrome): setup section + sample mcpServers block"
```

---

### Task 10: Opt-in integration test

**Files:**
- Create: `tests/browser-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/browser-integration.test.ts
import { describe, test, expect } from 'bun:test'
import { BrowserController } from '../src/browser-controller'
import { mkdtemp, rm } from 'node:fs/promises'

const ENABLED = process.env.BROWSER_E2E === '1'
const d = ENABLED ? describe : describe.skip

d('BrowserController (real Chrome)', () => {
  test('start, /json/version reachable, stop kills it', async () => {
    const tmp = await mkdtemp('/tmp/cc-bce-')
    const { chromium } = await import('playwright')
    const exec = chromium.executablePath()
    if (!exec) throw new Error('playwright chromium binary not installed (run: bunx playwright install chromium)')

    // Pick a free port: bind a probe socket, read the assigned port, close.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop()

    const ctrl = new BrowserController({ port, profileDir: tmp, executablePath: exec })
    try {
      await ctrl.start()
      const v = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()) as { Browser?: string }
      expect(v.Browser ?? '').toMatch(/^HeadlessChrome/)
      await ctrl.stop()
      expect(ctrl.isUp()).toBe(false)
    } finally {
      try { await ctrl.stop() } catch { /* already stopped */ }
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
```

- [ ] **Step 2: Verify it skips by default**

Run: `bun test tests/browser-integration.test.ts`
Expected: 0 pass, 0 fail, 1 skipped.

- [ ] **Step 3: Run it once with the real browser to confirm it works**

```bash
bunx playwright install chromium
BROWSER_E2E=1 bun test tests/browser-integration.test.ts
```
Expected: 1 pass.

- [ ] **Step 4: Commit**

```bash
git add tests/browser-integration.test.ts
git commit -m "test(chrome): opt-in BROWSER_E2E integration test"
```

---

### Task 11: Opt-in CI workflow

**Files:**
- Create: `.github/workflows/browser-e2e.yml`

- [ ] **Step 1: Add the workflow**

```yaml
name: Browser E2E

on:
  pull_request:
    paths:
      - 'src/browser-controller.ts'
      - 'tests/browser-integration.test.ts'
      - '.github/workflows/browser-e2e.yml'

jobs:
  browser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx playwright install chromium --with-deps
      - run: BROWSER_E2E=1 bun test tests/browser-integration.test.ts
        env:
          BROWSER_E2E: '1'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/browser-e2e.yml
git commit -m "ci(chrome): opt-in browser E2E workflow"
```

---

## Phase 4 — Verification

### Task 12: Run the full smoke checklist

- [ ] **Step 1: Install chromium (one-time)**

```bash
cd /home/operant
bunx playwright install chromium
```

- [ ] **Step 2: Restart the daemon and confirm Chrome auto-starts**

```bash
tmux kill-session -t operant-daemon 2>/dev/null
tmux new-session -d -s operant-daemon "bun run src/daemon.ts"
sleep 3
tmux capture-pane -t operant-daemon -p | tail -10
```

Expected: log line `operant: chrome started (pid=…, port=9222)`.

- [ ] **Step 3: Probe the CDP endpoint**

```bash
curl -s http://127.0.0.1:9222/json/version | jq .Browser
```

Expected output: `"HeadlessChrome/<version>"`.

- [ ] **Step 4: Crash + restart sanity**

```bash
# Find the chrome PID from the daemon log line, then:
kill <chrome-pid>
sleep 2
tmux capture-pane -t operant-daemon -p | tail -5
```

Expected: log shows `chrome exited` and `chrome restarting in 1s`, then a new `chrome started` line.

- [ ] **Step 5: Clean shutdown**

```bash
tmux kill-session -t operant-daemon
ps -ef | grep -i chromium | grep -v grep
```

Expected: no orphan chromium process.

- [ ] **Step 6: Add chrome-devtools-mcp to ~/.claude.json**

(One-time per developer; documented in README.) Restart a Claude session that uses `--channels server:operant`. Verify `chrome.navigate` and `chrome.screenshot` are listed in the available tools and that calling them works against a public URL.

- [ ] **Step 7: Update PR description with the checked-off list**

No commit unless something needed tweaking.

---

## Self-review

**Spec coverage**
- §2 in (browser controller class): Tasks 1–6
- §2 in (daemon wiring): Task 8
- §2 in (config knobs): Task 7
- §2 in (README): Task 9
- §2 in (opt-in integration test): Task 10
- §2 in (CI gating): Task 11
- §4.1 file layout: matches Task list
- §4.2 controller shape: Tasks 1, 2, 4
- §4.3 spawn arguments: Task 2
- §4.4 daemon wiring: Task 8
- §5.1 boot: Tasks 2 + 8
- §5.3 crash + restart: Task 5
- §5.4 shutdown: Tasks 4 + 8
- §6.2 backoff schedule: Task 5
- §6.3 profile-corruption recovery: Task 6 covers `SingletonLock` cleanup; full rename-to-`.broken-<ts>` is left as a follow-up because the spec marks it as an after-5-failures recovery that depends on observing the same error 5 times — implementing that without a real failing chromium to test against would be speculative. If it becomes a real issue, add it as a Task 13 patch in a follow-up PR.
- §7 error handling: Tasks 2 (timeout), 4 (shutdown grace), 5 (crash + escalation), 6 (lock), 8 (binary missing logged + continue, `chromeEnabled: false` short-circuit)
- §8.1 unit tests: Tasks 1–6 each add coverage; total ~10 cases
- §8.2 integration test: Task 10
- §8.3 manual smoke: Task 12
- §8.4 CI: Task 11

**Placeholder scan**
- "Implementation in Task 4" appears in Task 2's `handleExit` placeholder — that's correct cross-referencing, not a placeholder.
- No "TBD", "TODO", or "implement later" in step bodies.
- All test code blocks are complete; all implementation code blocks are complete.
- Task 7's "If it's only file-based, write a temp JSON fixture instead" is a small fork. Acceptable because the existing test file's helper is the engineer's choice; both paths are well-defined.

**Type consistency**
- `BrowserController`, `BrowserControllerDeps`, `start`, `stop`, `restart`, `isUp`, `waitUntilUp`, `chrome:escalated`, `findChromiumPath`, `chromeEnabled`, `chromePort`, `chromeExecutablePath` — all spelled identically in every appearance.
- The `FakeProc` fixture is augmented across tasks (each augmentation noted explicitly).

No issues found.
