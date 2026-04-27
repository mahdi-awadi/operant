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

// Only consider the lines BEFORE the footer when looking for a spinner.
// "esc to interrupt", "Thinking…", etc. can appear in the parent Claude's
// status line BELOW the /btw overlay, and would otherwise cause the overlay
// to look unsettled forever.
function overlayHasSpinner(clean: string): boolean {
	const lines = clean.split('\n')
	const footerIdx = lines.findIndex(l => FOOTER_RE.test(l))
	const overlayRegion = footerIdx === -1 ? clean : lines.slice(0, footerIdx).join('\n')
	return SPINNER_RES.some(re => re.test(overlayRegion))
}

export function isOverlaySettled(pane: string): boolean {
	const clean = stripAnsi(pane)
	if (!FOOTER_RE.test(clean)) return false
	if (overlayHasSpinner(clean)) return false
	return true
}

export function parseBtwAnswer(pane: string): ParseResult {
	const clean = stripAnsi(pane)
	if (overlayHasSpinner(clean)) return { status: 'not_ready' }
	const lines = clean.split('\n')
	const footerIdx = lines.findIndex(l => FOOTER_RE.test(l))
	if (footerIdx === -1) return { status: 'not_ready' }

	// Walk up from the footer collecting the answer block. A descriptive
	// autopilot answer is multiple paragraphs separated by blank lines; each
	// paragraph's lines are 4-space indented. Stop at the most recent /btw
	// history line so we never bleed into a previous answer.
	let i = footerIdx - 1
	while (i >= 0 && lines[i]!.trim() === '') i--
	const paragraphs: string[] = []
	let current: string[] = []
	const flush = () => {
		if (current.length > 0) {
			paragraphs.unshift(current.join(' '))
			current = []
		}
	}
	while (i >= 0) {
		const line = lines[i]!
		if (/^\s*\/btw\b/.test(line)) break
		if (line.trim() === '') {
			flush()
		} else if (/^ {4,}[^ ]/.test(line)) {
			current.unshift(line.slice(4))
		} else {
			// Unexpected non-/btw, non-blank, non-4-space line — stop to avoid
			// grabbing parent-pane junk.
			break
		}
		i--
	}
	flush()
	if (paragraphs.length === 0) return { status: 'parse_error' }
	return { status: 'ok', answer: paragraphs.join('\n\n').trim() }
}
