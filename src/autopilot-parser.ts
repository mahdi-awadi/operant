// src/autopilot-parser.ts
// Pure parsing of the Claude Code /btw overlay out of a tmux pane capture.

export type ParseResult =
	| { status: 'ok'; answer: string }
	| { status: 'not_ready' }           // overlay still rendering (spinner or no footer)
	| { status: 'parse_error' }          // footer present but answer block missing

// The Esc-to-dismiss line is the stable footer signature for a settled /btw overlay.
const FOOTER_RE = /↑\/↓ to scroll.*Esc to dismiss/
const SPINNER_RES = [
	/✻\s*Hatching…/,
	/Crunching…/,
	/Thinking…/,
	/esc to interrupt/,
]

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '')
}

export function isOverlaySettled(pane: string): boolean {
	const clean = stripAnsi(pane)
	if (!FOOTER_RE.test(clean)) return false
	if (SPINNER_RES.some(re => re.test(clean))) return false
	return true
}

export function parseBtwAnswer(pane: string): ParseResult {
	const clean = stripAnsi(pane)
	if (SPINNER_RES.some(re => re.test(clean))) return { status: 'not_ready' }
	const lines = clean.split('\n')
	const footerIdx = lines.findIndex(l => FOOTER_RE.test(l))
	if (footerIdx === -1) return { status: 'not_ready' }

	// Walk up from the footer, skipping blank lines, to find the bottom-most
	// contiguous block of 4-space-indented lines that isn't "/btw" history.
	let i = footerIdx - 1
	while (i >= 0 && lines[i]!.trim() === '') i--
	const answerLines: string[] = []
	while (i >= 0 && /^ {4}[^ ]/.test(lines[i]!) && !/^\s*\/btw\b/.test(lines[i]!)) {
		answerLines.unshift(lines[i]!.slice(4))
		i--
	}
	if (answerLines.length === 0) return { status: 'parse_error' }
	return { status: 'ok', answer: answerLines.join(' ').trim() }
}
