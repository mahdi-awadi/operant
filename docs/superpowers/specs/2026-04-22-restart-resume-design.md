# Restart-with-Resume Design

**Status:** Draft
**Date:** 2026-04-22
**Scope:** Web dashboard + daemon + shim

## Problem

Clicking the `↻` button on a disconnected session in the web dashboard spawns a fresh Claude process with no memory of the prior conversation. Users almost always want to pick up where they left off, not start over. There is currently no way to resume a past conversation from the operant UI.

`claude` CLI supports this natively:

| Flag | Effect |
|---|---|
| `--continue` / `-c` | Resume the most recent conversation in the current directory |
| `--resume <id>` / `-r <id>` | Resume a specific session by its ID |
| *(no flag)* | Start a new conversation |

Claude stores conversations as `~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl`.

## Goals

1. Clicking `↻` opens a small popover with two choices: **Resume** and **New**.
2. **Resume** lists prior sessions for this project (most recent first) and lets the user pick one. Default selection is the most recent.
3. **New** keeps the current behavior (fresh session).
4. Gracefully handle the no-prior-sessions case.
5. Disconnected sessions only — do not expose on live sessions.

## Non-goals

- Restart button on **active** sessions (kill + resume). Can be added later.
- Showing session contents in a preview pane. First-user-message + timestamp is enough.
- Cross-project resume (resuming a session from a different cwd).
- Validating that a session is resumable before spawning. If `claude --continue` fails on a corrupt session, Claude shows the error in the tmux pane; user clicks `↻` again and picks a different one.

## UX

### Popover anatomy

Clicking `↻` on a disconnected session row opens a popover anchored to the button:

```
┌─ Restart ─────────────────────────────┐
│  🔄  Resume                           │
│      ● "add multi theme dark/light…"  │  2h ago
│        "fix webhook HMAC sanitize…"   │  1d ago
│        "wire up screen mgr respawn…"  │  3d ago
│        …up to 10 sessions             │
│                                       │
│  ✨  New                              │
└───────────────────────────────────────┘
```

### Interaction rules

