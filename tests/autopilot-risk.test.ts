import { describe, test, expect } from 'bun:test'
import { hasRiskKeyword, wrapQuestion, isEscalateAnswer } from '../src/autopilot-risk'

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
    // The prefs *block heading* must not appear; passing mentions of
    // autopilot.md inside the constraint copy are fine.
    expect(wrapped).not.toContain('User preferences from autopilot.md:')
  })

  test('instructs the proxy to reply in English only', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped).toMatch(/english only/i)
  })

  test('instructs the proxy to avoid emojis', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toMatch(/emoji|pictographic/)
  })

  test('instructs the proxy to be descriptive (not terse)', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toMatch(/descriptive|reasoning|rationale/)
  })

  test('instructs the proxy to follow best-practice / industry standards', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toMatch(/best.practice|industry.standard|canonical|convention/)
  })

  test('instructs the proxy to always try to improve', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toMatch(/improve|maintainability/)
  })

  test('instructs the proxy never to pick the laziest option', () => {
    const wrapped = wrapQuestion('pick one', '')
    expect(wrapped.toLowerCase()).toMatch(/laz|cheapest|good enough/)
  })
})

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
