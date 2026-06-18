# Autopilot Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build autopilot mode for operant sessions — when Claude sends a decision question, the daemon fires `/btw <wrapped-question>` into the session's tmux pane, parses the answer from the Ink overlay, and routes it back through the existing channel pipe so the session resumes without a human in the loop.

**Architecture:** A new `AutopilotRunner` module watches for outgoing user-facing replies from autopilot-enabled sessions, fires programmatic `/btw` via `tmux send-keys`, polls `tmux capture-pane` until the overlay settles, parses the indented answer block, dismisses with `Esc`, and delivers the result via `socketServer.sendToSession` (MCP channel notification). Risk-keyword filter and `ESCALATE:` token drop-through the proxy and escalate to the user on Telegram/Web. Optional veto window shows the draft to the user before auto-sending.

**Tech Stack:** Bun, TypeScript, Bun's `$` shell template for tmux, `bun:test` for testing, existing operant modules (SessionRegistry, ScreenManager, SocketServer, MessageRouter).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/autopilot-parser.ts` | Pure function `parseBtwAnswer(pane: string)` — extracts the answer block from a captured tmux pane. No I/O. No tmux calls. |
| `src/autopilot-risk.ts` | Pure function `hasRiskKeyword(text, keywords)` — scans outgoing question against a keyword list. |
| `src/autopilot.ts` | `AutopilotRunner` class — owns the state machine: pre-fire risk check → send-keys `/btw` → poll capture-pane → parse → dismiss → return result. Accepts `ScreenManager` and config; no direct tmux calls. |
| `tests/autopilot-parser.test.ts` | Parser tests with fixtures from the real test transcript (single-line, multi-line, with /btw history, with ANSI). |
| `tests/autopilot-risk.test.ts` | Risk-filter tests. |
| `tests/autopilot.test.ts` | Runner tests with a fake ScreenManager that returns scripted pane content. |

### Modified files

| Path | Change |
|---|---|
| `src/types.ts` | Add `AutopilotConfig` + `AutopilotRuntimeState`; extend `HubConfig` and `SessionConfig`. |
| `src/config.ts` | Load/save `autopilot` defaults from hub config. |
| `src/session-registry.ts` | Add `setAutopilot`, `getAutopilot` methods; persist via save/restore format. |
| `src/screen-manager.ts` | Expose two public helpers: `sendKeysRaw(sessionName, text, withEnter)`, `capturePane(sessionName, lines?)`. |
| `src/daemon.ts` | Wire `AutopilotRunner`; hook into the `reply` tool_call path after routing to user — if autopilot on, run the proxy and inject answer back through the channel pipe. |
| `src/frontends/telegram.ts` | `/autopilot <name> [on\|off]` command; 🤖 badge in `/list` and `/status`; veto-window message with inline buttons. |
| `src/frontends/web.ts` | `/api/autopilot` endpoint; veto-window WebSocket event. |
| `src/frontends/web-client.html` | Toggle in session row; 🤖 badge; veto-window card with Send/Edit/Cancel buttons. |
| `src/cli.ts` | `autopilot <name> [on\|off]` command parity with Telegram. |

---

## Task 1: Add autopilot types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Extend `types.ts` with autopilot types**

Add these type exports. Append after the `HubConfig` type:

```ts
export type AutopilotConfig = {
  enabled: boolean
  vetoWindowMs: number        // 0 = no veto, send immediately
  btwTimeoutMs: number        // per-/btw timeout
  maxDurationMinutes: number  // cap before asking user to continue
  riskKeywords: string[]      // case-insensitive substring match on outgoing question
  riskOverride?: boolean      // per-session: bypass risk filter (default false)
}

export type AutopilotDefaults = Omit<AutopilotConfig, 'enabled' | 'riskOverride'>

export const DEFAULT_AUTOPILOT_DEFAULTS: AutopilotDefaults = {
  vetoWindowMs: 30_000,
  btwTimeoutMs: 30_000,
  maxDurationMinutes: 60,
  riskKeywords: [
    'delete', 'force push', 'drop table', 'production', 'prod deploy',
    'billing', 'credit card', 'api key', 'secret', 'revoke', 'uninstall',
  ],
}
```

Extend `HubConfig`:

```ts
export type HubConfig = {
  webPort: number
  webHost?: string
  browseRoot?: string
  telegramToken: string
  telegramBotUsername?: string
  telegramAllowFrom: string[]
  defaultTrust: TrustLevel
  defaultUploadDir: string
  autopilot?: Partial<AutopilotDefaults>   // new — optional overrides of DEFAULT_AUTOPILOT_DEFAULTS
}
```

Extend `SessionConfig`:

```ts
export type SessionConfig = {
  name: string
  trust: TrustLevel
  prefix: string
  uploadDir: string
  managed: boolean
  teamIndex: number
  teamSize: number
  appliedProfile?: string
  profileOverrides?: ProfileOverrides
  autopilot?: Partial<AutopilotConfig>    // new — per-session settings (enabled, overrides of defaults)
}
```

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `bun test tests/config.test.ts tests/session-registry.test.ts`
Expected: PASS (new optional fields shouldn't break existing tests).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add AutopilotConfig and defaults"
```

---

## Task 2: Load autopilot defaults from hub config

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
test('loadHubConfig reads autopilot section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-autopilot-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000,
      defaultTrust: 'ask',
      defaultUploadDir: '.',
      telegramToken: '',
      telegramAllowFrom: ['123'],
      autopilot: { vetoWindowMs: 5000, maxDurationMinutes: 120 },
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.autopilot?.vetoWindowMs).toBe(5000)
    expect(cfg.autopilot?.maxDurationMinutes).toBe(120)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig without autopilot key returns undefined for autopilot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-noauto-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: '', telegramAllowFrom: [],
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.autopilot).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts -t "autopilot"`
Expected: FAIL — `autopilot` field not returned by `loadHubConfig`.

- [ ] **Step 3: Update `loadHubConfig` to pass through autopilot**

In `src/config.ts`, modify `loadHubConfig` to include `autopilot`:

```ts
export function loadHubConfig(dir: string = HUB_DIR): HubConfig {
  const raw = readJson<Partial<HubConfig>>(join(dir, 'config.json'))
  if (!raw) return defaultConfig()
  return {
    webPort: raw.webPort ?? 3000,
    webHost: raw.webHost,
    browseRoot: raw.browseRoot,
    telegramToken: raw.telegramToken ?? '',
    telegramBotUsername: raw.telegramBotUsername,
    telegramAllowFrom: raw.telegramAllowFrom ?? [],
    defaultTrust: raw.defaultTrust ?? 'ask',
    defaultUploadDir: raw.defaultUploadDir ?? '.',
    autopilot: raw.autopilot,   // new — pass through as-is
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts -t "autopilot"`
Expected: PASS.

- [ ] **Step 5: Add a helper to resolve effective defaults**

Append to `src/config.ts`:

```ts
import { DEFAULT_AUTOPILOT_DEFAULTS } from './types'
import type { AutopilotDefaults } from './types'

export function resolveAutopilotDefaults(config: HubConfig): AutopilotDefaults {
  const override = config.autopilot ?? {}
  return {
    vetoWindowMs: override.vetoWindowMs ?? DEFAULT_AUTOPILOT_DEFAULTS.vetoWindowMs,
    btwTimeoutMs: override.btwTimeoutMs ?? DEFAULT_AUTOPILOT_DEFAULTS.btwTimeoutMs,
    maxDurationMinutes: override.maxDurationMinutes ?? DEFAULT_AUTOPILOT_DEFAULTS.maxDurationMinutes,
    riskKeywords: override.riskKeywords ?? DEFAULT_AUTOPILOT_DEFAULTS.riskKeywords,
  }
}
```

- [ ] **Step 6: Test the helper**

Append to `tests/config.test.ts`:

```ts
test('resolveAutopilotDefaults merges user overrides with built-in defaults', () => {
  const cfg: HubConfig = {
    webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
    telegramToken: '', telegramAllowFrom: [],
    autopilot: { vetoWindowMs: 1000 },
  }
  const resolved = resolveAutopilotDefaults(cfg)
  expect(resolved.vetoWindowMs).toBe(1000)
  expect(resolved.btwTimeoutMs).toBe(30_000)
  expect(resolved.riskKeywords.length).toBeGreaterThan(5)
})
```

Update imports at top of test file:
```ts
import { loadHubConfig, saveHubConfig, resolveAutopilotDefaults } from '../src/config'
import type { HubConfig } from '../src/types'
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/config.test.ts`
Expected: PASS all.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): load autopilot defaults from hub config"
```

---

## Task 3: SessionRegistry — autopilot get/set/persist

**Files:**
- Modify: `src/session-registry.ts`
- Test: `tests/session-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-registry.test.ts`:

```ts
test('setAutopilot stores config, getAutopilot returns it', () => {
  const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg.register('/p:0')
  reg.setAutopilot('/p:0', { enabled: true, vetoWindowMs: 5000 })
  const a = reg.getAutopilot('/p:0')
  expect(a?.enabled).toBe(true)
  expect(a?.vetoWindowMs).toBe(5000)
})