- **Default focus:** the first (most recent) session under Resume is pre-selected.
- **Enter** = activate selected row. With default focus this means "resume last conversation" in one key.
- **Arrow keys** navigate between Resume items and the `New` row.
- **Escape** closes the popover.
- **Click outside** closes the popover.
- Each Resume row shows: first user message (truncated ~60 chars) + relative timestamp (`2h ago`, `yesterday`, `Mar 14`).
- If a row has no user messages (shouldn't happen, but possible for aborted sessions), show `(no messages)`.

### Empty / error states

| State | Popover contents |
|---|---|
| No prior sessions | Resume section hidden; only `New` shown. Default focus on `New`. |
| API error fetching prior list | Resume shows `⚠️ Could not load prior sessions` (disabled); `New` still works. |
| Prior list empty for another reason | Same as "No prior sessions". |

### Visual

Reuse existing CSS variables (`--sidebar`, `--border`, `--accent`, `--text`, `--text-muted`). No new theming. Popover styled as a floating card with subtle shadow, 280px wide min, positioned to the right of the `↻` button with viewport-edge correction (if it would overflow off-screen, flip to the left).

## Backend

### New endpoint

```
GET /api/sessions/:name/prior
→ 200 { sessions: [{ id, firstUserMessage, mtime }, …] }
→ 401 if not authenticated (same cookie auth as other /api routes)
→ 404 if :name is not a known session
```

Behavior:

1. Look up the session in the registry to get its `projectPath`.
2. Compute the Claude storage directory: `~/.claude/projects/` + `projectPath.replace(/\//g, '-')`.
3. `readdir` the directory; filter to `*.jsonl`.
4. For each file, `stat` for `mtime` and read only the first ~4KB to extract:
   - `firstUserMessage` — find the first JSONL line with `type === "user"` or `role === "user"`, extract its text content (truncate to 120 chars for payload size).
5. Sort by `mtime desc`, cap at 10 entries.
6. `id` is the filename without `.jsonl`.

**Path safety:** The computed storage directory must resolve under `~/.claude/projects/`. If `projectPath` escapes via `..` or an absolute trick, return `404`. The session registry already stores sanitized paths, but double-validate to defend against future regressions.

**Concurrency:** The directory may be written to by a running `claude`. Ignore read errors on individual files (a file being truncated mid-read) — skip that entry, continue.

### Modified endpoint

`POST /api/spawn` gains an optional field:

```ts
{
  name: string
  path: string
  instructions?: string
  profile?: string
  resume?: "continue" | { sessionId: string }  // new
}
```

- `resume: "continue"` → spawn uses `claude --continue …`
- `resume: { sessionId }` → spawn uses `claude --resume <id> …`
- `resume` omitted → current behavior (`claude …` with no flag)

### ScreenManager

`spawn()` signature gains the new parameter:

```ts
async spawn(
  name: string,
  projectPath: string,
  instructions?: string,
  profileName?: string,
  resume?: { mode: "continue" } | { mode: "session", id: string }
): Promise<void>
```

Command construction:

```ts
const FLAG =
  resume?.mode === "continue" ? "--continue " :
  resume?.mode === "session" ? `--resume ${shellQuote(resume.id)} ` :
  ""
const CMD = `claude ${FLAG}--dangerously-load-development-channels server:operant`
```

`shellQuote` must reject session IDs that don't match `/^[0-9a-f-]{8,64}$/i` — Claude uses UUIDs, so anything else is rejected upstream with `400`.

**Auto-respawn interaction:** The `respawnEnabled` path in `scheduleRespawn()` currently re-invokes `spawn(name, projectPath)` with no resume flag. Leave that alone — auto-respawn is for crash recovery and should not silently resume an old conversation. Only explicit user action via the restart UI uses `--continue` / `--resume`.

## Frontend

### Files to change

- `src/frontends/web-client.html` — replace the existing `restartSession()` fetch with a popover UI and helpers.

### New functions

- `openRestartPopover(sessionName, projectPath, anchorEl)` — builds and shows the popover, fetches prior list, manages keyboard nav, closes on blur/escape.
- `loadPriorSessions(sessionName)` — calls `GET /api/sessions/:name/prior`, returns the list.
- `spawnResume(sessionName, projectPath, resume)` — posts to `/api/spawn` with the `resume` field.
- `formatRelativeTime(mtime)` — `2h ago` / `yesterday` / `Mar 14`.

### Wiring

The existing restart button click handler (`src/frontends/web-client.html:512`) changes from:

```js
restartBtn.onclick = (e) => { e.stopPropagation(); restartSession(s.name, s.path) }
```

to:

```js
restartBtn.onclick = (e) => { e.stopPropagation(); openRestartPopover(s.name, s.path, restartBtn) }
```

The old `restartSession()` function is removed; its POST-to-/api/spawn logic lives inside `spawnResume()`.

## Testing

### tests/screen-manager.test.ts (new cases)

- `spawn(name, path)` → tmux command contains `claude --dangerously-load-development-channels`, no `--continue`, no `--resume`.
- `spawn(name, path, undefined, undefined, { mode: "continue" })` → tmux command contains `claude --continue --dangerously-load-development-channels`.
- `spawn(name, path, undefined, undefined, { mode: "session", id: "abc-123-…" })` → tmux command contains `claude --resume abc-123-… --dangerously-load-development-channels`.
- Invalid session ID (`../etc/passwd`, empty string, non-hex chars) → throws before invoking tmux.

These assert on the command string; we don't actually spawn tmux in tests (mock `$` / use a fake executor).

### tests/frontends/web-auth.test.ts (new cases)

- `GET /api/sessions/:name/prior` without auth → `401`.
- `GET /api/sessions/:name/prior` with auth for nonexistent session → `404`.
- `POST /api/spawn` with `resume: { sessionId: "../../etc/passwd" }` → `400`, no tmux invocation.
- `POST /api/spawn` with `resume: "continue"` → invokes `ScreenManager.spawn` with matching resume param (use a spy).
- `GET /api/sessions/:name/prior` correctly resolves the storage path for cwds containing dashes and dots (verify the encoding matches Claude's convention).

### Frontend popover behavior

The existing test suite has no DOM harness (no JSDOM, no `happy-dom`). Rather than add one for this single feature, the popover behavior is verified by:

1. **Unit-level** — extract `formatRelativeTime()` and any pure helpers into testable functions covered by a small `tests/frontends/web-client-helpers.test.ts`.
2. **Manual smoke** — see Verification section below. Any future DOM test infra can backfill popover coverage.

## Verification

Manual smoke test on the running daemon:

1. Spawn a session, send a few messages, kill it (so it's disconnected).
2. Click `↻` → popover opens, Resume lists at least 1 session with correct first-message preview.
3. Press Enter → new tmux spawns, `ps` shows `claude --continue …`, conversation history is visible in the tmux pane.
4. Repeat, pick a non-default session from the list → `ps` shows `claude --resume <that-id> …`.
5. Click `↻` on a fresh folder with no prior sessions → Resume section hidden, only `New` visible.
6. Confirm no regression: `✕` (remove) still works, `[+]` teammate button unchanged.

## Risks

- **Corrupt / partial `.jsonl` files** — `claude --continue` fails with a parse error inside the tmux pane. Mitigation: no upfront validation; user re-opens popover and picks a different session.
- **Large project directories** (>100 prior sessions, >100MB total) — capped at 10 entries, we only read first 4KB of each file. Should be fast even on many sessions.
- **Renamed sessions** — Claude's `--name` flag doesn't change the filename (session ID stays the same). If we want to show user-set display names, we'd need to parse them out of the JSONL metadata. **Out of scope** — timestamp + first message is enough for v1.
- **Session lock** — if a different `claude` process currently holds the session (user ran `claude --continue` manually in another terminal), spawning ours will collide. Claude's behavior: the second instance errors out on startup. Mitigation: none for v1 — error is visible in the tmux pane.

## Out of scope / future work

- Live-session restart (kill + resume in one action).
- Remembering a user's last `resume` choice per session (auto-pick next time).
- Showing session display names (from `--name` flag) in the picker.
- Restart from Telegram (`/restart <name>` with optional `--resume`). Can be a follow-up once the core web flow is solid.
