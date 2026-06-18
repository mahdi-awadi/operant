# Autopilot Mode — Proxy-Answer Design

**Status:** Draft
**Date:** 2026-04-24
**Author:** Mahdi (with Claude, brainstorming via operant session)

## Goal

Let a operant session run unattended. When the main Claude asks the user a decision question ("Option A or Option B?"), an in-process AI proxy picks the answer on the user's behalf — based on the session's own conversation context — and delivers it back to the main session through the existing MCP channel pipe. The user is only pinged for decisions that are irreversible, out of scope, or explicitly escalated.

The user keeps a subscription-funded loop running end-to-end without being in the chair.

## Why this design

The main session has already accumulated the richest possible understanding of the project — it has read files, made edits, run tests, and conversed about trade-offs. Any external proxy (a separate delegate session or Anthropic SDK call) has to rebuild that context from scratch.

Claude Code ships a built-in primitive that exactly matches the job: `/btw`. It is an in-process, single-turn, tool-less forked API call that reuses the current session's conversation messages (`forkContextMessages`) without mutating history or cache. It is the right brain for the job.

The gap: `/btw` has no documented programmatic trigger in Claude Code today — it is strictly a user-typed slash command. End-to-end testing (see Appendix A) confirmed that `tmux send-keys "/btw <q>" Enter` reliably fires the command, and `tmux capture-pane -p` reliably captures the answer from the Ink overlay. That gives us a working programmatic trigger without adding a subprocess, an API key, or a second Claude instance.

## User experience

### Enabling autopilot on a session

- Telegram: `/autopilot <name> on` (off by default)
- Web UI: toggle in the session row (new icon: 🤖)
- CLI: `bun run src/cli.ts autopilot <name> on`

Session list indicators:
- 🟢 working (human-in-loop) — current default
- 🤖 autopilot on — proxy is answering for the user
- 🟡 waiting on you — autopilot escalated a question to the user

### How it feels

Session is working. Claude sends a reply that ends with a question. The session goes idle waiting for input. Instead of pinging the user, the daemon fires `/btw <wrapped-question>` into the session's tmux pane, captures the answer, dismisses the overlay, and sends the parsed answer through the normal channel pipe back to the same session. From Claude's perspective, the user replied. Work continues.

The user sees a transcript entry in Web/Telegram:
> 🤖 **Proxy answered:** "Bun — that's what your project already uses."
>
> *(reply to: "Should I pick Node or Bun for this project?")*

### Escalation to human

The daemon falls back to pinging the user on Telegram/Web when:
- The proxy's answer starts with the literal token `ESCALATE` (the proxy was told to use this for irreversible/out-of-scope decisions)
- The session has autopilot on but the wrapped question matches a high-risk pattern (see Escalation policy below)
- The `/btw` call times out, the overlay fails to parse, or tmux capture fails twice in a row
- The session has been in autopilot for longer than `autopilot.maxDurationMinutes` without a human checkpoint

When escalated, the session's badge flips to 🟡 and a standard operant message prompt is sent to the user. The user's answer flows through the existing pipe unchanged.

### Veto window (optional, on by default)

When the proxy drafts an answer, the daemon can optionally show it to the user on Telegram/Web with buttons — ✅ Send / ✏️ Edit / ❌ I'll answer — for `autopilot.vetoWindowMs` (default 30000). If the user does nothing, the proxy's answer is sent after the window. Setting `vetoWindowMs: 0` makes autopilot fully hands-off.

## Architecture

### The proxy mechanism — `/btw` via tmux

