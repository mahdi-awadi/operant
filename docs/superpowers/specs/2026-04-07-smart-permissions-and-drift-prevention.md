# Phase 1: Smart Sessions — Design Spec

## Overview

Phase 1 is a coordinated set of features that make Claude Code sessions smarter, less interrupting, and harder to derail. Everything in this phase is built around one organizing concept: **profiles**.

A profile is a reusable bundle of session configuration: trust level, behavioral rules, runtime facts, reply style per frontend, and verification commands. When a user spawns a session they pick a profile, and the profile's fields become the session's starting config. Users can override individual fields later — the profile is a baseline, not a lock.

Profiles make it possible to define "how we work on production backend" once and apply it to every session a teammate spawns for that project. Without profiles, the same rules and facts would have to be re-typed for every session, which defeats the purpose of having them at all.

## Problems Solved

1. **Approval fatigue** — Operant currently forwards every tool permission prompt. Work halts for trivial things like `Read` or `Glob` that should be auto-allowed.

2. **Claude drift** — Claude loses focus on project rules during long sessions. `CLAUDE.md` is read once then forgotten. Reminders have to be manually re-stated.

3. **False "done" claims** — Claude writes code and says "done" without actually running tests. Users discover failures later.

4. **Mobile file blindness** — Claude replies with bare file paths ("spec saved to docs/...") which mobile users can't open. No formatting, no emoji, no inline content.

5. **Config sprawl** — Rules, facts, trust levels, and verification commands have to be reconfigured for every new session, often from scratch.

## Architectural Principle: Deterministic First, Sidecar Rarely

Operant does classification and drift detection with **deterministic code** (static maps, regex, subprocess calls) — never with an LLM in the critical path. The user's Claude subscription has rate limits, and running an LLM on every permission check or every Claude reply would burn through them in a few hours of normal use.

A separate sidecar process can be added later as an **optional helper** for specific high-value tasks that run infrequently:

- Summarizing long verification output (only on failure, only if opt-in)
- Manual user-triggered commands like `/ask-claude summarize this session`

Sidecar is **off by default**. Profiles that want it set `sidecarEnabled: true`. Daemon tracks sidecar token usage per day so users can see the cost.

| Role | Implementation | When used |
|------|---------------|-----------|
| **Main Claude** | Full Claude Code session over MCP channel | User's actual work — persistent, context-aware |
| **Deterministic engine** | Static maps, regex, subprocess, templated messages | All classification, drift detection, rule injection, corrections, verification |
| **Sidecar helper** | Separate subprocess | Opt-in, rare — long output summarization, manual commands |

### Why no sidecar in critical path

- **Latency**: a fresh sidecar process has cold-start and processing overhead. Putting it before every permission response would make the system feel broken.
- **Token cost**: At ~550 tokens per drift check × 20 replies/hour × 10 sessions = 110k tokens/hour. That's a rate-limit-exceeding amount for any serious use.
- **Reliability**: Regex and static lists are predictable. LLM output varies, has edge cases, can be wrong.
- **Correctness without it**: Regex + "escalate on doubt" is safer than LLM classification, because uncertain cases go to the user rather than being auto-allowed.

### Token budget estimate (revised approach)

| Source | Daily cost |
|--------|-----------|
| Rules/facts injection (main Claude, already in context) | 0 additional |
| Permission classification | 0 (regex only) |
| Drift detection | 0 (regex only) |
| Verification runner | 0 (subprocess) |
| Auto-fetch file content | 0 (filesystem) |
| Sidecar summarization (opt-in, rare) | ~1500 tokens × ~5 calls/day = **~7k tokens/day** |

**Total Phase 1 overhead: < 10k tokens/day, well within rate limits.**

## Feature 1: Profile System (foundation)

### Profile Structure

