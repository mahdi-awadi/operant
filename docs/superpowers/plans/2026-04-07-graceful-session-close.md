# Graceful Session Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a close action to the operant that gracefully exits Claude Code before killing its tmux session, exposed as a `✕` button in the web dashboard and wired into the existing Telegram `/kill` command.

**Architecture:** A new `ScreenManager.gracefulKill()` method drives Claude via `tmux send-keys` (Ctrl+C to cancel any in-progress work, then `/exit` to quit), polls `tmux has-session` to confirm the session dies on its own, and falls back to `tmux kill-session` after a 3-second timeout. The existing hard-kill `kill()` method is preserved for fast daemon shutdown in `killAll()`. The web `POST /api/kill` endpoint and Telegram `/kill` command are switched to call `gracefulKill()`.

**Tech Stack:** Bun, TypeScript, `bun:test`, tmux (via `bun sh` tag `$`), single-file HTML+JS web client.

---

## File Structure

### Files to modify

- `src/screen-manager.ts` — add `gracefulKill()` method and three new timing constants. `kill()` and `killAll()` are untouched.
- `src/frontends/web.ts` — change `handleKill()` to call `gracefulKill()` instead of `kill()`. Single-line change.
- `src/frontends/telegram.ts` — change the `/kill` command handler to call `gracefulKill()`. Single-line change.
- `src/frontends/web-client.html` — add a `✕` close button in the session list render loop and a `closeSession(name)` function.
- `tests/screen-manager.test.ts` — add tests covering the fallback path and no-op-on-unknown-name behavior.

### Files NOT modified

- `src/cli.ts` — CLI calls `POST /api/kill` over HTTP and is graceful for free.
- `src/daemon.ts` — `killAll()` on shutdown continues to use the hard `kill()` path for fast exit.
- `src/session-registry.ts` — session status transitions happen naturally when the shim disconnects.

---

## Task 1: Add `gracefulKill` method to ScreenManager

**Files:**
- Modify: `src/screen-manager.ts`

- [ ] **Step 1: Add the three timing constants**

Open `src/screen-manager.ts` and locate the existing constants near the top (the `CLAUDE_CMD`, `CONFIRM_DELAY`, etc. block around lines 10–14). Add three new constants immediately after `CONFIRM_INTERVAL`:

```ts
const GRACEFUL_CANCEL_DELAY = 300      // ms between Ctrl+C and /exit
const GRACEFUL_POLL_INTERVAL = 250     // ms between has-session polls
const GRACEFUL_TIMEOUT = 3000          // ms total wait before hard kill
```

- [ ] **Step 2: Add the `gracefulKill` method**

Locate the existing `kill(name: string)` method (around line 91). Add the new `gracefulKill` method immediately after `kill()` and before `killAll()`. Paste exactly:

```ts
async gracefulKill(name: string): Promise<void> {
  const entry = this.managed.get(name)
  if (!entry) return

  // Stop respawn first so the monitor doesn't restart the session while we're tearing it down.
  entry.respawnEnabled = false
  const timer = this.respawnTimers.get(name)
  if (timer) {
    clearTimeout(timer)
    this.respawnTimers.delete(name)
  }

  const sessionName = entry.sessionName

  // 1. Cancel any in-progress tool call so Claude is at a clean prompt.
  try { await $`tmux send-keys -t ${sessionName} C-c`.quiet() } catch {}
  await new Promise(r => setTimeout(r, GRACEFUL_CANCEL_DELAY))

  // 2. Ask Claude to exit. Since Claude is the tmux window's only process,
  //    its exit causes tmux to close the window and the session disappears.
  try { await $`tmux send-keys -t ${sessionName} "/exit" Enter`.quiet() } catch {}

  // 3. Poll for the session to disappear on its own, up to GRACEFUL_TIMEOUT.
  const deadline = Date.now() + GRACEFUL_TIMEOUT
  while (Date.now() < deadline) {
    if (!(await this.isSessionRunning(sessionName))) {
      this.managed.delete(name)
      return
    }
    await new Promise(r => setTimeout(r, GRACEFUL_POLL_INTERVAL))
  }

  // 4. Fallback: Claude didn't respond in time, hard-kill tmux.
  try { await $`tmux kill-session -t ${sessionName}`.quiet() } catch {}
  this.managed.delete(name)
}
```

