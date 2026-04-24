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
