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
  async sendUpArrows(_s: string, _n: number) {}
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
    const result = await runner.runBtw('operant-x', 'wrapped question text')
    expect(result.status).toBe('answered')
    if (result.status === 'answered') {
      expect(result.answer).toContain('Bun')
    }
    expect(sm.sentKeys[0]?.text).toContain('/btw wrapped question text')
    expect(sm.sentKeys[0]?.withEnter).toBe(false)  // text first, no Enter
    expect(sm.sentKeys[1]?.text).toBe('')          // then a standalone Enter
    expect(sm.sentKeys[1]?.withEnter).toBe(true)
    expect(sm.escapes).toBe(1)
  })

  test('timeout path: returns timeout when pane never settles', async () => {
    const sm = new FakeScreenManager(['', '', '', ''])
    const runner = new AutopilotRunner({
      screenManager: sm as any,
      pollIntervalMs: 5,
      btwTimeoutMs: 50,
    })
    const result = await runner.runBtw('operant-x', 'q')
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
    const result = await runner.runBtw('operant-x', 'q')
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
    const result = await runner.runBtw('operant-x', 'wrapped q', {
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
    const result = await runner.runBtw('operant-x', 'q')
    expect(result.status).toBe('escalate')
    if (result.status === 'escalate') expect(result.reason).toContain('production')
  })
})

describe('AutopilotRunner.probe', () => {
  test('probe returns ok when /btw answers "ready"', async () => {
    const pane = `
❯ /btw You are now in autopilot mode…
  /btw You are now in autopilot mode…
    ready
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
    const r = await runner.probe('operant-x')
    expect(r.ok).toBe(true)
  })

  test('probe returns not-ok when /btw never settles', async () => {
    const sm = new FakeScreenManager(['', '', '', ''])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5 })
    const r = await runner.probe('operant-x', 50)
    expect(r.ok).toBe(false)
  })

  test('probe returns not-ok when answer does not contain "ready"', async () => {
    const pane = `
❯ /btw You are now in autopilot mode…
  /btw You are now in autopilot mode…
    banana
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
    const r = await runner.probe('operant-x')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('banana')
  })

  test('probe respects the passed probeTimeoutMs', async () => {
    const sm = new FakeScreenManager([])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5 })
    const start = Date.now()
    await runner.probe('operant-x', 80)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(300) // well under 15s
  })

  test('probe sends /btw text first, then a separate Enter (paste-detection parity)', async () => {
    const pane = `
❯ /btw You are now in autopilot mode…
  /btw You are now in autopilot mode…
    ready
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
    const r = await runner.probe('operant-x', 500)
    expect(r.ok).toBe(true)
    expect(sm.sentKeys[0]?.text).toMatch(/^\/btw /)
    expect(sm.sentKeys[0]?.withEnter).toBe(false)
    expect(sm.sentKeys[1]?.text).toBe('')
    expect(sm.sentKeys[1]?.withEnter).toBe(true)
  })

  test('probe timeout error mentions the actual configured timeout, not a hardcoded value', async () => {
    const sm = new FakeScreenManager([])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5 })
    const r = await runner.probe('operant-x', 2_000)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('2s')
    expect(r.reason).not.toContain('15s')
  })

  test('probe error reasons no longer mention "feature flag may be off"', async () => {
    const sm = new FakeScreenManager([])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5 })
    const r = await runner.probe('operant-x', 50)
    expect(r.ok).toBe(false)
    expect(r.reason ?? '').not.toMatch(/feature flag may be off/i)
  })
})

// quickProbe is the synchronous, ~50ms pane-only check used to decide whether
// to enable autopilot at all. It does NOT fire /btw — that runs in the
// background after the toggle returns, via runner.probe().
class StaticScreenManager {
  constructor(private pane: string) {}
  async capturePane(_s: string, _n?: number) { return this.pane }
  async sendKeysRaw() {}
  async sendEscape() {}
  async sendUpArrows() {}
}

describe('AutopilotRunner.quickProbe', () => {
  test('returns ok when pane shows the Claude idle prompt', async () => {
    const idle = `
────────────────────────────────────
❯
────────────────────────────────────
  ? for shortcuts
`
    const runner = new AutopilotRunner({ screenManager: new StaticScreenManager(idle) as any })
    const r = await runner.quickProbe('operant-x')
    expect(r.ok).toBe(true)
  })

  test('returns ok when pane shows Claude busy — /btw can still queue', async () => {
    const busy = `
❯ doing some long task
  ✻ Hatching… (15s)
  esc to interrupt                        ◉ xhigh
`
    const runner = new AutopilotRunner({ screenManager: new StaticScreenManager(busy) as any })
    const r = await runner.quickProbe('operant-x')
    expect(r.ok).toBe(true)
  })

  test('returns not-ok when pane is empty (tmux session not running)', async () => {
    const runner = new AutopilotRunner({ screenManager: new StaticScreenManager('') as any })
    const r = await runner.quickProbe('operant-missing')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found|not running/i)
  })

  test('returns not-ok when pane is at a permission prompt (1. Yes / 2. … / 3. No)', async () => {
    const blocked = `
  operant - reply(text: "...") (MCP)

  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again for operant - reply commands in /home/sap
    3. No

  Esc to cancel · Tab to amend
`
    const runner = new AutopilotRunner({ screenManager: new StaticScreenManager(blocked) as any })
    const r = await runner.quickProbe('operant-x')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/permission prompt/i)
  })
})