- [ ] **Step 3: Typecheck the module**

Run: `cd /home/agent/claude-code-operant && bun build src/screen-manager.ts --outfile /tmp/gsc-check.js --target bun`
Expected: builds with no errors; the output file is created.

- [ ] **Step 4: Commit**

```bash
cd /home/agent/claude-code-operant
git add src/screen-manager.ts
git commit -m "feat(screen-manager): add gracefulKill method"
```

---

## Task 2: Test — `gracefulKill` is a no-op on unknown name

**Files:**
- Modify: `tests/screen-manager.test.ts`

- [ ] **Step 1: Add the test**

Append inside the `describe('ScreenManager', ...)` block, after the existing `test('addTeammate is a function', ...)` test:

```ts
test('gracefulKill is a no-op for unknown name', async () => {
  // Should not throw and should not affect state.
  await manager.gracefulKill('does-not-exist')
  expect(manager.isManaged('does-not-exist')).toBe(false)
})
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `cd /home/agent/claude-code-operant && bun test tests/screen-manager.test.ts -t "gracefulKill is a no-op"`
Expected: 1 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
cd /home/agent/claude-code-operant
git add tests/screen-manager.test.ts
git commit -m "test(screen-manager): cover gracefulKill no-op on unknown name"
```

---

## Task 3: Test — `gracefulKill` fallback kills stuck tmux session

**Why this test and not a "graceful success" test:** The existing test suite uses real tmux (no mocks). We cannot spawn real Claude Code in tests, so we cannot exercise the `/exit`-responds path end-to-end. We can, however, spawn a fake tmux session running `sleep 60` — it ignores Ctrl+C and `/exit`, forcing the fallback path to fire. That verifies the entire pipeline: respawn cleanup, `tmux send-keys` calls, the `has-session` polling loop, and the fallback `tmux kill-session`. The only piece not exercised by this test is the literal `/exit` string, which is trivially verifiable in code review.

**Files:**
- Modify: `tests/screen-manager.test.ts`

- [ ] **Step 1: Add the test**

Append inside the `describe('ScreenManager', ...)` block, after the test added in Task 2:

```ts
test('gracefulKill falls back to hard kill when session ignores /exit', async () => {
  const name = 'test-fallback'
  const sessionName = `operant-${name}`

  // Start a fake tmux session running `sleep 60` — it won't respond to /exit.
  await $`tmux new-session -d -s ${sessionName} sleep 60`.quiet()

  // Inject it into ScreenManager's managed map so gracefulKill treats it as managed.
  ;(manager as any).managed.set(name, {
    sessionName,
    projectPath: '/tmp',
    respawnEnabled: true,
  })

  // Sanity check: it's running before we call gracefulKill.
  expect(await manager.isSessionRunning(sessionName)).toBe(true)

  // Run gracefulKill. This should take ~3 seconds (cancel delay + timeout)
  // before the fallback fires.
  const start = Date.now()
  await manager.gracefulKill(name)
  const elapsed = Date.now() - start

  // The fallback should have killed the tmux session.
  expect(await manager.isSessionRunning(sessionName)).toBe(false)

  // The managed map should no longer contain the entry.
  expect(manager.isManaged(name)).toBe(false)

  // Sanity check on timing: GRACEFUL_CANCEL_DELAY (300) + GRACEFUL_TIMEOUT (3000)
  // = ~3300ms minimum. Allow a little slack below and a generous ceiling.
  expect(elapsed).toBeGreaterThanOrEqual(3200)
  expect(elapsed).toBeLessThan(6000)
}, 10000) // 10s timeout for this test since it waits ~3.3s
```

