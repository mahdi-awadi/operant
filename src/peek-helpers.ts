// src/peek-helpers.ts
// Shared helpers for the /peek command across Telegram, Rubika, and Web
// frontends. Pure functions only — no I/O.

// Strip ANSI escape codes (CSI + OSC + misc single-char) so terminal capture
// renders cleanly in plain-text frontends. Keeps printable content; drops
// cursor positioning, color, and OSC window-title sequences.
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
}

// Keep the most recent `limit` chars (the tail). Cuts at a newline boundary
// when one exists in the discarded prefix so we don't slice mid-line.
export function tailToCharLimit(text: string, limit: number): string {
  if (text.length <= limit) return text
  const start = text.length - limit
  const nlAfter = text.indexOf('\n', start)
  if (nlAfter > 0 && nlAfter < text.length - 1) return text.slice(nlAfter + 1)
  return text.slice(start)
}

// Parse the args portion of `/peek` ("[name] [lines]") into a structured
// shape. Either or both may be omitted; bare numeric arg means line count.
export function parsePeekArgs(raw: string): { name?: string; lines: number } {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  let name: string | undefined
  let lines = 80
  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      lines = Math.max(1, Math.min(parseInt(p, 10), 500))
    } else if (!name) {
      name = p
    }
  }
  return { name, lines }
}
