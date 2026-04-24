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
