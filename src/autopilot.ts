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

  async probe(sessionName: string, probeTimeoutMs: number = 15_000): Promise<{ ok: boolean; reason?: string }> {
    await this.sm.sendKeysRaw(sessionName, '/btw 1+1', true)
    const deadline = Date.now() + probeTimeoutMs
    let pane = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs))
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
}
