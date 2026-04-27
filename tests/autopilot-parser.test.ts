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

	test('multi-paragraph answer with blank lines between paragraphs is preserved (real-world bug)', () => {
		// The autopilot prompt explicitly asks for multi-paragraph descriptive
		// answers. The original walker stopped at the first blank line, so only
		// the LAST paragraph reached Claude — silently truncating reasoning.
		const pane = `
  /btw You are acting as the user's delegate…

    Go with B for consistency and ii for refresh, so the formal answer is B plus ii.

    The consistency choice is B because it is the canonical pattern for an ecommerce engine.
    All run off the catalog projection so the customer-facing experience stays fast.

    The refresh choice is ii because pull-plus-push deltas is the standard CQRS pattern.

  ↑/↓ to scroll · f to fork · x to clear history · Esc to dismiss
`
		const r = parseBtwAnswer(pane)
		expect(r.status).toBe('ok')
		if (r.status === 'ok') {
			expect(r.answer).toContain('Go with B for consistency')
			expect(r.answer).toContain('canonical pattern')
			expect(r.answer).toContain('pull-plus-push deltas')
		}
	})

	test('paragraphs are joined with a blank line so reasoning stays readable', () => {
		const pane = `
  /btw q

    First paragraph.

    Second paragraph.

  ↑/↓ to scroll · Esc to dismiss
`
		const r = parseBtwAnswer(pane)
		expect(r.status).toBe('ok')
		if (r.status === 'ok') {
			expect(r.answer).toBe('First paragraph.\n\nSecond paragraph.')
		}
	})

	test('walks up only as far as the last /btw history line — does not bleed into older /btw answers', () => {
		const pane = `
  /btw old question

    Old answer that should NOT appear.

  /btw new question

    New answer.

  ↑/↓ to scroll · Esc to dismiss
`
		const r = parseBtwAnswer(pane)
		expect(r.status).toBe('ok')
		if (r.status === 'ok') {
			expect(r.answer).toBe('New answer.')
			expect(r.answer).not.toContain('Old answer')
		}
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

	// Real-world bug: when the parent Claude session is busy with another task,
	// "esc to interrupt" appears in the MAIN pane status line BELOW the /btw
	// overlay footer. The spinner check must only consider the overlay region
	// (everything BEFORE the footer), otherwise the probe never sees a settled
	// overlay even though /btw answered correctly.
	test('true when overlay is settled, even if parent pane shows "esc to interrupt" below the footer', () => {
		const pane = `
  /btw 1+1

    2

  ↑/↓ to scroll · f to fork · Esc to dismiss

──────────────────────────────────────────
❯
──────────────────────────────────────────
  esc to interrupt                                    ◉ xhigh · /effort
`
		expect(isOverlaySettled(pane)).toBe(true)
	})

	test('parseBtwAnswer succeeds when parent pane has busy spinner below the footer', () => {
		const pane = `
  /btw 1+1

    2

  ↑/↓ to scroll · f to fork · Esc to dismiss

──────────────────────────────────────────
❯
──────────────────────────────────────────
  esc to interrupt                                    ◉ xhigh · /effort
`
		const r = parseBtwAnswer(pane)
		expect(r.status).toBe('ok')
		if (r.status === 'ok') expect(r.answer).toBe('2')
	})

	test('still false when an overlay-region spinner is present (Answering…)', () => {
		const pane = `
  /btw 1+1

    ✢ Answering…

  Esc to dismiss
`
		expect(isOverlaySettled(pane)).toBe(false)
	})
})