```
Main session (running Claude Code in tmux)
  │
  │ Claude sends a reply that ends with a decision question;
  │ Claude Code's input box goes idle.
  │
  ▼
Daemon autopilot watcher (new)
  │ sees: session.autopilot === "on" && sessionIsIdle && lastOutgoingWasToUser
  │
  ▼
Daemon fires programmatic /btw:
  tmux send-keys -t <session> "/btw <wrapped question>" Enter
  │
  ▼
Claude Code processes /btw in-process:
  - forkContextMessages = current conversation
  - maxTurns = 1
  - tools denied
  - skipCacheWrite = true
  - result rendered in Ink overlay
  │
  ▼
Daemon polls tmux capture-pane until:
  - no "Hatching…/Crunching…/esc to interrupt" spinner
  - footer "↑/↓ to scroll · f to fork · Esc to dismiss" present
  │
  ▼
Daemon parses the answer out of the overlay
  (4-space-indented lines between the echoed question and the footer)
  │
  ▼
Daemon: tmux send-keys -t <session> Escape   (dismiss overlay)
  │
  ▼
Daemon routes the answer through the existing pipe:
  socketServer.sendToSession(path, { type: "channel_message", content, meta: { source: "autopilot" } })
  │
  ▼
Shim emits notifications/claude/channel → main Claude reads as user reply → work continues
```

### The wrapped question

The daemon wraps the raw question before firing `/btw`:

```
You are acting as the user's delegate for this autopilot session.
Answer the following question as the user would, using this project's
conversation context, CLAUDE.md, and (if present) autopilot.md preferences.

Constraints:
- Be decisive. Pick one option. One sentence is ideal, one short paragraph max.
- If the choice is irreversible (delete data, force push, prod deploy, add a
  paid service, change billing, remove auth), reply EXACTLY:
  ESCALATE: <one-sentence reason>
- If the choice is outside the project's scope, same: ESCALATE: <reason>
- Do not propose a third option the user did not offer unless doing so is
  obviously safer than A or B.
- Answer as the user, not about the user. No preamble. No "Based on...".

Question from Claude:
<the actual last outgoing message from the session>
```

This prompt is appended to `/btw` as the question argument. `/btw` itself still has no tool access and still runs single-turn — we are just shaping the one answer it produces.

### Where context for the proxy comes from (free)

Because `/btw` uses the main session's own conversation, the proxy automatically has:
- Everything Claude read, edited, ran
- The recent decisions made in this session
- The original task brief
- Any `CLAUDE.md` or skill content that's already in the system prompt / conversation

Plus we optionally feed (by inclusion in the wrapped question if the file exists):
- `./autopilot.md` in the project root — user-written preferences for this project
- `~/.claude/autopilot.md` — global fallback

Both files are plain markdown. Example contents:

```markdown
# Preferences for autopilot

- Prefer Bun over Node
- Prefer minimal dependencies; avoid adding new ones unless unavoidable
- Always TDD: test first, then implement
- Prefer explicit over clever
- For UI decisions, pick the simpler/more-accessible option
- Never add analytics/tracking without asking
```

No schema — freeform markdown the proxy reads as context.

## Components and changes

Listed in file-ownership order so an implementer can split work.

### New: `src/autopilot.ts`

Module owns:
- Per-session autopilot state (`on` / `off`, `vetoWindowMs`, `maxDurationMinutes`, counters)
- Idle-watcher: subscribes to session state changes, detects "question asked, awaiting user"
- `/btw` firing: `tmux send-keys` with retry-on-no-footer
- Overlay parser: extracts the indented answer block between the echoed question and the footer; tolerates ANSI codes, multi-line answers, and the `/btw` history list
- Timeout / failure → escalate
- ESCALATE keyword detection → escalate

### Changed: `src/screen-manager.ts`

- Add `sendKeysRaw(sessionName, text)` and `capturePane(sessionName, lines)` helpers so `autopilot.ts` does not re-implement tmux calls
- Mirror existing pattern (already uses `tmux send-keys` for Enter-confirm and kill paths)

### Changed: `src/session-registry.ts`

- Add `autopilot?: { enabled: boolean; vetoWindowMs: number; maxDurationMinutes: number; startedAt?: number }` to session record
- Persist through restart (existing `sessions.json` path)

### Changed: `src/permission-engine.ts`

- Autopilot implies `trust: auto-approve` for the duration (no permission prompts interrupt the loop)
- When autopilot is turned off, revert to the session's prior trust mode