```typescript
type Profile = {
  name: string                    // "prod-backend", "dev-frontend"
  description?: string
  trust: TrustLevel               // strict | ask | auto | yolo
  rules: string[]                 // behavioral constraints
  facts: string[]                 // runtime context
  prefix: string                  // free-form message prefix
  channelOverrides?: Partial<Record<FrontendSource, string>>
  driftDetection?: boolean        // default true — regex-only scan with user notification
  sidecarEnabled?: boolean        // default false — opt-in LLM summarization for rare cases
  verification?: {
    commands: string[]            // e.g., ["npm test", "npm run lint"]
    sentinelPhrase?: string       // Claude must emit this to trigger verification, default "✅ COMPLETE"
    timeoutSec?: number           // default 120
  }
}
```

### Storage

Profiles are stored globally in `~/.claude/channels/hub/profiles.json` (one file, array of profiles). Sessions reference the applied profile name but hold their own copy of the fields — so deleting or editing a profile doesn't break running sessions. Propagating edits is a separate concern for a future phase.

### Built-in Profiles

Ship with four battle-tested profiles users can pick immediately:

**`careful`** — production work
- trust: `strict`
- rules: "no shortcuts, no hacks, always test before claiming done, no force-push, no history rewrite, no deploys without approval"
- verification: auto-detected from project (npm test, cargo test, pytest)

**`tdd`** — test-driven development
- trust: `ask`
- rules: "write failing test first, never skip tests, never comment out tests, no implementation without a test"
- verification: required on every completion claim

**`docs`** — documentation work
- trust: `ask`
- rules: "use markdown with H2/H3 hierarchy, all code examples must be runnable, add TOC for docs over 500 words, no jargon without definition"

**`yolo`** — disposable experiments
- trust: `yolo`
- rules: []
- verification: disabled

### Commands

| Command | Description |
|---------|-------------|
| `/profiles` | List all profiles |
| `/profile <name>` | Show profile details |
| `/profile create <name>` | Create new profile (starts blank or from current session) |
| `/profile edit <name>` | Edit a profile (opens the web UI for structured editing) |
| `/profile delete <name>` | Delete a profile |
| `/profile export <name>` | Get JSON export of profile (for sharing) |
| `/profile import` | Import a profile from JSON (paste in reply) |

### Spawn integration

Web spawn dialog gains a profile dropdown. Telegram `/spawn` gains an optional `--profile <name>` flag. CLI `operant spawn` gains the same flag. No profile selected means "blank session with defaults", which is the current behavior.

### Sharing

Profiles export and import as JSON. Users share them via git, slack, or any text channel. A team lead defines `prod-backend` once, exports the JSON, teammates import it. Future enhancement: profile sync via git URL.

## Feature 2: Smart Permission Classification

Every permission request is classified into one of four categories:

