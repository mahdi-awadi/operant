# Headless Chrome Frontend — Design

**Status:** approved 2026-05-03
**Author:** mahdi.awadi@gmail.com (with Claude)
**Branch:** `feat/headless-chrome`

## 1. Goal

Add a daemon-managed headless Chrome instance to operant so Claude
sessions can drive a browser (navigate, click, screenshot, evaluate, network
inspect, perf trace) via Google's [`chrome-devtools-mcp`][cdm]. Chrome runs
co-located with the daemon, exposes its CDP endpoint on `127.0.0.1:9222`,
and `chrome-devtools-mcp` (registered in the user's `~/.claude.json`)
attaches to it for every session.

[cdm]: https://github.com/ChromeDevTools/chrome-devtools-mcp

## 2. Scope

In:

- New `BrowserController` class that owns Chrome's lifecycle: spawn,
  health-poll, crash-restart with exponential back-off, escalation after
  repeated failures, clean shutdown.
- Daemon wires the controller into start/stop alongside the other
  components. `chromeEnabled: false` in config short-circuits everything.
- Persistent profile at `~/.claude/channels/hub/chrome-profile/` (cookies,
  IndexedDB, logged-in state survive crashes and daemon restarts). Incognito
  tabs available via chrome-devtools-mcp's existing isolation flag — no
  operant plumbing needed.
- README setup section: install Playwright's bundled Chromium with
  `bunx playwright install chromium`; example `~/.claude.json` mcpServers
  entry for the `chrome` server.
- Unit tests with stubbed `Bun.spawn` + `fetch`; one opt-in integration
  test gated behind `BROWSER_E2E=1` for binary-path regressions.

Out:

- Per-session tab pinning. With shared Chrome + chrome-devtools-mcp
  registered as a single MCP, sessions share the tab pool. Pin-by-session
  is a follow-up if it bites.
- Lazy-start / idle-shutdown of Chrome. Considered, rejected: composition
  with chrome-devtools-mcp's per-session-spawn lifecycle requires either
  ~150 MB always-on or a glue-shim launcher. Always-on chosen for
  simplicity. Idle-shutdown can land later if RAM pressure justifies it.
- Public DevTools tunnel through Traefik. CDP port stays bound to
  `127.0.0.1`. SSH-tunnel if you ever need DevTools UI from the laptop.
- Auto-editing the user's `~/.claude.json`. The README documents the
  required block; the user adds it manually (matches how the `hub` MCP
  is registered today).
- Building our own MCP server for Chrome control. We use chrome-devtools-mcp
  as-is — it already exposes ~30 well-tested tools.

## 3. Approach

**Hybrid: daemon owns Chrome lifecycle, chrome-devtools-mcp owns the
protocol surface.** Daemon spawns Chrome with
`--remote-debugging-port=9222`. Per-session, Claude Code spawns
chrome-devtools-mcp on demand and configures it with
`--browserURL=http://127.0.0.1:9222`, which makes it attach to *our*
Chrome instead of launching its own. Net result: one Chrome, many MCP
client processes, all sessions sharing storage.

The trade-off accepted: Chrome must be running before any session calls
`chrome.*` MCP tools. Auto-start at daemon boot makes this implicit and
removes the need for a glue-launcher shim.

## 4. Architecture

### 4.1 File layout

```
src/browser-controller.ts        — new (~200 lines)
src/daemon.ts                    — modify (~10 lines: construct + start + stop)
src/types.ts                     — modify (~3 lines: chromeEnabled, chromePort, chromeExecutablePath)
src/config.ts                    — modify (~5 lines: read new fields with defaults)
package.json                     — modify (add `playwright` peer-dep for the chromium binary + executablePath() helper)
README.md                        — modify (setup section + example .claude.json)
tests/browser-controller.test.ts — new (~250 lines, ~10 cases)
tests/browser-integration.test.ts — new (~50 lines, opt-in)
```

### 4.2 `BrowserController` shape

```ts
type BrowserControllerDeps = {
  port: number
  profileDir: string
  executablePath: string
  args?: string[]                  // optional extra chromium flags
}

class BrowserController extends EventEmitter {
  // events: 'started', 'stopped', 'crashed', 'chrome:escalated'
  start(): Promise<void>           // idempotent
  stop(): Promise<void>            // SIGTERM → 5s grace → SIGKILL
  restart(): Promise<void>         // stop() then start()
  isUp(): boolean                  // process alive AND port 9222 reachable
  waitUntilUp(timeoutMs: number): Promise<void>
}
```

Internal state: `proc`, `restartTimer`, `shutdown` flag, `crashCount`,
`lastCrashAt`.

### 4.3 Spawn arguments

```
--headless=new
--remote-debugging-port=<port>
--remote-debugging-address=127.0.0.1
--user-data-dir=<profileDir>
--no-first-run
--no-default-browser-check
--disable-gpu
--disable-dev-shm-usage
```

### 4.4 Daemon wiring

```ts
const browser = new BrowserController({
  port: config.chromePort ?? 9222,
  profileDir: join(HUB_DIR, 'chrome-profile'),
  executablePath: config.chromeExecutablePath ?? findPlaywrightChromium(),
})
if (config.chromeEnabled !== false) {
  browser.start().catch(err => process.stderr.write(`hub: chrome failed to start: ${err}\n`))
}
// in shutdown(): await browser.stop()
```

`findPlaywrightChromium()` resolves the binary path via
`(await import('playwright')).chromium.executablePath()` — works
post-`playwright install chromium`. Falls through to `which chromium`
then config override.

### 4.5 MCP registration (user-managed)

The README documents adding this block to `~/.claude.json`:

```json
{
  "mcpServers": {
    "hub": { "command": "bun", "args": ["run", "/path/to/operant/src/shim.ts"] },
    "chrome": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp", "--browserURL", "http://127.0.0.1:9222"]
    }
  }
}
```

We do not auto-edit the file — it is the user's, and their other MCPs are
in there too.

## 5. Data flow

### 5.1 Boot

```
daemon start
  → load config
  → BrowserController(deps)
  → if chromeEnabled !== false:
       browser.start()
        ├─ Bun.spawn(executablePath, args)
        ├─ poll http://127.0.0.1:<port>/json/version every 200ms (max 10s)
        └─ emit 'started' OR throw if timeout
  → other frontends start
  → daemon ready
```

A Chrome failure to start does **not** block the daemon. Logs and
continues — sessions just won't have browser tools until the user fixes
the underlying problem.

### 5.2 Per-MCP-call flow (Claude → Chrome)

```
Claude in session A wants to navigate
  → calls chrome.navigate(url)
  → Claude Code spawns/reuses chrome-devtools-mcp subprocess
  → that subprocess connects to http://127.0.0.1:9222 (our Chrome)
  → CDP message round-trip
  → result returned to Claude
```

Daemon is not in the request path — chrome-devtools-mcp talks to Chrome
directly via CDP. Daemon's only job is to keep Chrome alive.

### 5.3 Crash + restart

```
Chrome process exits (OOM, segfault, headless render bug)
  → Bun.spawn 'exit' event fires on BrowserController.proc
  → if !this.shutdown:
       log exit code/signal
       schedule restart() with exponential back-off (1s, 2s, 4s, 8s, 16s, 30s)
       reset back-off after 60s of stable uptime
  → restart() spawns fresh Chrome reusing the same profile dir
  → in-flight chrome-devtools-mcp connections see EOF
       → next Claude call re-attaches transparently
```

Persistent profile means cookies/auth survive crashes. In-flight tabs do
not — each Claude call starts a fresh tab anyway.

### 5.4 Shutdown

```
SIGINT/SIGTERM on daemon
  → existing shutdown() runs:
       taskMonitor.stopPolling()
       saveSessions(...)
       webFrontend.stop()
       telegramFrontend.stop()
       browser.stop()        ← new
  → browser.stop() sends SIGTERM → waits 5s → SIGKILL if needed
```

## 6. Components

### 6.1 Lifecycle methods

| Method | Behavior |
|---|---|
| `start()` | Idempotent. If already up, no-op. Spawn → wait for `/json/version`. Reject on timeout. |
| `stop()` | Set `shutdown = true`. Clear restart timer. SIGTERM → 5s wait → SIGKILL. Resolve. |
| `restart()` | `stop()` then `start()`. Used by crash handler. |
| `isUp()` | `proc !== null && proc.exitCode === null` (best-effort; doesn't probe port). |
| `waitUntilUp(t)` | Poll `/json/version` until success or timeout. |

### 6.2 Crash backoff

```
crashCount = 0
on exit while !shutdown:
  log "chrome exited (code=X signal=Y) — restarting in <delay>s"
  delay = min(2^crashCount, 30) seconds
  crashCount++
  schedule restart(delay)
on stable uptime ≥ 60s after start:
  crashCount = 0
on crashCount > 5 within 60s:
  emit 'chrome:escalated'
  stop auto-restarting
```

### 6.3 Profile-corruption recovery

If 5 consecutive starts fail with the same error and the profile dir
has a `SingletonLock` file from an unclean prior shutdown, the controller
clears the lock once and retries. If THAT also fails, the profile dir is
renamed to `chrome-profile.broken-<ts>/` and a fresh start is attempted.
Success after rename emits a one-time warning that user storage is gone.
Failure after rename escalates.

### 6.4 Config knobs

```ts
type HubConfig = {
  // ...existing fields...
  chromeEnabled?: boolean        // default: true
  chromePort?: number            // default: 9222
  chromeExecutablePath?: string  // default: Playwright chromium
}
```

Existing daemons without these keys keep working — Chrome auto-starts
unless explicitly disabled.

## 7. Error handling

### 7.1 Failure modes

| Failure | Response |
|---|---|
| Chromium binary missing | `start()` throws `ChromeBinaryNotFound`; daemon logs the install command and continues. |
| Port already in use | `Bun.spawn` raises; log + continue; CLI subcommand `hub-ctl chrome status` (out of scope v1) would diagnose. |
| Chrome spawns but `/json/version` unreachable | `waitUntilUp(10s)` rejects → kill `proc` → log + continue. |
| Crash while running | Backoff restart; escalate after 5 crashes within 60s. |
| Profile-dir corruption | One-time rename + fresh start; escalate if still failing. |
| Shutdown hang | 5s wait then SIGKILL. Daemon shutdown unblocks. |
| chrome-devtools-mcp can't reach `127.0.0.1:9222` | MCP returns error to Claude, who can retry. Independent of our `isUp()`. |

### 7.2 Defensive guards

- `start()` is idempotent.
- `stop()` clears `proc` before awaiting exit so re-entrant stop doesn't double-kill.
- Restart timer is canceled on `stop()`.
- `chromeEnabled: false` short-circuits — existing daemons keep working without breakage.

### 7.3 Logging conventions

```
hub: chrome started (pid=XXXXX, port=9222)
hub: chrome exited (code=137 signal=SIGKILL) — restarting in 1s
hub: chrome failed to start: <err>
hub: chrome disabled — chromium binary not found (run "bunx playwright install chromium")
hub: chrome escalated after 5 crashes
hub: chrome stopped
```

### 7.4 Concurrency

Bun is single-threaded. All controller state mutations happen on the main
event loop. No locking needed.

## 8. Testing

### 8.1 Unit tests — `tests/browser-controller.test.ts`

~10 cases with stubbed `Bun.spawn` and `fetch`:

- `start()` spawns chromium with the expected args
- `start()` resolves when `/json/version` returns 200
- `start()` rejects after `waitUntilUp` timeout
- `start()` is idempotent
- `stop()` sends SIGTERM then SIGKILL after 5s
- Crash triggers backoff restart 1s → 2s → 4s → 8s
- 5 crashes in 60s emits `chrome:escalated`
- Profile-dir corruption: renames `.broken-<ts>` after 5 fails
- `shutdown=true` suppresses crash-restart
- `chromeEnabled: false` short-circuits `start()`

### 8.2 Integration test — `tests/browser-integration.test.ts`

Skipped unless `BROWSER_E2E=1` (so default CI doesn't pull 200 MB):

```ts
test('real Chrome starts, /json/version reachable, stop() kills it', async () => {
  const ctrl = new BrowserController({ port: 0, profileDir: tmpDir, executablePath: ... })
  await ctrl.start()
  const v = await fetch(`http://127.0.0.1:${ctrl.port}/json/version`).then(r => r.json())
  expect(v.Browser).toMatch(/^HeadlessChrome/)
  await ctrl.stop()
  expect(ctrl.isUp()).toBe(false)
})
```

### 8.3 Manual smoke checklist (PR description)

- [ ] `bunx playwright install chromium` succeeds
- [ ] Daemon log shows `hub: chrome started (pid=…, port=9222)`
- [ ] `curl -s http://127.0.0.1:9222/json/version | jq .Browser` returns
      `HeadlessChrome/<ver>`
- [ ] After adding the `chrome` mcpServers block to `~/.claude.json` and
      restarting a session, Claude can call `chrome.navigate` /
      `chrome.screenshot`
- [ ] `kill <chrome-pid>` shows backoff restart in daemon log
- [ ] `tmux kill-session -t hub-daemon` kills Chrome (no orphan process)

### 8.4 CI

Existing `bun test` job picks up the new unit tests. A separate
opt-in job (added in `.github/workflows/browser-e2e.yml`) sets
`BROWSER_E2E=1`, runs `bunx playwright install chromium --with-deps`,
and executes the integration test only on PRs that touch
`src/browser-controller.ts`.

Expected total: 574 → ~585 unit tests.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Playwright Chromium binary path changes between versions | `findPlaywrightChromium()` falls through to `which chromium` then config override |
| Headless-rendering bug crashes on certain pages | Backoff restart + escalation after 5 crashes |
| `--user-data-dir` lock left after unclean shutdown | Clean `SingletonLock` once before declaring corruption |
| RAM creep on long-running Chrome | Optional restart-every-N-hours config knob (out of scope v1) |
| Per-session storage collision (one session's `localStorage.clear()` nukes another's auth) | Documented in README; opt-in incognito tabs as the workaround |

## 10. Follow-ups (not this PR)

- Per-session tab pinning (a thin wrapper MCP that names tabs `[session]:N`).
- Idle-shutdown / lazy-restart with configurable timeout.
- DevTools UI exposure through Traefik (auth-gated).
- Restart-every-N-hours knob for memory hygiene.
- Web dashboard "Browser" tab showing currently open tabs + a "kill all
  tabs" button.