### Changed: `src/message-router.ts`

- Accept `meta.source = "autopilot"` on inbound messages; carry it through so frontends can render the 🤖 badge

### Changed: `src/frontends/telegram.ts`

- `/autopilot <name> on|off` command
- `/autopilot <name> veto <ms>` command
- Render 🤖 badge in `/list` and `/status`
- Veto-window message with inline buttons: ✅ Send / ✏️ Edit / ❌ I'll answer

### Changed: `src/frontends/web.ts` + `src/frontends/web-client.html`

- Per-session autopilot toggle in the session row
- Badge state in the session list
- Veto-window card in the chat view with the same three buttons

### Changed: `src/cli.ts`

- `autopilot <name> on|off|veto-ms <n>` command parity with Telegram

### Changed: `src/daemon.ts`

- Wire `autopilot.ts` into startup; pass screenManager, sessionRegistry, messageRouter, socketServer

### New: `tests/autopilot.test.ts`

Covered scenarios:
- Overlay parser correctly extracts single-line answers
- Overlay parser correctly extracts multi-line answers
- Spinner-present → keep polling; spinner-absent + footer-present → parse
- ESCALATE token is detected (case-insensitive, leading or solo)
- Veto window fires auto-send at expiry
- Veto window is preempted by user action (Send / Edit / Cancel)
- Autopilot toggle off mid-operation aborts the pending /btw cleanly

## Escalation policy

A question is escalated to the human user if any of:

1. **Explicit ESCALATE** — proxy's answer starts with `ESCALATE` (case-insensitive). The reason is forwarded to the user.
2. **Pre-firing risk filter** — Claude's outgoing question (before wrapping) matches any risk keyword from `autopilot.riskKeywords`: default `delete`, `force push`, `drop table`, `production`, `prod deploy`, `billing`, `credit card`, `api key`, `secret`, `revoke`, `uninstall`. Matching is case-insensitive, substring. Conservative by design; errs toward escalation. Opt-out via per-session `autopilot.riskOverride: true` (not recommended).
3. **Parse or tmux failure** — the daemon was unable to extract an answer after 2 retries (each retry: re-fire /btw, re-parse).
4. **Timeout** — /btw overlay did not finish rendering within `autopilot.btwTimeoutMs` (default 30s).
5. **Session duration cap** — autopilot has been running on this session for more than `autopilot.maxDurationMinutes` without a human checkpoint (default 60 minutes). Prompts the user: "This session has been on autopilot for 60 min. Continue for another 60 min, or take over?"

## Configuration

### Operant-level defaults in `~/.claude/channels/operant/config.json`

```json
{
  "autopilot": {
    "defaultEnabled": false,
    "vetoWindowMs": 30000,
    "btwTimeoutMs": 30000,
    "maxDurationMinutes": 60,
    "riskKeywords": ["delete", "force push", "drop table", "production", "prod deploy", "billing", "credit card", "api key", "secret", "revoke", "uninstall"]
  }
}
```

Users can override `riskKeywords` globally.

### Per-session overrides

Stored in `sessions.json`, editable via CLI/Telegram/Web:
```json
{
  "path:index": {
    ...existing fields,
    "autopilot": {
      "enabled": true,
      "vetoWindowMs": 0,
      "maxDurationMinutes": 120
    }
  }
}
```

### Per-project preferences

Freeform `./autopilot.md` in the project root; optional `~/.claude/autopilot.md` fallback. Content is included verbatim in the wrapped question.

## Edge cases and gotchas

