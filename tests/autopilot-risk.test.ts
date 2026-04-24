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
    expect(wrapped).not.toContain('autopilot.md')
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
