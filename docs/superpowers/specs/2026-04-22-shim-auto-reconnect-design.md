# Shim Auto-Reconnect

**Status:** Draft
**Date:** 2026-04-22
**Owner:** Mahdi

## Problem

When the operant daemon restarts (manually, after a crash, after a config change), every Claude session connected through the MCP shim shows up as **red / disconnected** in the web dashboard and the Telegram `/list`. Sessions never recover on their own.

Today the shim (`src/shim.ts:265-274`) treats any disconnect as terminal:

```ts
daemon.on('error', () => process.exit(1))
daemon.on('close', () => process.exit(0))
```

In theory Claude Code's MCP host should respawn the dead shim, and a fresh shim would connect to the new daemon. In practice we observe shims that lose their socket but never exit (Apr 22: PIDs 60709, 1149225, 4024331 all sitting with no daemon socket fd, holding their MCP transports open). Once stuck, the only fix is killing the shim manually or restarting the Claude session.

## Goal

A daemon restart should be invisible to the end user. Within a few seconds of the daemon coming back up, every previously-connected session re-registers and the dashboard goes green again — no clicks, no Claude restarts, no manual `kill`.

## Non-goals

- Replaying tool calls that were in flight when the daemon dropped. Claude can decide whether to retry — the shim just surfaces an error result.
- Preserving permission_request prompts across a disconnect. They get dropped; Claude re-issues if still needed.
- Surviving Claude itself crashing. Out of scope — Claude's own respawn handles that.
- Changing the daemon. Slot reuse on re-register already works (per CLAUDE.md "Reconnect reuses slots").

## Design

Single-file change: `src/shim.ts`. No daemon changes, no UI changes.

### Reconnect loop

Treat the socket as a connection to be re-established, not a fail-fast dependency.

- On `daemon.on('close')` or `daemon.on('error')`: schedule a reconnect instead of `process.exit()`.
- Backoff sequence (ms): `1000, 2000, 4000, 8000, 16000, 30000, 30000, …` — capped at 30s, never gives up. This guarantees no tight loop even if the daemon stays down for hours.
- On successful `connect`: reset backoff to the first step and re-send `{ type: 'register', cwd }`. The daemon's existing path:index slot-reuse logic recognises the same `cwd`, reclaims the previous slot, and restores name/trust/profile.
- On every retry attempt, log to stderr so the tmux pane shows what's happening:
  - `operant shim: daemon disconnected, reconnecting in 4s…`
  - `operant shim: reconnected, re-registering as "<name>"`

Intentional shutdowns still exit cleanly:
- `SIGTERM`, `SIGINT`, and `process.stdin.on('end')` call `daemon.end()` then `process.exit(0)`. Reconnect is suppressed when shutdown is in progress.

### In-flight request handling during disconnect

A `tool_call` is request/response over the same socket. When the socket closes mid-flight:

- Pending `tool_call` promises resolve with `buildMcpToolResult('operant disconnected, retry', true)`. Claude sees a tool error and can decide to retry the call once the next channel message arrives.
- Pending `permission_request` notifications are dropped silently. Claude will re-emit `notifications/claude/channel/permission_request` if the underlying tool call is still alive when the socket comes back.

A small `pendingToolCalls: Set<{ name, resolve }>` lets the close handler reject everything currently waiting before scheduling the reconnect.

### State that survives a reconnect

- `cwd` — captured once at startup, re-sent on every register.
- The MCP server itself — never torn down. The transport between Claude and the shim stays up the whole time.
- The session's name/trust/prefix/uploadDir — owned by the daemon, restored automatically on re-register.

### State that doesn't survive

- The `daemonBuffer` accumulator — reset on each new socket.
- The `registered` flag — flipped back to false on disconnect, flipped true again when the daemon returns `{ type: 'registered' }`.

## One-off cleanup

Existing zombie shims won't pick up the new code. After deploying:

```bash
kill 60709 1149225 4024331
```

Claude's MCP host respawns each one, the new shim with reconnect logic connects to the running daemon, and the dashboard goes green.

## Testing

New file `tests/shim-reconnect.test.ts`:

1. **Reconnects after daemon restart.** Start a fake Unix socket server. Spawn the shim pointed at it via `OPERANT_SOCKET=`. Wait for `register`. Close the server, restart it on the same path. Assert the shim re-registers within 5s.
2. **Rejects pending tool calls on disconnect.** Send a tool call from a fake MCP transport, kill the socket before the daemon responds, assert the MCP transport receives an error result with text `operant disconnected, retry`.
3. **Backoff caps at 30s.** Mock the timer, force ten consecutive disconnects, assert the schedule matches `[1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]`.
4. **Clean shutdown suppresses reconnect.** Send `SIGTERM`, assert no further connect attempts after the socket closes.

The existing test suite must keep passing — `bun test`.

## Risks

- **Daemon never comes back.** Shim retries every 30s forever, ~3 syscalls per attempt. Negligible. Worst observable symptom is a stale stderr line every 30s in the tmux pane.
- **Old daemon binary serving a new shim.** The register message format hasn't changed; backwards compatible.
- **Cwd changed since first connect.** Won't happen — `cwd` is captured at process start and shims don't `chdir`.

## Out of scope (parking lot)

- Surfacing reconnect state in the dashboard ("Reconnecting…" pill instead of red dot).
- A `/api/refresh` endpoint that nudges stuck shims. Not needed once auto-reconnect ships, but could be useful as an escape hatch later.
- Persistence of in-flight tool calls across a daemon restart — would require the daemon to checkpoint pending calls; large change for a small recovery benefit.