| Category | Examples | Default Behavior |
|----------|----------|------------------|
| **Silent** | `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `TaskOutput`, `WebFetch`, `WebSearch` | Auto-allow instantly, not logged in timeline |
| **Logged** | `Edit`/`Write` within project, benign `Bash` (`ls`, `cat`, `npm test`, `git status`) | Auto-allow, recorded in activity log |
| **Review** | `Edit`/`Write` outside project, `Bash` with installs (`npm install`, `pip install`, `docker run`) | Auto-allow if trust=auto, else escalate |
| **Dangerous** | `Bash` with `rm -rf /`, `sudo`, `drop table`, `git push --force`, `chmod 777`, `curl \| sh` | Always escalate regardless of trust |

### Trust Levels

The session trust level (inherited from its profile) decides what happens to Logged and Review categories:

| Trust Level | Silent | Logged | Review | Dangerous |
|-------------|--------|--------|--------|-----------|
| `strict` | Allow | Escalate | Escalate | Escalate |
| `ask` (default) | Allow | Allow | Escalate | Escalate |
| `auto` | Allow | Allow | Allow | Escalate |
| `yolo` | Allow | Allow | Allow | Allow (with warning log) |

Backwards compatibility: existing `auto-approve` migrates to `auto` on first load.

### Classification Pipeline

Runs as a 2-layer deterministic pipeline. No LLM in the critical path:

1. **L1 — Static map** (~0.1ms): Known tool names map directly to a category. `Read` → Silent. `WebFetch` → Silent. `TodoWrite` → Silent. `Bash`/`Write`/`Edit` → L2.

2. **L2 — Regex rules** (~1ms): For `Bash`, `Write`, `Edit`, scan arguments against conservative patterns:
   - **Dangerous block-list** (explicit match → Dangerous):
     - `rm\s+(-[rRf]+\s+)?(/(?![^/]*\.)\w*|~|\$HOME)` (rm targeting system paths)
     - `sudo\s+(rm|dd|mkfs|chmod|chown)` (sudo with destructive commands)
     - `chmod\s+-R?\s+777`
     - `git\s+push\s+.*(-f|--force(-with-lease)?)`
     - `git\s+reset\s+--hard\s+(origin|HEAD~)`
     - `drop\s+(table|database|schema)`
     - `truncate\s+table`
     - `>\s*/dev/(sd|nvme|hd)`
     - `mkfs\.`
     - `dd\s+.*of=/dev/`
     - `curl.*\|\s*(bash|sh|zsh)`
     - `wget.*\|\s*(bash|sh|zsh)`
   - **Benign allow-list for plain `Bash`** (first token matches → Logged):
     - `ls`, `cat`, `echo`, `pwd`, `whoami`, `which`, `grep`, `find`, `head`, `tail`, `file`, `stat`, `wc`
     - `git status`, `git log`, `git diff`, `git branch`, `git show`
     - `npm test`, `npm run`, `cargo test`, `cargo check`, `pytest`, `go test`
   - **Write/Edit targeting in-project path** → Logged; outside project → Review.
   - **Everything else** → Review. No sidecar.

### Escalation on Uncertainty

Regex gaps are handled conservatively. Anything that doesn't match a known block or allow pattern falls into **Review**, which escalates to the user based on trust level. This is the safest default: the cost of over-asking is low (user clicks Allow), the cost of missing a dangerous command is high.

No cache is needed since classification is pure-function regex matching — running it again on the same input takes the same microseconds and produces the same result.

## Feature 3: Drift Prevention

### Injection Engine

On every outbound message from a user to a session, operant prepends three context blocks in order:

```
[Channel: {frontend-specific instructions}]
[Session Rules: {rules from profile + session overrides}]
[Facts: {facts from profile + session overrides}]

