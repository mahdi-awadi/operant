import { describe, test, expect } from 'bun:test'
import { AutopilotRunner } from '../src/autopilot'
import { wrapQuestion } from '../src/autopilot-risk'

// Smoke test of the wiring shape: wrapQuestion + AutopilotRunner produce a
// string that could be safely passed as channel_message.content.
class FakeScreenManager {
  sent: string[] = []
  escapes = 0
  private panes: string[]
  constructor(panes: string[]) { this.panes = [...panes] }
  async sendKeysRaw(_s: string, text: string, _enter: boolean) { this.sent.push(text) }
  async capturePane(_s: string, _n?: number): Promise<string> { return this.panes.shift() ?? '' }
  async sendEscape(_s: string) { this.escapes++ }
  async sendUpArrows(_s: string, _n: number) {}
}

describe('autopilot daemon integration shape', () => {
  test('wrapQuestion → runBtw → answered returns a route-able string', async () => {
    const wrapped = wrapQuestion('Pick Node or Bun?', '- Prefer Bun')
    const pane = `
❯ /btw ${wrapped}
  /btw ${wrapped}
    Bun.
  ↑/↓ to scroll · f to fork · Esc to dismiss
`
    const sm = new FakeScreenManager(['', pane])
    const runner = new AutopilotRunner({ screenManager: sm as any, pollIntervalMs: 5, btwTimeoutMs: 500 })
    const result = await runner.runBtw('operant-x', wrapped, {
      rawQuestion: 'Pick Node or Bun?',
      riskKeywords: ['production'],
    })
    expect(result.status).toBe('answered')
    if (result.status === 'answered') {
      expect(result.answer).toBe('Bun.')
      expect(result.answer.length).toBeGreaterThan(0)
    }
  })
})