test('getAutopilot returns undefined when not set', () => {
  const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg.register('/p:0')
  expect(reg.getAutopilot('/p:0')).toBeUndefined()
})

test('toSaveFormat includes autopilot; restoreFrom restores it', () => {
  const reg1 = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg1.register('/p:0')
  reg1.setAutopilot('/p:0', { enabled: true, vetoWindowMs: 10_000 })
  const saved = reg1.toSaveFormat()

  const reg2 = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg2.restoreFrom(saved)
  expect(reg2.getAutopilot('/p:0')?.enabled).toBe(true)
  expect(reg2.getAutopilot('/p:0')?.vetoWindowMs).toBe(10_000)
})

test('setAutopilot with null/undefined clears it', () => {
  const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg.register('/p:0')
  reg.setAutopilot('/p:0', { enabled: true })
  reg.setAutopilot('/p:0', undefined)
  expect(reg.getAutopilot('/p:0')).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/session-registry.test.ts -t "Autopilot"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the methods**

Add to `src/session-registry.ts` — near the other setters (after `setPrefix`):

```ts
  setAutopilot(path: string, config: Partial<AutopilotConfig> | undefined): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (config === undefined) {
      delete s.autopilot
    } else {
      s.autopilot = config
    }
  }

  getAutopilot(path: string): Partial<AutopilotConfig> | undefined {
    return this.sessions.get(path)?.autopilot
  }
```

Update the import line at top:
```ts
import type { SessionState, SessionConfig, TrustLevel, Profile, FrontendSource, AutopilotConfig } from './types'
```

Update `toSaveFormat` — add `autopilot` to the persisted object:
```ts
  toSaveFormat(): Record<string, SessionConfig> {
    const result: Record<string, SessionConfig> = {}
    for (const [path, s] of this.sessions) {
      result[path] = {
        name: s.name,
        trust: s.trust,
        prefix: s.prefix,
        uploadDir: s.uploadDir,
        managed: s.managed,
        teamIndex: s.teamIndex,
        teamSize: s.teamSize,
        appliedProfile: s.appliedProfile,
        profileOverrides: s.profileOverrides,
        autopilot: s.autopilot,    // new
      }
    }
    return result
  }
```

`restoreFrom` already spreads `...config` so it picks `autopilot` up automatically — no change needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/session-registry.test.ts -t "Autopilot"`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `bun test`
Expected: PASS all.

- [ ] **Step 6: Commit**

```bash
git add src/session-registry.ts tests/session-registry.test.ts
git commit -m "feat(registry): autopilot get/set/persist per session"
```

---

## Task 4: ScreenManager — `sendKeysRaw` and `capturePane`

**Files:**
- Modify: `src/screen-manager.ts`
- Test: `tests/screen-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/screen-manager.test.ts`:

```ts
test('capturePane returns text from tmux when session exists', async () => {
  const sm = new ScreenManager()
  // Create a throwaway tmux session with a known pane content
  const s = `test-capture-${Date.now()}`
  await $`tmux new-session -d -s ${s} "bash -c 'echo HELLOWORLD; sleep 30'"`.quiet()
  try {
    // Wait briefly for the echo to hit the pane
    await new Promise(r => setTimeout(r, 200))
    const pane = await sm.capturePane(s, 20)
    expect(pane).toContain('HELLOWORLD')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

test('sendKeysRaw writes a line and capturePane sees it', async () => {
  const sm = new ScreenManager()
  const s = `test-sendkeys-${Date.now()}`
  // cat will echo whatever we type
  await $`tmux new-session -d -s ${s} "cat"`.quiet()
  try {
    await sm.sendKeysRaw(s, 'HELLO-FROM-TEST', true)
    await new Promise(r => setTimeout(r, 200))
    const pane = await sm.capturePane(s)
    expect(pane).toContain('HELLO-FROM-TEST')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})
```

Add at the top of the test file if not already present:
```ts
import { $ } from 'bun'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/screen-manager.test.ts -t "capturePane|sendKeysRaw"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the two public methods to ScreenManager**

In `src/screen-manager.ts`, add inside the `ScreenManager` class:

```ts
  async capturePane(sessionName: string, lines: number = 200): Promise<string> {
    try {
      return await $`tmux capture-pane -t ${sessionName} -p -S -${lines}`.quiet().text()
    } catch {
      return ''
    }
  }

  async sendKeysRaw(sessionName: string, text: string, withEnter: boolean): Promise<void> {
    if (withEnter) {
      await $`tmux send-keys -t ${sessionName} ${text} Enter`.quiet()
    } else {
      await $`tmux send-keys -t ${sessionName} ${text}`.quiet()
    }
  }

  async sendEscape(sessionName: string): Promise<void> {
    try { await $`tmux send-keys -t ${sessionName} Escape`.quiet() } catch {}
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/screen-manager.test.ts -t "capturePane|sendKeysRaw"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screen-manager.ts tests/screen-manager.test.ts
git commit -m "feat(screen-manager): expose capturePane, sendKeysRaw, sendEscape helpers"
```

---

## Task 5: Autopilot parser — extract answer from /btw overlay

**Files:**
- Create: `src/autopilot-parser.ts`
- Test: `tests/autopilot-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autopilot-parser.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { parseBtwAnswer, isOverlaySettled } from '../src/autopilot-parser'

describe('parseBtwAnswer', () => {
  test('extracts single-line answer from clean overlay (from real test transcript)', () => {
    const pane = `
❯ /btw what is 2+2?

  /btw what is 2+2?

    4

  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.answer).toBe('4')
  })

  test('extracts contextual multi-word answer with /btw history present', () => {
    const pane = `
❯ /btw which runtime should I pick for this project — Node or Bun?

  /btw what is 2+2?
  /btw which runtime should I pick for this project — Node or Bun?

    Bun — that's what your project already uses.

  ↑/↓ to scroll · f to fork · x to clear history · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.answer).toBe("Bun — that's what your project already uses.")
  })

  test('joins multi-line answer with single space', () => {
    const pane = `
❯ /btw explain briefly

  /btw explain briefly

    First line of the answer.
    Second line of the answer.
    Third line.

  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.answer).toBe('First line of the answer. Second line of the answer. Third line.')
    }
  })

  test('returns not_ready when footer is absent (overlay still rendering)', () => {
    const pane = '❯ /btw hmm\n\n  /btw hmm\n\n'
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('not_ready')
  })

  test('returns not_ready when spinner is present', () => {
    const pane = `
❯ /btw hmm

  /btw hmm

✻ Hatching… (3s · ↓ 120 tokens)

  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('not_ready')
  })

  test('returns parse_error when footer is present but answer block is missing', () => {
    const pane = `
❯ /btw hmm

  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('parse_error')
  })

  test('strips ANSI escape sequences before parsing', () => {
    const pane = `
\x1b[38;5;33m❯ /btw what is 2+2?\x1b[0m

  /btw what is 2+2?

    4

  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const r = parseBtwAnswer(pane)
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.answer).toBe('4')
  })
})

describe('isOverlaySettled', () => {
  test('true when footer present and no spinner', () => {
    expect(isOverlaySettled('stuff\n  ↑/↓ to scroll · f to fork · Esc to dismiss\n')).toBe(true)
  })
  test('false when spinner present even with footer', () => {
    expect(isOverlaySettled('✻ Hatching… (3s)\n  ↑/↓ to scroll · f to fork · Esc to dismiss\n')).toBe(false)
  })
  test('false when footer missing', () => {
    expect(isOverlaySettled('something\n❯\n')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/autopilot-parser.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src/autopilot-parser.ts`**

```ts
// src/autopilot-parser.ts
// Pure parsing of the Claude Code /btw overlay out of a tmux pane capture.

export type ParseResult =
  | { status: 'ok'; answer: string }
  | { status: 'not_ready' }           // overlay still rendering (spinner or no footer)
  | { status: 'parse_error' }          // footer present but answer block missing

// The Esc-to-dismiss line is the stable footer signature for a settled /btw overlay.
const FOOTER_RE = /↑\/↓ to scroll.*Esc to dismiss/
const SPINNER_RES = [
  /✻\s*Hatching…/,
  /Crunching…/,
  /Thinking…/,
  /esc to interrupt/,
]

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function isOverlaySettled(pane: string): boolean {
  const clean = stripAnsi(pane)
  if (!FOOTER_RE.test(clean)) return false
  if (SPINNER_RES.some(re => re.test(clean))) return false
  return true
}

export function parseBtwAnswer(pane: string): ParseResult {
  const clean = stripAnsi(pane)
  if (SPINNER_RES.some(re => re.test(clean))) return { status: 'not_ready' }
  const lines = clean.split('\n')
  const footerIdx = lines.findIndex(l => FOOTER_RE.test(l))
  if (footerIdx === -1) return { status: 'not_ready' }

  // Walk up from the footer, skipping blank lines, to find the bottom-most
  // contiguous block of 4-space-indented lines that isn't "/btw" history.
  let i = footerIdx - 1
  while (i >= 0 && lines[i]!.trim() === '') i--
  const answerLines: string[] = []
  while (i >= 0 && /^ {4}[^ ]/.test(lines[i]!) && !/^\s*\/btw\b/.test(lines[i]!)) {
    answerLines.unshift(lines[i]!.slice(4))
    i--
  }
  if (answerLines.length === 0) return { status: 'parse_error' }
  return { status: 'ok', answer: answerLines.join(' ').trim() }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/autopilot-parser.test.ts`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot-parser.ts tests/autopilot-parser.test.ts
git commit -m "feat(autopilot): parser for /btw overlay answers"
```

---

## Task 6: Autopilot risk filter

**Files:**
- Create: `src/autopilot-risk.ts`
- Test: `tests/autopilot-risk.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autopilot-risk.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { hasRiskKeyword, wrapQuestion } from '../src/autopilot-risk'

const KEYWORDS = ['delete', 'force push', 'drop table', 'production', 'billing', 'api key']

describe('hasRiskKeyword', () => {
  test('matches a single word case-insensitively', () => {
    expect(hasRiskKeyword('Should I DELETE the backup?', KEYWORDS)).toBe(true)
  })
  test('matches a multi-word keyword as substring', () => {
    expect(hasRiskKeyword('Do you want to force push this?', KEYWORDS)).toBe(true)
  })
  test('no match → false', () => {
    expect(hasRiskKeyword('Should this file be called foo or bar?', KEYWORDS)).toBe(false)
  })
  test('empty keywords list → always false', () => {
    expect(hasRiskKeyword('delete everything', [])).toBe(false)
  })
})

describe('wrapQuestion', () => {
  test('produces a string that contains the raw question', () => {
    const wrapped = wrapQuestion('Option A or Option B?', '')
    expect(wrapped).toContain('Option A or Option B?')
  })
  test('produces a string that instructs ESCALATE for irreversible', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toContain('escalate')
  })
  test('includes autopilot.md preferences block when provided', () => {
    const wrapped = wrapQuestion('pick one', '- Prefer Bun\n- Always TDD')
    expect(wrapped).toContain('Prefer Bun')
    expect(wrapped).toContain('Always TDD')
  })
  test('omits preferences block when empty', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped).not.toContain('autopilot.md')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/autopilot-risk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/autopilot-risk.ts`**

```ts
// src/autopilot-risk.ts
// Risk-keyword filter + wrapped-question builder.

export function hasRiskKeyword(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false
  const haystack = text.toLowerCase()
  return keywords.some(kw => haystack.includes(kw.toLowerCase()))
}

export function wrapQuestion(rawQuestion: string, preferencesMarkdown: string): string {
  const prefsBlock = preferencesMarkdown.trim().length > 0
    ? `\nUser preferences from autopilot.md:\n${preferencesMarkdown.trim()}\n`
    : ''
  return [
    'You are acting as the user\'s delegate for this autopilot session.',
    'Answer the following question as the user would, using this project\'s',
    'conversation context and the preferences below (if any).',
    '',
    'Constraints:',
    '- Be decisive. Pick one option. One sentence is ideal, one short paragraph max.',
    '- If the choice is irreversible (delete data, force push, prod deploy,',
    '  add a paid service, change billing, remove auth), reply EXACTLY:',
    '  ESCALATE: <one-sentence reason>',
    '- If the choice is outside the project\'s scope, same: ESCALATE: <reason>',
    '- Do not propose a third option the user did not offer unless it is',
    '  obviously safer than A or B.',
    '- Answer as the user, not about the user. No preamble. No "Based on...".',
    prefsBlock,
    'Question from Claude:',
    rawQuestion,
  ].join('\n')
}

export function isEscalateAnswer(answer: string): { escalated: boolean; reason?: string } {
  const m = /^\s*ESCALATE\s*:?\s*(.*)$/im.exec(answer)
  if (!m) return { escalated: false }
  return { escalated: true, reason: m[1]?.trim() || 'proxy escalated (no reason given)' }
}
```

- [ ] **Step 4: Add escalation-detection tests**

Append to `tests/autopilot-risk.test.ts`:

```ts
import { isEscalateAnswer } from '../src/autopilot-risk'

describe('isEscalateAnswer', () => {
  test('bare ESCALATE', () => {
    expect(isEscalateAnswer('ESCALATE').escalated).toBe(true)
  })
  test('ESCALATE: with reason', () => {
    const r = isEscalateAnswer('ESCALATE: this would drop production data')
    expect(r.escalated).toBe(true)
    expect(r.reason).toContain('drop production')
  })
  test('case-insensitive', () => {
    expect(isEscalateAnswer('escalate: no').escalated).toBe(true)
  })
  test('normal answer → not escalated', () => {
    expect(isEscalateAnswer('Bun is the right pick here.').escalated).toBe(false)
  })
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/autopilot-risk.test.ts`
Expected: PASS all.

- [ ] **Step 6: Commit**

```bash
git add src/autopilot-risk.ts tests/autopilot-risk.test.ts
git commit -m "feat(autopilot): risk filter, question wrapper, escalate detector"
```

---

## Task 7: AutopilotRunner — fire /btw, poll, parse, dismiss

**Files:**
- Create: `src/autopilot.ts`
- Test: `tests/autopilot.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autopilot.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { AutopilotRunner } from '../src/autopilot'

// Fake ScreenManager — returns scripted pane content on each capturePane call.
class FakeScreenManager {
  public sentKeys: { text: string; withEnter: boolean }[] = []
  public escapes = 0
  private scripted: string[]
  private sendKeysCalled = false

  constructor(scripted: string[]) {
    this.scripted = [...scripted]
  }
  async sendKeysRaw(_s: string, text: string, withEnter: boolean) {
    this.sentKeys.push({ text, withEnter })
    this.sendKeysCalled = true
  }
  async capturePane(_s: string, _n?: number): Promise<string> {
    if (!this.sendKeysCalled) return ''
    return this.scripted.shift() ?? ''
  }
  async sendEscape(_s: string) { this.escapes++ }
}

describe('AutopilotRunner.runBtw', () => {
  test('happy path: sends /btw, polls until settled, returns answer, dismisses', async () => {
    const pane = `
❯ /btw pick
  /btw pick
    Bun — that's what your project already uses.
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 10,
      btwTimeoutMs: 2000,
    })
    const result = await runner.runBtw('hub-x', 'wrapped question text')
    expect(result.status).toBe('answered')
    if (result.status === 'answered') {
      expect(result.answer).toContain('Bun')
    }
    expect(sm.sentKeys[0]?.text).toContain('/btw wrapped question text')
    expect(sm.sentKeys[0]?.withEnter).toBe(true)
    expect(sm.escapes).toBe(1)
  })

  test('timeout path: returns timeout when pane never settles', async () => {
    const sm = new FakeScreenManager(['', '', '', ''])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 5,
      btwTimeoutMs: 50,
    })
    const result = await runner.runBtw('hub-x', 'q')
    expect(result.status).toBe('timeout')
    // dismiss anyway to leave the session usable
    expect(sm.escapes).toBe(1)
  })

  test('parse_error path: overlay settles but has no answer block', async () => {
    const empty = `
❯ /btw q
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', empty])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 5,
      btwTimeoutMs: 500,
    })
    const result = await runner.runBtw('hub-x', 'q')
    expect(result.status).toBe('parse_error')
    expect(sm.escapes).toBe(1)
  })

  test('skips /btw entirely when risk keyword present in raw question', async () => {
    const sm = new FakeScreenManager([])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 5,
      btwTimeoutMs: 500,
    })
    const result = await runner.runBtw('hub-x', 'wrapped q', {
      rawQuestion: 'Should I DELETE the whole backup?',
      riskKeywords: ['delete'],
    })
    expect(result.status).toBe('escalate')
    if (result.status === 'escalate') expect(result.reason).toContain('risk')
    expect(sm.sentKeys.length).toBe(0)  // /btw never fired
  })

  test('detects ESCALATE token in the answer', async () => {
    const pane = `
❯ /btw q
  /btw q
    ESCALATE: this change touches production.
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 5,
      btwTimeoutMs: 500,
    })
    const result = await runner.runBtw('hub-x', 'q')
    expect(result.status).toBe('escalate')
    if (result.status === 'escalate') expect(result.reason).toContain('production')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/autopilot.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/autopilot.ts`**

```ts
// src/autopilot.ts
// Orchestrates programmatic /btw via the ScreenManager: fire, poll, parse, dismiss.

import { ScreenManager } from './screen-manager'
import { parseBtwAnswer, isOverlaySettled } from './autopilot-parser'
import { hasRiskKeyword, isEscalateAnswer } from './autopilot-risk'

export type AutopilotResult =
  | { status: 'answered'; answer: string }
  | { status: 'escalate'; reason: string }
  | { status: 'parse_error' }
  | { status: 'timeout' }

export type RunBtwOptions = {
  rawQuestion?: string      // the original question from Claude, used for risk filter
  riskKeywords?: readonly string[]
  riskOverride?: boolean    // bypass risk check
}

export type AutopilotRunnerOpts = {
  screenManager: Pick<ScreenManager, 'sendKeysRaw' | 'capturePane' | 'sendEscape'>
  pollIntervalMs?: number   // default 300
  btwTimeoutMs?: number     // default 30_000
}

export class AutopilotRunner {
  private sm: AutopilotRunnerOpts['screenManager']
  private pollIntervalMs: number
  private btwTimeoutMs: number

  constructor(opts: AutopilotRunnerOpts) {
    this.sm = opts.screenManager
    this.pollIntervalMs = opts.pollIntervalMs ?? 300
    this.btwTimeoutMs = opts.btwTimeoutMs ?? 30_000
  }

  async runBtw(sessionName: string, wrappedQuestion: string, opts: RunBtwOptions = {}): Promise<AutopilotResult> {
    // 1. Pre-fire risk check on the raw question.
    if (!opts.riskOverride && opts.rawQuestion && opts.riskKeywords
        && hasRiskKeyword(opts.rawQuestion, opts.riskKeywords)) {
      return { status: 'escalate', reason: 'risk keyword matched in outgoing question' }
    }

    // 2. Fire /btw into the session's tmux pane.
    await this.sm.sendKeysRaw(sessionName, `/btw ${wrappedQuestion}`, true)

    // 3. Poll capture-pane until the overlay is settled or we time out.
    const deadline = Date.now() + this.btwTimeoutMs
    let finalPane = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs))
      const pane = await this.sm.capturePane(sessionName, 200)
      if (pane && isOverlaySettled(pane)) {
        finalPane = pane
        break
      }
    }

    // 4. Dismiss overlay regardless of outcome so the session stays usable.
    await this.sm.sendEscape(sessionName)

    if (!finalPane) return { status: 'timeout' }

    // 5. Parse.
    const parsed = parseBtwAnswer(finalPane)
    if (parsed.status === 'parse_error') return { status: 'parse_error' }
    if (parsed.status === 'not_ready') return { status: 'timeout' }

    // 6. Check for ESCALATE token.
    const esc = isEscalateAnswer(parsed.answer)
    if (esc.escalated) return { status: 'escalate', reason: esc.reason ?? 'proxy escalated' }

    return { status: 'answered', answer: parsed.answer }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/autopilot.test.ts`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): runner — fire /btw, poll, parse, dismiss"
```

---

## Task 8: Wire AutopilotRunner into the daemon reply path

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Understand the hook point**

In `src/daemon.ts` the `socketServer.on('tool_call', ...)` handler for `name === 'reply'` is where Claude's outgoing message is delivered to the user via `router.routeFromSession(path, text, files)`. This is the moment we know Claude has sent a reply and is about to be idle awaiting user input. We need to add an autopilot branch AFTER `routeFromSession` but before we return.

- [ ] **Step 2: Add AutopilotRunner instantiation at daemon startup**

Near the other module instantiations (after `const screenManager = new ScreenManager()`), add:

```ts
import { AutopilotRunner } from './autopilot'
import { wrapQuestion } from './autopilot-risk'
import { resolveAutopilotDefaults } from './config'
import { readFileSync as _rfs, existsSync as _ex } from 'fs'
import { join as _join } from 'path'

const autopilotDefaults = resolveAutopilotDefaults(config)
const autopilotRunner = new AutopilotRunner({
  screenManager,
  btwTimeoutMs: autopilotDefaults.btwTimeoutMs,
})

function loadProjectPreferences(projectPath: string): string {
  const candidates = [
    _join(projectPath, 'autopilot.md'),
    _join(process.env.HOME ?? '', '.claude', 'autopilot.md'),
  ]
  for (const p of candidates) {
    try {
      if (_ex(p)) return _rfs(p, 'utf8')
    } catch { /* ignore */ }
  }
  return ''
}
```

- [ ] **Step 3: Hook into the reply path**

In the existing `socketServer.on('tool_call', (path, name, args) => {...})`, modify the `if (name === 'reply')` branch. After the existing `router.routeFromSession(...)` and drift / auto-fetch logic, add:

```ts
    // Autopilot: if this session is in autopilot mode, proxy the user's answer
    // via /btw instead of waiting for a human.
    const ap = registry.getAutopilot(path)
    if (ap?.enabled) {
      const sessionName = session.name
      const tmuxName = `hub-${sessionName}`
      const prefs = loadProjectPreferences(registry.folderPath(path))
      const wrapped = wrapQuestion(text, prefs)
      const riskKeywords = ap.riskKeywords ?? autopilotDefaults.riskKeywords
      autopilotRunner.runBtw(tmuxName, wrapped, {
        rawQuestion: text,
        riskKeywords,
        riskOverride: ap.riskOverride,
      }).then(result => {
        if (result.status === 'answered') {
          // Inject the proxy answer into the same session via the existing
          // channel pipe. Main Claude reads it as a user reply and continues.
          socketServer.sendToSession(path, {
            type: 'channel_message',
            content: result.answer,
            meta: { source: 'autopilot', frontend: 'web' },
          })
          telegramFrontend?.deliverToUser(sessionName, `🤖 Autopilot answered: ${result.answer}`)
          webFrontend?.deliverToUser(sessionName, `🤖 Autopilot answered: ${result.answer}`)
        } else if (result.status === 'escalate') {
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot escalated: ${result.reason}`)
          webFrontend?.deliverToUser(sessionName, `🟡 Autopilot escalated: ${result.reason}`)
          // No answer injected — normal user reply flow takes over.
        } else {
          // timeout or parse_error — fall back to human
          telegramFrontend?.deliverToUser(sessionName, `🟡 Autopilot failed (${result.status}); please answer directly.`)
          webFrontend?.deliverToUser(sessionName, `🟡 Autopilot failed (${result.status}); please answer directly.`)
        }
      }).catch(err => {
        process.stderr.write(`hub: autopilot error for ${sessionName}: ${err}\n`)
      })
    }
```

- [ ] **Step 4: Add an integration smoke test**

Create `tests/autopilot-daemon-integration.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { AutopilotRunner } from '../src/autopilot'
import { wrapQuestion } from '../src/autopilot-risk'

// This is a smoke test of the wiring shape: given a wrapped question and a
// FakeScreenManager scripted with a realistic pane, runBtw returns an
// "answered" result whose answer text makes it into the message we'd send
// back through the channel pipe.
class FakeScreenManager {
  sent: string[] = []
  escapes = 0
  private panes: string[]
  constructor(panes: string[]) { this.panes = [...panes] }
  async sendKeysRaw(_s: string, text: string, _enter: boolean) { this.sent.push(text) }
  async capturePane(_s: string, _n?: number): Promise<string> { return this.panes.shift() ?? '' }
  async sendEscape(_s: string) { this.escapes++ }
}

test('integration shape: wrapQuestion → runBtw → answered returns a route-able string', async () => {
  const wrapped = wrapQuestion('Pick Node or Bun?', '- Prefer Bun')
  const pane = `
❯ /btw ${wrapped}
  /btw ${wrapped}
    Bun.
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
  const sm = new FakeScreenManager(['', pane])
  const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
  const result = await runner.runBtw('hub-x', wrapped, {
    rawQuestion: 'Pick Node or Bun?',
    riskKeywords: ['production'],
  })
  expect(result.status).toBe('answered')
  if (result.status === 'answered') {
    expect(result.answer).toBe('Bun.')
    // The string is non-empty and safe to pass as channel_message.content
    expect(result.answer.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS all existing + new tests.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts tests/autopilot-daemon-integration.test.ts
git commit -m "feat(daemon): wire autopilot into reply path, inject /btw answer via channel"
```

---

## Task 9: CLI — `autopilot` command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts` (match the existing stub-fetch test pattern in that file):

```ts
test('autopilot on → POSTs /api/autopilot with enabled=true', async () => {
  const calls: { url: string; body: any }[] = []
  globalThis.fetch = (async (url: string, opts: any) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
    return new Response(JSON.stringify({ ok: true }), { status: 200 }) as any
  }) as any
  // runCli is the existing test entry point; match its signature
  await runCli(['autopilot', 'mysess', 'on'])
  expect(calls[0]?.url).toMatch(/\/api\/autopilot/)
  expect(calls[0]?.body).toEqual({ name: 'mysess', enabled: true })
})

test('autopilot off → POSTs with enabled=false', async () => {
  const calls: { url: string; body: any }[] = []
  globalThis.fetch = (async (url: string, opts: any) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
    return new Response('{}', { status: 200 }) as any
  }) as any
  await runCli(['autopilot', 'mysess', 'off'])
  expect(calls[0]?.body).toEqual({ name: 'mysess', enabled: false })
})
```

If `runCli` doesn't already exist in the test file, look at how other CLI tests are structured and match that pattern. If CLI tests go through `Bun.spawn`, rewrite the above to use that shape instead.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/cli.test.ts -t "autopilot"`
Expected: FAIL.

- [ ] **Step 3: Add the command to `src/cli.ts`**

Find the existing command-switch block in `src/cli.ts` (patterns like `case 'list':`, `case 'spawn':`). Add:

```ts
    case 'autopilot': {
      const name = args[1]
      const mode = args[2]
      if (!name || !mode || (mode !== 'on' && mode !== 'off')) {
        console.error('Usage: autopilot <name> on|off')
        process.exit(1)
      }
      const res = await fetch(`${HUB_URL}/api/autopilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled: mode === 'on' }),
      })
      if (!res.ok) {
        console.error(`autopilot request failed: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      console.log(`autopilot ${mode} for ${name}`)
      break
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli.test.ts -t "autopilot"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): add autopilot <name> on|off command"
```

---

## Task 10: Web backend — `/api/autopilot` endpoint

**Files:**
- Modify: `src/frontends/web.ts`
- Test: `tests/frontends/web.test.ts` (if present) or `tests/integration.test.ts`

- [ ] **Step 1: Locate the existing route table**

Open `src/frontends/web.ts` and find the `if (url.pathname === ...)` chain or route-registration block that handles existing `/api/...` endpoints (e.g. `/api/trust`, `/api/rename`). Use the same shape.

- [ ] **Step 2: Add the route**

```ts
    if (url.pathname === '/api/autopilot' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const name = String(body.name ?? '')
      const enabled = Boolean(body.enabled)
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response('session not found', { status: 404 })
      this.deps.registry.setAutopilot(path, { ...this.deps.registry.getAutopilot(path), enabled })
      this.deps.onSessionsChanged?.()
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
```

If `onSessionsChanged` isn't how this file notifies clients, use the existing refresh mechanism (e.g. `this.refreshSessions()` or similar).

- [ ] **Step 3: Broadcast autopilot state in the session list payload**

Find where `web.ts` serializes sessions for the client (something like `getSessionList()` or the data sent via WebSocket in `refreshSessions`). Add `autopilot` to each item:

```ts
    {
      // ...existing fields
      autopilot: this.deps.registry.getAutopilot(path) ?? null,
    }
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/web.ts
git commit -m "feat(web): /api/autopilot endpoint + include autopilot in session list"
```

---

## Task 11: Web UI — toggle + 🤖 badge

**Files:**
- Modify: `src/frontends/web-client.html`

- [ ] **Step 1: Find the session-row renderer**

Open `src/frontends/web-client.html`. Search for where session rows are rendered (look for the badge for 🟢/🟡 status, or the trust mode display). This is where the autopilot toggle and badge go.

- [ ] **Step 2: Add the 🤖 badge after the status dot**

```js
// In the function that renders a session row, after the existing status indicator:
const autopilotBadge = session.autopilot?.enabled
  ? '<span class="ap-badge" title="Autopilot on">🤖</span>'
  : '';
// ...include `${autopilotBadge}` where status dot is built.
```

- [ ] **Step 3: Add the toggle button**

In the session-actions area (where trust/prefix/rename buttons live), add:

```js
const autopilotToggle = `
  <button class="ap-toggle" data-name="${escapeHtml(session.name)}" data-enabled="${session.autopilot?.enabled ? '1' : '0'}">
    ${session.autopilot?.enabled ? 'Autopilot: ON' : 'Autopilot: OFF'}
  </button>`;
```

Wire a click handler:

```js
document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ap-toggle');
  if (!btn) return;
  const name = btn.dataset.name;
  const enabled = btn.dataset.enabled === '1';
  await fetch('/api/autopilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled: !enabled }),
  });
  // Session list will refresh via existing WebSocket push
});
```

- [ ] **Step 4: Add minimal CSS**

In the `<style>` block:

```css
.ap-badge { margin-left: 4px; }
.ap-toggle {
  padding: 2px 8px;
  font-size: 0.8em;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  border-radius: 4px;
  cursor: pointer;
}
.ap-toggle[data-enabled="1"] { background: #224422; border-color: #4a4; }
```

- [ ] **Step 5: Manual test**

Start the daemon in a test tmux session (`tmux new-session -d -s hub-daemon-test "bun run src/daemon.ts"`), open `http://localhost:<port>`, spawn a session, click the Autopilot toggle. Verify:
- Button toggles state visually
- `curl http://localhost:<port>/api/sessions` (or the actual session-list endpoint) shows `autopilot.enabled: true`
- Badge 🤖 appears after toggling on

- [ ] **Step 6: Commit**

```bash
git add src/frontends/web-client.html
git commit -m "feat(web): autopilot toggle + 🤖 badge in session row"
```

---

## Task 12: Telegram — `/autopilot` command + 🤖 badge

**Files:**
- Modify: `src/frontends/telegram.ts`
- Test: `tests/frontends/telegram.test.ts` (if present)

- [ ] **Step 1: Locate the command handler block**

Open `src/frontends/telegram.ts`. Find where other commands are registered (e.g. `bot.command('trust', ...)`, `bot.command('rename', ...)`). Use the same shape.

- [ ] **Step 2: Add the `/autopilot` command handler**

```ts
    this.bot.command('autopilot', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const raw = ctx.message?.text ?? ''
      const parts = raw.trim().split(/\s+/).slice(1)  // drop the /autopilot token
      if (parts.length < 2 || (parts[1] !== 'on' && parts[1] !== 'off')) {
        await ctx.reply('Usage: /autopilot <name> on|off')
        return
      }
      const name = parts[0]!
      const enabled = parts[1] === 'on'
      const path = this.deps.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      this.deps.registry.setAutopilot(path, {
        ...this.deps.registry.getAutopilot(path),
        enabled,
      })
      await ctx.reply(`🤖 Autopilot ${enabled ? 'ON' : 'OFF'} for ${name}`)
    })
```

- [ ] **Step 3: Update `/list` and `/status` to show the 🤖 badge**

Find the message-building code for these commands and append a 🤖 when `registry.getAutopilot(path)?.enabled` is true. Example:

```ts
    const autopilotBadge = registry.getAutopilot(session.path)?.enabled ? ' 🤖' : ''
    const line = `${statusDot} ${session.name}${autopilotBadge} — ${session.path}`
```

- [ ] **Step 4: Manual test**

From Telegram:
- `/autopilot mysess on` → replies 🤖 Autopilot ON
- `/list` → row shows 🤖 next to the session name
- `/autopilot mysess off` → replies 🤖 Autopilot OFF
- `/list` → 🤖 is gone

- [ ] **Step 5: Commit**

```bash
git add src/frontends/telegram.ts
git commit -m "feat(telegram): /autopilot command + 🤖 badge in /list and /status"
```

---

## Task 13: Veto window — draft to user, auto-send after delay

**Files:**
- Modify: `src/autopilot.ts`
- Modify: `src/daemon.ts`
- Modify: `src/frontends/web.ts`, `src/frontends/telegram.ts`, `src/frontends/web-client.html`

- [ ] **Step 1: Add a veto-window state to AutopilotRunner's result**

This task only activates when `vetoWindowMs > 0`. Rather than injecting into the channel pipe immediately on `status === 'answered'`, the daemon:
1. Stores the pending answer in an in-memory `pendingVetos` map keyed by session path
2. Pushes a veto card to Telegram/Web
3. Starts a timer for `vetoWindowMs`
4. If the user clicks Send / Edit / Cancel, the timer is cleared
5. If the timer fires, the answer is injected as scheduled

In `src/daemon.ts`, near where `autopilotRunner` is declared, add:

```ts
type PendingVeto = {
  path: string
  sessionName: string
  draft: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
const pendingVetos = new Map<string, PendingVeto>()  // keyed by path

function scheduleVeto(
  path: string,
  sessionName: string,
  draft: string,
  vetoMs: number,
  onFire: () => void,
) {
  const existing = pendingVetos.get(path)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingVetos.delete(path)
    onFire()
  }, vetoMs)
  pendingVetos.set(path, {
    path, sessionName, draft,
    expiresAt: Date.now() + vetoMs,
    timer,
  })
}

function cancelVeto(path: string): PendingVeto | undefined {
  const v = pendingVetos.get(path)
  if (v) {
    clearTimeout(v.timer)
    pendingVetos.delete(path)
  }
  return v
}

export function getPendingVeto(path: string): PendingVeto | undefined {
  return pendingVetos.get(path)
}
```

- [ ] **Step 2: Modify the autopilot result handler in `daemon.ts`**

Replace the `status === 'answered'` branch from Task 8 with:

```ts
        if (result.status === 'answered') {
          const vetoMs = ap.vetoWindowMs ?? autopilotDefaults.vetoWindowMs
          if (vetoMs > 0) {
            // Send draft to user, start veto timer
            telegramFrontend?.deliverAutopilotDraft(session.name, result.answer, vetoMs)
            webFrontend?.deliverAutopilotDraft(path, session.name, result.answer, vetoMs)
            scheduleVeto(path, session.name, result.answer, vetoMs, () => {
              socketServer.sendToSession(path, {
                type: 'channel_message',
                content: result.answer,
                meta: { source: 'autopilot', frontend: 'web' },
              })
              telegramFrontend?.deliverToUser(session.name, `🤖 Autopilot sent: ${result.answer}`)
              webFrontend?.deliverToUser(session.name, `🤖 Autopilot sent: ${result.answer}`)
            })
          } else {
            // Immediate send
            socketServer.sendToSession(path, {
              type: 'channel_message',
              content: result.answer,
              meta: { source: 'autopilot', frontend: 'web' },
            })
            telegramFrontend?.deliverToUser(session.name, `🤖 Autopilot answered: ${result.answer}`)
            webFrontend?.deliverToUser(session.name, `🤖 Autopilot answered: ${result.answer}`)
          }
        }
```

- [ ] **Step 3: Add `/veto` endpoints/commands**

In `src/frontends/web.ts`, add a POST `/api/autopilot/veto` endpoint:

```ts
    if (url.pathname === '/api/autopilot/veto' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const name = String(body.name ?? '')
      const action = String(body.action ?? '')  // 'send' | 'cancel' | 'edit'
      const edited = body.edited ? String(body.edited) : undefined
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response('not found', { status: 404 })
      const { cancelVeto, pendingVetos: _pv } = await import('../daemon')  // shape depends on actual export
      const v = cancelVeto(path)
      if (!v) return new Response(JSON.stringify({ ok: false, reason: 'no pending' }))
      if (action === 'send' || action === 'edit') {
        const content = action === 'edit' && edited ? edited : v.draft
        this.deps.socketServer.sendToSession(path, {
          type: 'channel_message',
          content,
          meta: { source: 'autopilot', frontend: 'web' },
        })
      }
      // 'cancel' just clears the veto and does nothing else — normal user reply takes over
      return new Response(JSON.stringify({ ok: true }))
    }
```

Note: the import-from-daemon path is awkward. Better approach is to wire `cancelVeto` as a dependency through the frontend constructor. If this plan is being executed by a subagent, refactor: expose `cancelVeto` on a shared controller passed into both `WebFrontend` and `TelegramFrontend`.

For Telegram, add buttons to `deliverAutopilotDraft` using grammy's `InlineKeyboard`:

```ts
  async deliverAutopilotDraft(sessionName: string, draft: string, vetoMs: number): Promise<void> {
    const chatId = /* first allowlisted user */ this.allowFrom[0]
    if (!chatId) return
    const { InlineKeyboard } = await import('grammy')
    const kb = new InlineKeyboard()
      .text('✅ Send', `ap-send:${sessionName}`)
      .text('❌ Cancel', `ap-cancel:${sessionName}`)
    await this.bot.api.sendMessage(chatId,
      `🤖 Autopilot draft for ${sessionName} (${Math.round(vetoMs/1000)}s veto):\n\n${draft}`,
      { reply_markup: kb })
  }
```

And a callback handler:

```ts
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      const m = /^ap-(send|cancel):(.+)$/.exec(data)
      if (!m) return
      const [_, action, name] = m
      const path = this.deps.registry.findByName(name!)
      if (!path) { await ctx.answerCallbackQuery('session gone'); return }
      const v = cancelVeto(path)
      if (!v) { await ctx.answerCallbackQuery('no pending veto'); return }
      if (action === 'send') {
        this.deps.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: v.draft,
          meta: { source: 'autopilot', frontend: 'telegram' },
        })
        await ctx.answerCallbackQuery('sent')
      } else {
        await ctx.answerCallbackQuery('cancelled')
      }
    })
```

- [ ] **Step 4: Add minimal web UI for the veto card**

In `src/frontends/web-client.html`, render the pending veto on top of the chat:

```js
// Subscribe to a new WebSocket event 'autopilot:draft' that server pushes.
// Server sends: { sessionName, draft, expiresAt }
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'autopilot:draft') renderVetoCard(msg);
});

function renderVetoCard({ sessionName, draft, expiresAt }) {
  const card = document.createElement('div');
  card.className = 'ap-veto';
  card.innerHTML = `
    <div>🤖 Autopilot draft for <b>${escapeHtml(sessionName)}</b>:</div>
    <textarea class="ap-draft">${escapeHtml(draft)}</textarea>
    <div>
      <button data-action="send">✅ Send</button>
      <button data-action="edit">✏️ Edit & send</button>
      <button data-action="cancel">❌ Cancel</button>
      <span class="ap-countdown"></span>
    </div>`;
  card.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const edited = action === 'edit' ? card.querySelector('.ap-draft').value : undefined;
      await fetch('/api/autopilot/veto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionName, action, edited }),
      });
      card.remove();
    });
  });
  document.body.prepend(card);
  // Countdown display
  const countdownEl = card.querySelector('.ap-countdown');
  const tick = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    countdownEl.textContent = left > 0 ? `(${left}s)` : '(sent)';
    if (left <= 0) { card.remove(); return; }
    setTimeout(tick, 1000);
  };
  tick();
}
```

Ensure the WebFrontend pushes a `{ type: 'autopilot:draft', ...}` message via its existing WebSocket broadcast when `deliverAutopilotDraft` is called.

- [ ] **Step 5: Manual test end-to-end**

1. Start daemon: `tmux new-session -d -s hub-daemon-test "bun run src/daemon.ts"`
2. Open web UI, spawn a session
3. Toggle Autopilot: ON
4. In the spawned Claude session, type a prompt that asks a question (e.g. "Should I use Bun or Node?")
5. Observe: a veto card appears in the web UI with the draft answer and a countdown
6. Click ✅ Send — verify the channel_message is injected and Claude resumes

- [ ] **Step 6: Commit**

```bash
git add src/autopilot.ts src/daemon.ts src/frontends/web.ts src/frontends/web-client.html src/frontends/telegram.ts
git commit -m "feat(autopilot): veto window — draft to user with Send/Edit/Cancel before auto-send"
```

---

## Task 14: Feature-flag probe on toggle-on

**Files:**
- Modify: `src/autopilot.ts`
- Modify: `src/frontends/web.ts`, `src/frontends/telegram.ts`, `src/cli.ts`

- [ ] **Step 1: Add a `probe` method to AutopilotRunner**

In `src/autopilot.ts`, add:

```ts
  async probe(sessionName: string): Promise<{ ok: boolean; reason?: string }> {
    await this.sm.sendKeysRaw(sessionName, '/btw 1+1', true)
    const deadline = Date.now() + 15_000
    let pane = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      const p = await this.sm.capturePane(sessionName, 100)
      if (p && isOverlaySettled(p)) { pane = p; break }
    }
    await this.sm.sendEscape(sessionName)
    if (!pane) return { ok: false, reason: '/btw did not respond within 15s — feature flag may be off' }
    const parsed = parseBtwAnswer(pane)
    if (parsed.status !== 'ok') return { ok: false, reason: '/btw overlay did not parse — feature flag may be off' }
    if (!/\b2\b/.test(parsed.answer)) return { ok: false, reason: `/btw returned unexpected answer: ${parsed.answer}` }
    return { ok: true }
  }
```

- [ ] **Step 2: Probe before enabling**

In each frontend's autopilot-on handler (web, telegram, cli), run the probe before setting `enabled: true`:

```ts
// Pseudocode — adapt per frontend
if (enabled) {
  const probeResult = await autopilotRunner.probe(`hub-${name}`)
  if (!probeResult.ok) {
    // Refuse to enable; tell the user
    return respondWithError(`Autopilot unavailable on this Claude Code build: ${probeResult.reason}`)
  }
}
// proceed to setAutopilot(...)
```

- [ ] **Step 3: Add a test for probe**

Append to `tests/autopilot.test.ts`:

```ts
test('probe returns ok when /btw answers "2"', async () => {
  const pane = `
❯ /btw 1+1
  /btw 1+1
    2
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
  const sm = new FakeScreenManager(['', pane])
  const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
  const r = await runner.probe('hub-x')
  expect(r.ok).toBe(true)
})

test('probe returns not-ok when /btw never settles', async () => {
  const sm = new FakeScreenManager(['', '', '', ''])
  const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 50 })
  const r = await runner.probe('hub-x')
  expect(r.ok).toBe(false)
})
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot.ts src/frontends/web.ts src/frontends/telegram.ts src/cli.ts tests/autopilot.test.ts
git commit -m "feat(autopilot): probe /btw before enabling; refuse if unavailable"
```

---

## Task 15: Docs + skill

**Files:**
- Modify: `CLAUDE.md` — add autopilot to the command list, frontends sections, key design decisions
- Modify: `README.md` — add a short "Autopilot mode" section
- Create: `skills/autopilot/SKILL.md` — a starter skill describing autopilot.md format

- [ ] **Step 1: Update CLAUDE.md**

Add to Telegram commands list:
```
- `/autopilot <name> [on|off]` — toggle the proxy-answer autopilot mode
```

Add to CLI commands list:
```
autopilot
```

Add to "Key Design Decisions":
```
- **Autopilot mode** — per-session opt-in. Daemon watches outgoing `reply` tool calls; if autopilot is on, fires `/btw <wrapped-question>` via `tmux send-keys`, captures the answer from the Ink overlay, and injects it back into the same session via `notifications/claude/channel`. Risk-keyword filter + `ESCALATE:` token drop-through to the user on Telegram/Web. Optional veto window shows draft to user with Send/Edit/Cancel buttons before auto-sending.
```

- [ ] **Step 2: Create `skills/autopilot/SKILL.md`**

```markdown
---
name: autopilot
description: Set up autopilot mode for a operant project. Use when the user wants to configure how their project answers questions on their behalf — specifically which preferences the proxy should honor.
---

# Autopilot Mode

When a operant session is in autopilot mode, the daemon fires `/btw` inside
the session on every user-facing question. The proxy answers using the
session's own conversation context plus the preferences in `autopilot.md`.

## Set up `autopilot.md`

Create `autopilot.md` in your project root. Use markdown freeform — the proxy
will read it verbatim. A good starter:

\`\`\`markdown
# Preferences for autopilot

- Prefer Bun over Node
- Prefer minimal dependencies; avoid adding new ones unless unavoidable
- Always TDD: test first, then implement
- Prefer explicit over clever
- For UI decisions, pick the simpler / more-accessible option
- Never add analytics / tracking without asking
\`\`\`

## Enable autopilot

- **Telegram:** `/autopilot <session-name> on`
- **Web:** click the "Autopilot" toggle in the session row
- **CLI:** `bun run src/cli.ts autopilot <session-name> on`

## What gets escalated

The proxy will skip the /btw and ping you directly when:

- Your question contains a risk keyword (`delete`, `force push`, `production`, `billing`, `api key`, etc.)
- The proxy answers `ESCALATE: <reason>` (for irreversible or out-of-scope choices)
- The /btw overlay fails to parse or times out
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md skills/autopilot/SKILL.md
git commit -m "docs(autopilot): CLAUDE.md + README + starter skill"
```

---

## Self-Review Checklist (run after writing plan — now)

**1. Spec coverage check:**

| Spec section | Covered by |
|---|---|
| User experience: toggle per session | Tasks 10/11/12 (web/telegram/cli) |
| Session list badges (🤖 / 🟡 / 🟢) | Tasks 11, 12 (web/telegram) |
| /btw trigger via tmux send-keys | Task 4 (screen-manager helpers) + Task 7 (runner) |
| Overlay capture + parse | Task 5 (parser) |
| ESCALATE token + risk-keyword pre-filter | Task 6 (risk) + Task 7 (runner integration) |
| Answer routed back via existing channel pipe | Task 8 (daemon wiring) |
| autopilot.md project preferences | Task 8 (loadProjectPreferences) |
| Global ~/.claude/autopilot.md fallback | Task 8 (second candidate path) |
| Feature-flag probe on enable | Task 14 |
| Veto window (on by default, configurable) | Task 13 |
| Per-session `vetoWindowMs`, `btwTimeoutMs`, `maxDurationMinutes` | Tasks 1, 3 (types + persistence); Task 13 uses vetoWindowMs |
| `autopilot.riskOverride` opt-out | Task 1 (types) + Task 7 (runner) |
| Hub-level defaults in config.json | Tasks 1, 2 |
| Trust mode auto-approve while on | Not explicitly in any task — **gap, needs addition** |
| `maxDurationMinutes` checkpoint | Not explicitly in any task — **gap, needs addition** |

**2. Placeholder scan:** none found — every step has concrete code.

**3. Type consistency:** `AutopilotConfig` / `AutopilotDefaults` / `AutopilotRuntimeState` naming — I defined `AutopilotConfig` and `AutopilotDefaults` in Task 1 but mentioned `AutopilotRuntimeState` in the file-structure summary and never created it. Remove `AutopilotRuntimeState` from the file-structure summary (fixing inline below).

**4. Gaps identified — adding Task 16 to close them.**

---

## Task 16: Close self-review gaps — trust-auto-for-duration + duration cap

**Files:**
- Modify: `src/session-registry.ts`, `src/daemon.ts`

- [ ] **Step 1: When autopilot is turned on, bump trust to `auto` and remember the prior trust**

In `SessionConfig` (add to Task 1's types update, or as a follow-on edit to `types.ts`):
```ts
// inside AutopilotConfig
  priorTrust?: TrustLevel  // captures the session's trust before autopilot enabled it
```

In the handler that sets autopilot enabled (in web.ts, telegram.ts, cli.ts — via a shared controller), do:
```ts
if (enabled) {
  const current = registry.get(path)
  const prior = current?.trust
  registry.setTrust(path, 'auto')
  registry.setAutopilot(path, {
    ...registry.getAutopilot(path),
    enabled: true,
    priorTrust: prior,
  })
} else {
  const ap = registry.getAutopilot(path)
  if (ap?.priorTrust) registry.setTrust(path, ap.priorTrust)
  registry.setAutopilot(path, { ...ap, enabled: false })
}
```

- [ ] **Step 2: Duration-cap checkpoint**

In the same `tool_call` reply handler in daemon.ts, just before firing autopilot:

```ts
if (ap?.enabled && ap.startedAt) {
  const maxMin = ap.maxDurationMinutes ?? autopilotDefaults.maxDurationMinutes
  if (Date.now() - ap.startedAt > maxMin * 60_000) {
    // Escalate with a "continue?" prompt instead of firing /btw
    const prompt = `Autopilot has been running on "${session.name}" for ${maxMin}+ min. Reply "/autopilot ${session.name} on" to extend, or just answer the question directly to take over.`
    telegramFrontend?.deliverToUser(session.name, `🟡 ${prompt}`)
    webFrontend?.deliverToUser(session.name, `🟡 ${prompt}`)
    // Clear enabled so autopilot doesn't keep firing
    registry.setAutopilot(path, { ...ap, enabled: false, priorTrust: undefined })
    if (ap.priorTrust) registry.setTrust(path, ap.priorTrust)
    return
  }
}
```

And when toggling on, set `startedAt: Date.now()`.

- [ ] **Step 3: Write tests**

Add to `tests/session-registry.test.ts`:

```ts
test('setAutopilot + setTrust interplay: turning off restores prior trust', () => {
  const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg.register('/p:0')
  expect(reg.get('/p:0')?.trust).toBe('ask')
  const prior = reg.get('/p:0')?.trust
  reg.setTrust('/p:0', 'auto')
  reg.setAutopilot('/p:0', { enabled: true, priorTrust: prior })
  expect(reg.get('/p:0')?.trust).toBe('auto')
  const ap = reg.getAutopilot('/p:0')
  reg.setAutopilot('/p:0', { ...ap, enabled: false })
  if (ap?.priorTrust) reg.setTrust('/p:0', ap.priorTrust)
  expect(reg.get('/p:0')?.trust).toBe('ask')
})
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/session-registry.ts src/daemon.ts tests/session-registry.test.ts
git commit -m "feat(autopilot): bump trust→auto on enable; maxDurationMinutes checkpoint"
```

---

## Wrap-up — final verification

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS all (parser, risk, runner, session-registry, config, screen-manager, daemon integration, cli, plus existing tests).

- [ ] **Step 2: Start daemon and exercise end-to-end**

In a test tmux session:
```bash
tmux new-session -d -s hub-test "bun run src/daemon.ts"
```

1. Open web UI, spawn a session in a test folder
2. Put this in the folder's `autopilot.md`:
   ```
   - Prefer Bun
   - Always TDD
   ```
3. Toggle Autopilot: ON — verify probe runs and toggle succeeds
4. Send a message to the session: "Should I use Bun or Node for this project?"
5. Verify:
   - Claude asks a question, sends a reply
   - 🤖 badge appears on the session
   - Veto card appears with the draft answer (should pick Bun)
   - Countdown runs; clicking Send injects into the session; Claude resumes
   - Risk-keyword test: send "Should I DELETE the backup folder?" — verify 🟡 escalate flow
6. Toggle Autopilot: OFF — verify trust is restored to whatever it was before

- [ ] **Step 3: Final commit (if anything needed)**

```bash
git status
git add <any-docs-or-fixes>
git commit -m "chore(autopilot): final pass"
```

- [ ] **Step 4: Offer review**

Spec: `docs/superpowers/specs/2026-04-24-autopilot-mode-design.md`
Plan: `docs/superpowers/plans/2026-04-24-autopilot-mode.md`

Recommend the user runs `/ultrareview` on the branch once all tasks are committed.