{original user message}
```

Claude sees all three blocks as part of the user's message and respects them.

### Channel Instructions (built-in defaults)

Claude Code doesn't know it's talking to a phone through Telegram or a browser through the web dashboard. Ship with per-frontend defaults:

**Telegram** (mobile-first):
> You are replying on Telegram mobile. Use markdown formatting, emoji prefixes (✅ ❌ ⚠️ 🔄 📝), bold for emphasis, and fenced code blocks. When you create, save, or reference a file (especially .md specs, configs, or new code files), paste the full file contents in your reply — mobile users cannot browse the filesystem. Keep replies concise but complete.

**Web**:
> You are replying on the web dashboard. Use markdown, code blocks, tables, and emoji. For files, show a summary or diff; long content is fine since the dashboard has scroll. Prefer structured output over walls of text.

**CLI**:
> You are replying via CLI. Plain text only, no markdown, no emoji. Keep output terminal-friendly and concise.

Profiles can override these via `channelOverrides` field.

### Auto-fetch Fallback

If Claude still emits bare file paths despite channel instructions, operant scans replies for "saved to:", "written to:", "spec saved:" patterns followed by a file path. If the file exists, is under 50KB, and has a safe extension (md, json, yaml, ts, js, py, go, rs, txt), operant sends a follow-up channel message with the content as a code block. One auto-fetch per reply maximum.

### Rules (behavioral constraints)

Rules come from the profile's `rules` array plus any session-level additions. Users add them via `/rules <session> <text>`. Rules are injected on every inbound message.

Example profile rules for `prod-backend`:
- "No shortcuts, no hacks, always root-cause bugs"
- "Never force-push or rewrite history on this branch"
- "Always run tests before claiming done"

### Facts (runtime context)

Facts differ from rules semantically — they're truths about the project, not behavioral constraints. Examples:
- "The database MCP is pointing at dev, not prod. Always check the schema first."
- "Bob owns the auth module. Don't touch src/auth/ without asking."
- "This branch is shared with the mobile team. No force-push."

Facts are injected on every inbound message alongside rules.

### Drift Detection (advisory only)

After every reply Claude sends back through the channel, operant runs a regex-only drift scan. **No LLM, no auto-correction into the session** — detection is advisory and goes to the user, not back into Claude.

**Regex anti-patterns** scan the reply for suspicious phrases:
- `\bquick\s+fix\b`, `\blet\s+me\s+just\b`, `\b(for|right)\s+now\b`, `\bI'?ll\s+(ignore|skip)\b`, `\bcommenting?\s+out\b`, `\bhack\b`, `\bTODO\b`, `\bFIXME\b`, `\bstub(bed)?\s+out\b`

**On match**:
- Operant sends a **notification to the user** (Telegram or web dashboard):
  > ⚠️ Possible drift in `awafi`: Claude's reply contains "quick fix". Your rule says "no shortcuts". [View reply] [Ignore] [Send correction]
- User decides whether to intervene
- User can click "Send correction" to push a templated reminder back into the session
- No auto-injection without user approval

**Why advisory not enforcing**: Auto-injecting corrections can trap Claude in feedback loops — Claude writes "for now", hub corrects, Claude writes "temporarily" in the next try, hub corrects again. The session becomes about rule compliance instead of work. User-in-the-loop avoids this.

**Correction template (when user clicks "Send correction")**:
> ⚠️ Project rule reminder: {rule}. Your last reply contained "{matched phrase}" — please re-do this without shortcuts, root-causing the issue instead.

Template is static — no LLM needed to generate it.

### Drift Rate Limiting

- Max 1 drift notification per 2 minutes per session (prevents notification spam)
- Notifications coalesce: if 3 anti-patterns match in one reply, user gets one notification with all three listed
- Users can disable drift detection per profile with `driftDetection: false`

## Feature 4: Verification Runner

Claude's habit of saying "done" without running tests is solved with deterministic subprocess verification defined in the profile.

### Trigger: Sentinel Phrase (not natural language)

Operant looks for an exact sentinel phrase in Claude's reply — not natural language. Default: `✅ COMPLETE`. Claude is told to emit this phrase via channel instructions only when work is genuinely done and ready for verification:

> *Channel instruction:* "When you have fully completed a task and want the hub to run verification commands, end your reply with `✅ COMPLETE` on its own line. Don't use this phrase casually — only when the work is ready to be validated."

This eliminates false positives from phrases like "I finished reading the file" or "once you're done." Only the exact sentinel triggers verification.

Profiles can override the sentinel via `verification.sentinelPhrase`.

### Execution

The runner executes profile commands sequentially in the session's project directory:

```bash
cd /home/user/project
npm test && npm run lint && npm run typecheck
```

Each command has a timeout (default 120s). Stdout and stderr are captured.

### Result Injection

**All pass:**
> ✅ **Verified done** — `npm test` passed (15 tests), lint clean, typecheck clean.

**Any fail:**
The failing output is sent back to the session as a channel message:
```
⚠️ Verification failed. You said done but:

$ npm test
FAIL src/auth.test.ts
  ✗ should reject expired tokens (12ms)
    Expected 401, received 200

Please fix and run verification again.
```