- [ ] **Step 2: Add the required `$` import if missing**

At the top of `tests/screen-manager.test.ts`, check if `$` is already imported from `'bun'`. If not, add it:

```ts
import { $ } from 'bun'
```

(If the file already imports `$`, skip this.)

- [ ] **Step 3: Run the test and confirm it passes**

Run: `cd /home/agent/claude-code-operant && bun test tests/screen-manager.test.ts -t "gracefulKill falls back"`
Expected: 1 pass, 0 fail. The test takes roughly 3–4 seconds.

- [ ] **Step 4: Run the full screen-manager test file to confirm nothing broke**

Run: `cd /home/agent/claude-code-operant && bun test tests/screen-manager.test.ts`
Expected: all tests pass (previously 6 tests + 2 new ones from Tasks 2 and 3 = 8 passing).

- [ ] **Step 5: Commit**

```bash
cd /home/agent/claude-code-operant
git add tests/screen-manager.test.ts
git commit -m "test(screen-manager): verify gracefulKill fallback path"
```

---

## Task 4: Switch web `/api/kill` to use `gracefulKill`

**Files:**
- Modify: `src/frontends/web.ts`

- [ ] **Step 1: Update `handleKill`**

Locate `handleKill` (around line 348). The current body calls `this.deps.screenManager.kill(name)`. Change that single line to call `gracefulKill`:

Before:
```ts
await this.deps.screenManager.kill(name)
```

After:
```ts
await this.deps.screenManager.gracefulKill(name)
```

Leave everything else in the method untouched.

- [ ] **Step 2: Typecheck the module**

Run: `cd /home/agent/claude-code-operant && bun build src/frontends/web.ts --outfile /tmp/gsc-check-web.js --target bun`
Expected: builds with no errors.

- [ ] **Step 3: Run the web frontend tests**

Run: `cd /home/agent/claude-code-operant && bun test tests/frontends/web.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /home/agent/claude-code-operant
git add src/frontends/web.ts
git commit -m "feat(web): route /api/kill through gracefulKill"
```

---

## Task 5: Switch Telegram `/kill` command to use `gracefulKill`

**Files:**
- Modify: `src/frontends/telegram.ts`

- [ ] **Step 1: Update the `/kill` command handler**

Locate the `/kill` command handler (around line 239–252). The current body calls `this.screenManager.kill(name)`. Change that single line:

Before:
```ts
await this.screenManager.kill(name)
```

After:
```ts
await this.screenManager.gracefulKill(name)
```

Leave the reply text and surrounding logic untouched.

- [ ] **Step 2: Typecheck the module**

Run: `cd /home/agent/claude-code-operant && bun build src/frontends/telegram.ts --outfile /tmp/gsc-check-tg.js --target bun`
Expected: builds with no errors.

- [ ] **Step 3: Run the telegram frontend tests**

Run: `cd /home/agent/claude-code-operant && bun test tests/frontends/telegram.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /home/agent/claude-code-operant
git add src/frontends/telegram.ts
git commit -m "feat(telegram): route /kill through gracefulKill"
```

---

## Task 6: Add `closeSession` JS function to web client

**Files:**
- Modify: `src/frontends/web-client.html`

- [ ] **Step 1: Find a stable insertion point**

Locate the existing `async function restartSession(name, path)` definition (around line 718). We will add `closeSession` immediately after it.

- [ ] **Step 2: Insert the `closeSession` function**

Immediately after the closing `}` of `restartSession`, add:

```js
    async function closeSession(name) {
      if (!confirm(`Close session '${name}'? Claude will exit, then the tmux will close.`)) return
      try {
        await fetch('/api/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      } catch (err) {
        console.error('Close failed', err)
      }
    }
```

- [ ] **Step 3: Commit**

```bash
cd /home/agent/claude-code-operant
git add src/frontends/web-client.html
git commit -m "feat(web-client): add closeSession helper"
```

