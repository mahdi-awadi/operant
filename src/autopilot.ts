// src/autopilot.ts
// Orchestrates programmatic /btw via the ScreenManager: fire, poll, parse, dismiss.

import { ScreenManager } from './screen-manager'
import { parseBtwAnswer, isOverlaySettled } from './autopilot-parser'
import { hasRiskKeyword, isEscalateAnswer } from './autopilot-risk'

export type AutopilotResult =
  | { status: 'answered'; answer: string; pane?: string }
  | { status: 'escalate'; reason: string; pane?: string }
  | { status: 'parse_error'; pane?: string }
  | { status: 'timeout'; pane?: string }

export type RunBtwOptions = {
  rawQuestion?: string      // the original question from Claude, used for risk filter
  riskKeywords?: readonly string[]
  riskOverride?: boolean    // bypass risk check
}

export type AutopilotRunnerOpts = {
  screenManager: Pick<ScreenManager, 'sendKeysRaw' | 'capturePane' | 'sendEscape' | 'sendUpArrows'>
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
    // Flatten newlines first — tmux treats \n as Enter, which would submit the
    // slash command after the first line only.
    const singleLine = wrappedQuestion.replace(/\s*\n+\s*/g, ' ').trim()
    // Claude Code's input treats a burst of ~800 chars as a "paste block" and
    // the paste captures the trailing Enter, so the /btw never fires. Send the
    // text first (no Enter), then a separate Enter as its own keystroke.
    await this.sm.sendKeysRaw(sessionName, `/btw ${singleLine}`, false)
    await new Promise(r => setTimeout(r, 150))
    await this.sm.sendKeysRaw(sessionName, '', true)

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

    // 3b. Scroll the /btw overlay to its TOP before final capture. /btw renders
    // inline with the rest of Claude's UI in a small viewport — long answers
    // scroll within /btw, and the default position is at the BOTTOM (tail of
    // the answer). The opening (with the actual decision and key reasoning) is
    // off-screen until we scroll up. Send a generous batch of Up arrows so the
    // viewport is at the very beginning, then capture.
    if (finalPane) {
      await this.sm.sendUpArrows(sessionName, 60)
      await new Promise(r => setTimeout(r, 200))
      const top = await this.sm.capturePane(sessionName, 200)
      if (top && isOverlaySettled(top)) finalPane = top
    }

    // 4. Dismiss overlay regardless of outcome so the session stays usable.
    await this.sm.sendEscape(sessionName)

    if (!finalPane) return { status: 'timeout' }

    // 5. Parse.
    const parsed = parseBtwAnswer(finalPane)
    if (parsed.status === 'parse_error') return { status: 'parse_error', pane: finalPane }
    if (parsed.status === 'not_ready') return { status: 'timeout', pane: finalPane }

    // 6. Check for ESCALATE token.
    const esc = isEscalateAnswer(parsed.answer)
    if (esc.escalated) return { status: 'escalate', reason: esc.reason ?? 'proxy escalated', pane: finalPane }

    return { status: 'answered', answer: parsed.answer, pane: finalPane }
  }

  // Fast (~50ms) pane-only check used to decide whether to enable autopilot at
  // all. Catches obvious failures (tmux session gone, session blocked on a
  // permission prompt) without paying the multi-second cost of a /btw round
  // trip. The /btw confirmation is fired separately, after the toggle returns.
  async quickProbe(sessionName: string): Promise<{ ok: boolean; reason?: string }> {
    const pane = await this.sm.capturePane(sessionName, 50)
    if (!pane) return { ok: false, reason: `tmux session "${sessionName}" not found or not running` }
    // A permission prompt steals all keystrokes — /btw text would land in the
    // 1/2/3 menu instead of opening the side-question overlay. Detect by the
    // canonical Claude Code prompt header + the `❯ 1.` numbered selection.
    if (/Do you want to proceed\?/.test(pane) && /^\s*❯\s*1\./m.test(pane)) {
      return { ok: false, reason: 'session is at a permission prompt — answer it before enabling autopilot' }
    }
    return { ok: true }
  }

  async probe(sessionName: string, probeTimeoutMs: number = 20_000): Promise<{ ok: boolean; reason?: string }> {
    // Semantic probe: tell the session it's in autopilot and ask for a single-
    // word ack. More informative than `1+1` — confirms the round-trip AND
    // signals to Claude what mode it's in.
    const question = 'You are now in autopilot mode. Reply with only the single word "ready" to confirm side questions are reachable.'
    // Mirror runBtw: send the text first (no Enter), wait, then send Enter as a
    // separate keystroke so Claude Code's paste-detection cannot capture it.
    await this.sm.sendKeysRaw(sessionName, `/btw ${question}`, false)
    await new Promise(r => setTimeout(r, 150))
    await this.sm.sendKeysRaw(sessionName, '', true)
    const deadline = Date.now() + probeTimeoutMs
    let pane = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs))
      const p = await this.sm.capturePane(sessionName, 100)
      if (p && isOverlaySettled(p)) { pane = p; break }
    }
    await this.sm.sendEscape(sessionName)
    const secs = Math.max(1, Math.ceil(probeTimeoutMs / 1000))
    if (!pane) return { ok: false, reason: `/btw did not respond within ${secs}s — session may be busy or stuck on a permission prompt` }
    const parsed = parseBtwAnswer(pane)
    if (parsed.status !== 'ok') return { ok: false, reason: '/btw overlay did not parse' }
    if (!/\bready\b/i.test(parsed.answer)) return { ok: false, reason: `/btw returned unexpected answer: ${parsed.answer}` }
    return { ok: true }
  }
}
