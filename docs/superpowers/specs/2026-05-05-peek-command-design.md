# /peek — Tmux Pane Capture Command

**Date:** 2026-05-05
**Status:** Approved

## Problem

The operant frontends (Telegram and Web) only see what flows through the MCP channel — Claude's actual terminal UI (slash commands, Ink overlays, autopilot output, /btw responses, error banners) is invisible. The user needs a way to peek at the live tmux pane from any frontend.

## Solution

Add a /peek operation that runs `tmux capture-pane` against a operant session and returns the captured text.

### Surface per frontend

- **Telegram:** chat command `/peek [name] [lines]`. With no name, uses the per-user active session. Default 80 lines, max 500.
- **Web:** button in the chat header (next to the existing "tmux attach" copy chip). Click fetches `GET /api/peek/<name>?lines=80` and shows the captured pane in a modal `<pre>` block.

### Backend

New helper on `ScreenManager`:

```ts
capturePaneWithScrollback(sessionName: string, lines: number): Promise<string>
```

Why a new method: the existing `capturePane` is intentionally limited to the visible pane only (autopilot relies on this — see line 316–328 comment). /peek must include scrollback so the user can see Claude's recent terminal output, not just the prompt frame.

Implementation: `tmux capture-pane -t <name> -p -S -<lines>`.

### Output truncation

Telegram message limit is 4096 chars. Truncate captured text to ~3500 chars from the tail (most recent). Web has no message limit but caps at 500 lines for display sanity.

### Errors

- `/peek` (no name) + no active session → "No active session. Use /list."
- `/peek <name>` + no tmux session named `operant-<name>` → "No tmux session for <name>."
- Any tmux error → "Could not capture pane: <err>"

### Auth

- Telegram: same allowlist as other commands (existing middleware).
- Web: Telegram-login session required (existing middleware); the `/api/peek` route checks session before invoking ScreenManager.

## Files

- `src/screen-manager.ts` — add `capturePaneWithScrollback`.
- `src/frontends/telegram.ts` — register `/peek` command.
- `src/frontends/web.ts` — add `GET /api/peek/:name`.
- `src/frontends/web-client.html` — add Peek button + modal.
- `tests/screen-manager.test.ts` (new) or extend existing tests — cover the helper.
- `tests/frontends/telegram.test.ts` — `/peek` command parsing.
- `tests/frontends/web.test.ts` — `/api/peek` route.

## Out of scope

- CLI subcommand (user explicitly excluded).
- Live streaming / refresh — single-shot snapshot only.
- ANSI color preservation — strip escape codes before display.
