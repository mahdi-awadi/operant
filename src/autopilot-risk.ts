// src/autopilot-risk.ts
// Risk-keyword filter + wrapped-question builder + ESCALATE detector.

export function hasRiskKeyword(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false
  const haystack = text.toLowerCase()
  return keywords.some(kw => haystack.includes(kw.toLowerCase()))
}

const DEFAULT_CONSTRAINT_BLOCK = [
  'Constraints:',
  '- Reply in ENGLISH ONLY. Never use any other language, even if the question',
  '  or preferences contain it.',
  '- Do NOT use emojis or pictographic symbols anywhere in the reply (no 🚀, ✅,',
  '  ❌, 🟢, 🤖, etc.). Plain text and standard punctuation only.',
  '- Be decisive: pick one option clearly.',
  '- Be descriptive but concise: explain WHICH option you chose and WHY in',
  '  concrete terms, citing the project context, the autopilot.md preferences,',
  '  and any prior decisions you can see in the conversation. State the',
  '  rationale in full sentences. The user wants reasoning, not a one-word',
  '  answer — but keep the WHOLE reply under 600 characters / 100 words so',
  '  it fits the side-question display without scrolling. Cite the key',
  '  reasons, not exhaustive analysis.',
  '- Default to the BEST-PRACTICE / industry-standard approach. When choices',
  '  pit a quick hack against a clean, well-established convention, pick the',
  '  convention even if it costs more work upfront. Optimize for long-term',
  '  maintainability, readability, and consistency with how the wider',
  '  community / language / framework solves the same problem.',
  '- Always try to improve. If neither option is ideal but one is closer to',
  '  the canonical solution, lean toward it. If the question presents two',
  '  weak options, briefly note a stronger improvement only when it is the',
  '  obvious standard practice (still pick A or B as the formal answer).',
  '- Never pick the cheapest, laziest, or "good enough" option just to ship',
  '  faster. Quality and correctness come first; speed is a tiebreaker.',
  '- If the choice is irreversible (delete data, force push, prod deploy,',
  '  add a paid service, change billing, remove auth), reply EXACTLY:',
  '  ESCALATE: <one-sentence reason>',
  '- If the choice is outside the project\'s scope, same: ESCALATE: <reason>',
  '- Do not propose a third option the user did not offer unless it is',
  '  obviously safer than A or B.',
  '- Answer as the user, not about the user. No preamble. No "Based on...".',
  '  Just state the decision and the reasoning.',
].join('\n')

// Optional per-session personality. The wrapper splices its system_prompt
// in place of the default constraint block — everything else (header,
// preferences, "Question from Claude:" trailer) stays the same.
export type WrapPersonality = {
  name: string
  systemPrompt: string
}

export function wrapQuestion(
  rawQuestion: string,
  preferencesMarkdown: string,
  personality?: WrapPersonality,
): string {
  const prefsBlock = preferencesMarkdown.trim().length > 0
    ? `\nUser preferences from autopilot.md:\n${preferencesMarkdown.trim()}\n`
    : ''
  const constraintBlock = personality
    ? personality.systemPrompt
    : DEFAULT_CONSTRAINT_BLOCK
  const personalityHeader = personality
    ? `\nPersonality: ${personality.name}\n`
    : ''
  return [
    'You are acting as the user\'s delegate for this autopilot session.',
    'Answer the following question as the user would, using this project\'s',
    'conversation context and the preferences below (if any).',
    personalityHeader,
    constraintBlock,
    prefsBlock,
    'Question from Claude:',
    rawQuestion,
  ].filter(s => s !== '').join('\n')
}

export function isEscalateAnswer(answer: string): { escalated: boolean; reason?: string } {
  const m = /^\s*ESCALATE\s*:?\s*(.*)$/im.exec(answer)
  if (!m) return { escalated: false }
  return { escalated: true, reason: m[1]?.trim() || 'proxy escalated (no reason given)' }
}