If the output is over 2000 chars, operant truncates it to the first and last 1000 chars with an ellipsis marker in between:

```
$ npm test
> jest

  src/auth.test.ts
    ✗ should reject expired tokens
...[truncated 3241 chars]...
      Expected 401, received 200

Test Suites: 2 failed, 5 passed
```

If the profile has `sidecarEnabled: true`, the full output is sent to sidecar Claude for a 1-sentence summary instead of truncation. This is the only place in Phase 1 where sidecar runs automatically, and only on failed verifications. Daily cost estimate: ~1500 tokens × a few failures/day = well under 10k tokens/day.

Claude sees the failure as a new user message and iterates. Verification runs again on the next completion claim.

### Proactive "no tests run" warning

Operant tracks whether Claude invoked Bash with a test command during the session. If Claude claims "done" without ever running a test, operant intervenes:
> ⚠️ You said done, but you haven't run any tests in this session. Running verification now...

### Project-type auto-detection (with probing)

When creating a profile, operant pre-populates `verification.commands` by **probing** what actually exists — not just matching filenames. Detection rules:

| Detected file | Probe | Commands added |
|---------------|-------|----------------|
| `package.json` | Read `scripts` field | Only scripts that exist: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` |
| `Cargo.toml` | None | `cargo check`, `cargo test`, `cargo clippy` (Cargo always has these) |
| `pyproject.toml` | `which pytest` + `which ruff` | Only installed tools |
| `go.mod` | None | `go build ./...`, `go test ./...` |
| `tsconfig.json` (without `package.json`) | None | `tsc --noEmit` |

Detection runs once at profile creation. User can edit the commands manually afterward. Never writes a command that won't run — avoids "verification failed because script doesn't exist" false failures.

## Storage

Change to `SessionConfig` — reference profile by name, store only overrides:

```typescript
export type TrustLevel = 'strict' | 'ask' | 'auto' | 'yolo'

export type SessionConfig = {
  // existing fields (unchanged)
  name: string
  uploadDir: string
  managed: boolean
  teamIndex: number
  teamSize: number

  // changed
  trust: TrustLevel              // was 'ask' | 'auto-approve'

  // NEW — profile linkage
  appliedProfile?: string        // name of profile this session was spawned with
  profileOverrides?: Partial<{   // fields that differ from the profile (if any)
    rules: string[]
    facts: string[]
    prefix: string
    channelOverrides: Partial<Record<FrontendSource, string>>
    driftDetection: boolean
    verification: { commands: string[]; sentinelPhrase?: string; timeoutSec?: number }
  }>
}
```

**Resolution**: When the daemon needs a session's effective config, it merges `profile + profileOverrides`. If the profile was deleted, the overrides still work as a last-known-good fallback.

**Files**:
- `~/.claude/channels/hub/profiles.json` — array of `Profile` objects
- `~/.claude/channels/hub/sessions.json` — session registry (existing, extended)

No caches persisted. Drift notification state (last-sent timestamps) is in-memory only.

## Module Layout

Consolidated to 4 new files (down from 6):

```
src/
  profiles.ts            # NEW — Profile type, load/save, apply/resolve, rules/facts/channel injection
  analysis.ts            # NEW — classifier (L1/L2 regex) + drift detector (regex) — pure functions
  verification.ts        # NEW — subprocess verification runner + project probing
  sidecar.ts             # NEW — optional sidecar helper, opt-in only
  permission-engine.ts   # EXTEND — use classifier, honor new trust levels
  message-router.ts      # EXTEND — inject context via profiles module
  session-registry.ts    # EXTEND — profile reference + overrides resolution
  daemon.ts              # EXTEND — wire drift detector, wire verification to sentinel phrase
  types.ts               # EXTEND — TrustLevel, Profile, extended SessionConfig
  frontends/telegram.ts  # EXTEND — /profile, /rules, /fact, /channel, /verify commands
  frontends/web.ts       # EXTEND — profile manager UI, drift notifications, activity log
