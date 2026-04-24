// src/autopilot-risk.ts
// Risk-keyword filter + wrapped-question builder + ESCALATE detector.

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
