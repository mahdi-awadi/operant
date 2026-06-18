# Graceful Session Close — Design Spec

## Overview

Add a close action to the operant that gracefully exits Claude before tearing down its tmux session, with a hard-kill fallback if Claude doesn't respond in time. Expose the action as a `✕` button in the web dashboard (for managed sessions only) and update the existing Telegram `/kill` and CLI `kill` commands to use the same graceful path.

## Problem

The operant currently supports killing managed sessions via `screenManager.kill()`, which immediately runs `tmux kill-session`. This hard-kills Claude with no chance to close MCP connections cleanly. Additionally, the web dashboard has no UI to close a session — only a Restart button that appears when a session is already disconnected.

## Goals

- Web dashboard shows a `✕` button next to managed, connected sessions.
- Closing a session attempts to exit Claude cleanly first, then falls back to killing tmux.
- Telegram `/kill` and CLI `kill` commands use the same graceful path.
- Non-managed (auto-detected) sessions show no close button — the operant doesn't own their tmux.
- Daemon shutdown (`killAll`) remains a hard kill for fast exit.

## Non-Goals

- No graceful close for non-managed sessions (the operant didn't spawn them).
- No new MCP-level "exit" protocol — we drive Claude via `tmux send-keys`, same mechanism already used for `autoConfirm` and `sendPrompt`.
- No confirmation-suppression flag or "force close" mode. Single action.

## Design

### Backend — `src/screen-manager.ts`

Add a new method `gracefulKill(name: string): Promise<void>` with this flow:

1. Look up the managed entry. If not found → return (no-op, same as current `kill`).
2. Disable respawn and clear any pending respawn timer (same as current `kill`).
3. Send `Ctrl+C` via `tmux send-keys -t <sessionName> C-c` to cancel any in-progress tool call, so `/exit` isn't swallowed as a user message.
4. Wait ~300ms.
5. Send `/exit` via `tmux send-keys -t <sessionName> "/exit" Enter`.
6. Poll `isSessionRunning(sessionName)` every 250ms for up to 3 seconds. Claude exiting causes tmux to close the window and (since Claude is the window's only process) the session — so `has-session` will start failing on its own.
7. If the session is still alive after 3 seconds → fallback: `tmux kill-session -t <sessionName>`.
8. Remove the entry from the `managed` map.

Wrap each `tmux` call in `try/catch` so a spurious failure at any step doesn't prevent later steps (especially the fallback kill).

Keep the existing `kill()` method unchanged. `killAll()` continues to use `kill()` for fast daemon shutdown.

#### Constants

Add near the top of the file:

```ts
const GRACEFUL_CANCEL_DELAY = 300      // ms between Ctrl+C and /exit
const GRACEFUL_POLL_INTERVAL = 250     // ms between has-session polls
const GRACEFUL_TIMEOUT = 3000          // ms total wait before hard kill
```

### Backend — `src/frontends/web.ts`

Change `handleKill()` to call `screenManager.gracefulKill(name)` instead of `kill(name)`. The `/api/kill` endpoint contract is unchanged: `POST { name } → { ok: true }`.

### Backend — `src/frontends/telegram.ts`

Change the `/kill` command handler to call `screenManager.gracefulKill(name)` instead of `kill(name)`. Telegram reply text is unchanged.

### Backend — `src/cli.ts`

The CLI hits `POST /api/kill` over HTTP, which now goes through the graceful path automatically. No CLI-side code change required.

### Frontend — `src/frontends/web-client.html`

In the session list rendering loop (around line 507), add a close button that renders when:

- `s.managed === true`
- `s.status !== 'disconnected'` (disconnected sessions already show the Restart `↻` button in that slot)

Button details:

- Text: `✕`
- `title="Close session"`
- Style: mirrors the restart button, with a muted-red accent (e.g., border and color `#c96`-ish or similar existing muted accent already present in the theme).
- `margin-left: auto` so it right-aligns like the restart button.
- `onclick = (e) => { e.stopPropagation(); closeSession(s.name) }`

Add a `closeSession(name)` function:

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

The existing WebSocket broadcast (`sessionsUpdate` or equivalent) already refreshes the session list when a session disconnects, so no manual refresh is needed.

## Data Flow

```
User clicks ✕ in web UI
  → confirm() dialog
  → POST /api/kill { name }
  → web.handleKill
  → screenManager.gracefulKill(name)
      → respawn disabled
      → tmux send-keys C-c
      → wait 300ms
      → tmux send-keys /exit Enter
      → poll tmux has-session (up to 3s)
      → if still alive: tmux kill-session (fallback)
      → remove from managed map
  → 200 OK
  → session-registry emits disconnect on MCP pipe close
  → WebSocket broadcasts updated session list
  → web UI re-renders without the closed session
```

## Error Handling

- Any individual `tmux` call failure is caught and logged; later steps still run. The fallback kill ensures tmux is gone even if earlier steps fail.
- If `gracefulKill` is called for a name that isn't in the `managed` map, it returns silently (consistent with current `kill`).
- If `screenManager` is missing on the web frontend deps (`/api/kill` without a screen manager), returns `503` as today.
- Web UI: `fetch` failures are logged to console. The button does not disable itself on click — the user can retry. Confirmation dialog prevents accidental double-clicks.

## Testing

Add tests to `tests/screen-manager.test.ts`:

1. **Graceful success path:** Mock `$` so `tmux has-session` starts failing after the `/exit` send. Call `gracefulKill('foo')` on a managed session. Assert:
   - Command sequence includes `send-keys C-c`, `send-keys /exit Enter`, and at least one `has-session` poll.
   - No fallback `kill-session` was issued.
   - Entry removed from `managed`.
   - Respawn timer cleared.

2. **Graceful timeout path:** Mock `$` so `tmux has-session` keeps succeeding. Call `gracefulKill('foo')`. Assert:
   - After the timeout, `tmux kill-session -t operant-foo` was issued.
   - Entry removed from `managed`.

3. **No-op on unknown name:** Call `gracefulKill('does-not-exist')`. Assert: no `tmux` commands issued, no throw.

4. **Existing `kill()` tests remain unchanged** — confirming `killAll()` / daemon shutdown still uses the hard path.

No new tests needed for `web.ts`, `telegram.ts`, or `cli.ts` — they delegate to `screenManager` which is already covered.

## Constraints & Notes

- Claude Code must accept `/exit` at its prompt. If Claude's prompt conventions change in the future, the fallback kill ensures the operation still completes.
- Total user-visible latency on the close action: up to ~3.3 seconds in the worst case (cancel delay + graceful timeout). This is acceptable for a user-initiated action with a confirmation dialog.
- Telegram `/kill` will now take up to ~3 seconds longer. Acceptable for consistency with the web UI.