```

`analysis.ts` holds **pure functions**: `classify(tool, args, projectPath) → Category` and `detectDrift(reply, rules) → DriftMatch[]`. No state, no LLM. Easy to unit-test exhaustively.

`sidecar.ts` is imported only by `verification.ts` for optional long-output summarization. If `sidecarEnabled: false` (default for all built-in profiles), the sidecar module is never invoked.

## User Interface

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/profiles` | List all profiles |
| `/profile <name>` | Show profile details |
| `/profile create <name>` | Create new profile |
| `/profile delete <name>` | Delete a profile |
| `/profile export <name>` | Export profile as JSON |
| `/profile import` | Import profile from JSON reply |
| `/spawn <name> <path> [--profile <p>] [team-size]` | Spawn with optional profile |
| `/rules <session>` | Show session rules |
| `/rules <session> <text>` | Add rule(s) to session |
| `/rules <session> clear` | Clear session rules |
| `/fact <session> <text>` | Add fact to session |
| `/facts <session>` | Show session facts |
| `/channel <session> <text>` | Override channel instructions |
| `/channel <session> reset` | Revert to default channel instructions |
| `/trust <session> strict\|ask\|auto\|yolo` | Set trust level |
| `/verify <session>` | Manually trigger verification |

### Web Dashboard

- **Profile manager page**: list, create, edit, delete, import, export profiles
- **Spawn dialog**: profile dropdown + per-field override checkboxes
- **Session panel**: editable rules, facts, channel override, verification config
- **Activity log**: all tool uses classified as Logged/Review/Dangerous with classification reason
- **Drift events** in the activity log with warning icon and correction text
- **Verification results** in the activity log with pass/fail badges

## Hub vs Claude Responsibilities

| Responsibility | Hub (deterministic) | Main Claude | Sidecar (opt-in) | User |
|---|---|---|---|---|
| Define profiles | ✅ | — | — | — |
| Apply profile to session | ✅ | — | — | — |
| Inject rules/facts/channel on messages | ✅ | — | — | — |
| Classify permission | ✅ (regex only) | — | — | — |
| Escalate ambiguous permission | ✅ | — | — | ✅ (decides) |
| Execute the tool | — | ✅ | — | — |
| Detect drift | ✅ (regex only) | — | — | — |
| Notify user of drift | ✅ | — | — | ✅ (receives) |
| Decide whether to correct drift | — | — | — | ✅ |
| Send correction template | ✅ (on user click) | — | — | — |
| Apply correction to session | — | ✅ (reads it) | — | — |
| Run verification commands | ✅ (subprocess) | — | — | — |
| Truncate verification output | ✅ | — | — | — |
| Summarize verification output | — | — | ✅ (only if opt-in) | — |

**The user is back in the loop** for ambiguous decisions — no black-box LLM judgment deciding what runs. Sidecar is limited to one optional task (output summarization).

## Rollout Plan

Phase 1 ships in four sub-phases (down from five — sidecar removed as a standalone phase). Each is independently shippable and delivers user-visible value.

### 1a — Profile System + Trust Levels
- `Profile` type, `profiles.ts` module, `profiles.json` storage
- New `TrustLevel` values (`strict`/`ask`/`auto`/`yolo`), migration from `auto-approve` → `auto`
- `/profile`, `/profiles` commands (Telegram, CLI)
- Web: profile manager page, spawn dialog profile dropdown
- Built-in profiles: `careful`, `tdd`, `docs`, `yolo`
- Spawn integration: `--profile <name>` flag
- Session resolution: `profile + overrides` merge at read time
- **Ships as:** "You can now pick a profile when spawning sessions, configure them centrally."