---

## Task 7: Render the `✕` close button in the session list

**Files:**
- Modify: `src/frontends/web-client.html`

- [ ] **Step 1: Locate the session list render loop**

Find the block that renders each session row. The restart button is added around lines 507–514 with this structure:

```js
if (s.status === 'disconnected') {
  const restartBtn = document.createElement('button')
  restartBtn.textContent = '↻'
  restartBtn.title = 'Restart session'
  restartBtn.style.cssText = 'background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px;margin-left:auto;'
  restartBtn.onclick = (e) => { e.stopPropagation(); restartSession(s.name, s.path) }
  item.appendChild(restartBtn)
}
```

- [ ] **Step 2: Add the close button immediately after the restart button block**

Paste this block directly after the `if (s.status === 'disconnected') { ... }` block:

```js
if (s.managed && s.status !== 'disconnected') {
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕'
  closeBtn.title = 'Close session'
  closeBtn.style.cssText = 'background:none;border:1px solid #c96;color:#c96;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px;margin-left:auto;'
  closeBtn.onclick = (e) => { e.stopPropagation(); closeSession(s.name) }
  item.appendChild(closeBtn)
}
```

Note: both the restart button and the close button use `margin-left:auto`, but they are mutually exclusive — a session is either `disconnected` (→ restart) or `managed && !disconnected` (→ close). They never render at the same time, so `margin-left:auto` works cleanly for both.

- [ ] **Step 3: Verify the HTML still parses (quick visual check)**

Run: `cd /home/agent/claude-code-operant && node -e "const fs=require('fs'); const html=fs.readFileSync('src/frontends/web-client.html','utf8'); console.log('length:', html.length); if (!html.includes('closeSession')) throw new Error('closeSession missing'); if (!html.includes(\"textContent = '✕'\")) throw new Error('close button missing'); console.log('OK')"`
Expected: prints `length: <N>` and `OK` with no thrown error.

- [ ] **Step 4: Commit**

```bash
cd /home/agent/claude-code-operant
git add src/frontends/web-client.html
git commit -m "feat(web-client): add close button to session list"
```

---

## Task 8: Full test run and manual smoke test

**Files:** (none)

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/agent/claude-code-operant && bun test`
Expected: all tests pass. Previously the suite reported 53 tests; after Tasks 2 and 3 it should report 55 tests passing.

- [ ] **Step 2: Restart the daemon for manual smoke test**

Run:
```bash
tmux kill-session -t operant-daemon 2>/dev/null
cd /home/agent/claude-code-operant
tmux new-session -d -s operant-daemon "bun run src/daemon.ts"
sleep 2
tmux capture-pane -t operant-daemon -p | tail -20
```
Expected: daemon starts without errors, listening on its socket and web port.

- [ ] **Step 3: Smoke test — spawn a session via the web UI or CLI, then close it**

This step is a human verification. Do one of:

**Option A (CLI):**
```bash
cd /home/agent/claude-code-operant
OPERANT_URL=http://localhost:3000 bun run src/cli.ts spawn smoke-close /tmp
# wait ~5 seconds for Claude to be ready
OPERANT_URL=http://localhost:3000 bun run src/cli.ts kill smoke-close
# verify the tmux session is gone
tmux has-session -t operant-smoke-close 2>&1
# expected: "can't find session: operant-smoke-close"
```

**Option B (web UI):** Open the web dashboard, spawn a session in `/tmp` named `smoke-close`, wait for it to show as connected, click the `✕` button, confirm the dialog, and verify the session disappears from the list within a few seconds. Then run `tmux has-session -t operant-smoke-close` in a terminal and confirm it fails.

- [ ] **Step 4: Final commit (if any spec/plan touch-ups needed)**

If Tasks 1–7 already committed everything, there is nothing to commit here. If any ad-hoc fix was needed during the smoke test, commit it with a descriptive message. Otherwise skip this step.