- **/btw history accumulates** in the overlay. After every N proxy calls, send the overlay shortcut `x` (clear history) to keep parsing predictable. Alternative: parse only the bottom-most answer block regardless of history length. Pick the simpler one (bottom-most parse).
- **Send-keys timing** — during auto-memory setup, the first Enter may be swallowed. Retry-on-no-footer-after-2s covers this.
- **Feature flag** — `/btw` is gated behind `tengu_marble_whisper2` in Claude Code. If the flag is off for the user's Claude Code install, autopilot should detect (fire a test `/btw 1+1` on enable and expect `2` in the overlay within 15s) and refuse to enable with a clear error.
- **Multiple sessions per project** — each session has its own autopilot toggle. Team-lead + teammates can run autopilot independently.
- **Session-lifecycle edge cases** — if the session is killed/respawned mid-/btw, the daemon cancels the pending proxy call. If autopilot is toggled off mid-call, the overlay is dismissed with Esc and the pending answer is dropped.
- **Agent-team teammates** — these are filtered out of the operant registry today (`shim.ts` checks `--agent-id` in parent process cmdline). Autopilot only applies to user-spawned sessions; teammates are unaffected.
- **Terminal session with no tmux** — if the main session is not running inside tmux (future case), autopilot is unavailable for that session. Web UI disables the toggle with a tooltip.
- **The captured answer goes back as a user turn, not a /btw** — main Claude sees it as if the user typed it. This is fine: the wrapped question already shaped the proxy to answer as the user would.

## Non-goals (out of scope for this spec)

- Training or fine-tuning a dedicated proxy model
- A delegate session or second Claude process — the point of this design is to avoid that
- Anthropic API direct calls — the point of this design is to avoid needing an API key
- Autopilot across sessions (cross-project consistency) — each session is independent
- Automatic approval of irreversible actions — always escalate
- Proxy-driven code changes — the proxy never writes code directly. Its only power is answering a question as text. The main session does the work.
- Learning from overrides — v1 does not adapt. If the user vetoes or overrides, the preference should be written manually into `autopilot.md`. Automatic preference mining is a later concern.

## Open questions / follow-ups

- **Anthropic feature request:** file an issue on the Claude Code repo asking for a programmatic `/btw` trigger (MCP method or hook event). When it lands, swap the `tmux send-keys` fire for the native trigger — it is a 1-file change in `src/autopilot.ts`. The rest of the design is unaffected.
- **Overlay format stability:** current format is stable in Claude Code 2.1.119. If Anthropic changes the overlay format, the parser breaks. Add a regression test that pins on known-good fixtures, and a version-compat check at daemon startup.
- **Per-project autopilot.md templates:** ship a starter template at `skills/autopilot/SKILL.md` that users can copy into their project.

## Appendix A — Test transcript (2026-04-24)

Verification of the `tmux send-keys` + `/btw` + `capture-pane` pipeline using Claude Code 2.1.119, a fresh tmux session in `/tmp/btw-test`, not connected to the operant.

### Test 1 — plain /btw, no conversation context

```
$ tmux send-keys -t btw-test "/btw what is 2+2?" Enter
```

Captured overlay:
```
❯ /btw what is 2+2?

  /btw what is 2+2?

    4

  ↑/↓ to scroll · f to fork · Esc to dismiss
```

### Test 2 — /btw using prior conversation context

Prior turn: the session was told "my project uses Bun, I prefer concise answers, and I always use TDD."

```
$ tmux send-keys -t btw-test "/btw which runtime should I pick for this project — Node or Bun?" Enter
```

Captured overlay:
```
❯ /btw which runtime should I pick for this project — Node or Bun?

  /btw what is 2+2?
  /btw which runtime should I pick for this project — Node or Bun?

    Bun — that's what your project already uses.

  ↑/↓ to scroll · f to fork · x to clear history · Esc to dismiss
```

The proxy picked Bun because the session's context said so. This is the behavior autopilot relies on.

### Parse contract (confirmed by tests above)

```
❯ /btw <question>            ← echoed question
<blank line>
  /btw <history lines…>      ← prior /btw in this session
  /btw <current question>
<blank line>
    <ANSWER LINE(S)>          ← 4-space-indented answer (multi-line possible)
<blank line>
  ↑/↓ to scroll · f to fork [· x to clear history] · Esc to dismiss
```

Parser: find the footer line; walk backwards past the blank line; collect consecutive 4-space-indented lines until the next blank; strip indent and join.