### 1b — Smart Permission Classification
- `analysis.ts` with `classify()` pure function
- Static map (L1) for known tools
- Regex rules (L2) for Bash/Write/Edit arguments
- Extend `permission-engine.ts` to use classifier + honor new trust levels
- Activity log for Logged/Review events (web UI only, Telegram silent)
- Unit tests exhaustively covering the regex patterns (known-good, known-bad, edge cases)
- **Ships as:** "No more permission prompts for Read/Glob/Grep. Dangerous commands still ask. Strict/ask/auto/yolo trust levels work."

### 1c — Rules, Facts, Channel Instructions, Drift Detection
- Extend `profiles.ts` with injection pipeline (channel + rules + facts in order)
- Built-in channel instructions per frontend (Telegram/Web/CLI)
- Auto-fetch fallback for bare file paths in replies
- `detectDrift()` pure function in `analysis.ts` (regex only)
- Drift notifications to user (Telegram + web), never auto-injected into session
- Drift correction templates (user clicks "Send correction" to apply)
- `/rules`, `/fact`, `/channel` commands
- Telegram delivery handles 4096-char limit (chunk or document upload for large files)
- **Ships as:** "Claude respects your rules and facts. Mobile users see file contents inline. Drift alerts you when Claude goes off track."

### 1d — Verification Runner + Sidecar (optional)
- `verification.ts` with subprocess runner
- Sentinel phrase trigger (`✅ COMPLETE` by default)
- Project probing for auto-detected commands
- Per-command timeout, output capture, truncation for long output
- `sidecar.ts` module for opt-in output summarization (`sidecarEnabled: true` in profile)
- `/verify` command to manually trigger
- **Ships as:** "Claude can't falsely claim done. Verification runs your real test suite, reports pass/fail back to the session. Sidecar Claude is available opt-in for failed-verification summarization."

## Already Working (not in this phase)

- Voice transcription — Telegram and mobile keyboards already transcribe client-side
- File uploads — photos, screenshots, documents already saved to project folder

## Non-Goals

- Scheduled messages — separate phase
- Event reactions / webhook triggers — separate phase
- Session timeline / replay beyond the basic activity log — separate phase
- Agent teams changes — existing behavior preserved
- Profile sync across machines via git URL — future enhancement

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Permission classification too slow | L1/L2 is pure regex, microseconds per call. Zero LLM in critical path. |
| Regex misses a dangerous command | Conservative defaults: unknown patterns fall to Review, which escalates to user in `strict`/`ask` trust. Only `auto` auto-allows Review — and that's the user's explicit choice. |
| Regex false-positive on benign command | Benign allow-list uses first-token matching only. If a composite command (`cd /tmp && ls`) isn't matched, it falls to Review → escalates to user (annoying but safe). |
| Drift regex high false-positive rate | Drift is advisory — user notification only, never auto-applied. User ignores false positives with one click. |
| Drift feedback loops | Impossible by design: drift doesn't inject into session without user click. |
| Rules injection ignored over time | Accepted risk — drift detection catches downstream violations; user can manually re-enforce. |
| Sentinel phrase triggers too rarely | Channel instruction tells Claude when to use it. If Claude forgets, user can manually run `/verify <session>`. |
| Verification commands hang | Per-command 120s timeout, killed on exceed. Failure reported as "verification timed out". |
| Verification commands fail due to missing tools | Project probing at profile creation only writes commands that exist (checks `package.json` scripts, `which pytest`, etc.). |
| Profile deletion breaks sessions | Sessions store `profileOverrides` — if profile is deleted, overrides remain as last-known-good. |
| Token rate limit from sidecar | Sidecar is opt-in and rare (only failed-verification summarization). Default `sidecarEnabled: false`. Estimated <10k tokens/day even when enabled. |
| Built-in profiles don't match user's project | User picks "None" (blank config) or clones a built-in and edits it. |
| Mobile Telegram 4096-char limit on file content | Auto-fetch chunks content or sends as document attachment for large files. |
