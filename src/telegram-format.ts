// src/telegram-format.ts
// Convert daemon-emitted text (a mix of plain prose and lightweight markdown)
// into Telegram HTML so messages render with proper code blocks, bold, and
// bullet glyphs on mobile. Designed for short messages (toasts, autopilot
// answers, escalations) — not a full markdown engine.
//
// Telegram HTML supports: <b> <i> <u> <s> <code> <pre> <a> <blockquote>
// <tg-spoiler>. Crucially, NO list tags — we substitute • for "- ".

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

// Exported for use by Telegram callers that need to inject user-controlled
// strings (session names, etc.) into HTML templates.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]!)
}

// Process a string that should NOT have markdown parsing applied (i.e.
// contents of a code block). Just HTML-escape.
function escapeOnly(s: string): string {
  return escapeHtml(s)
}

// Process a string that's outside any code block — apply the markdown-ish
// transforms after HTML-escaping.
function transformLine(line: string): string {
  // Heading: "# foo" or "## foo" → <b>foo</b>
  const head = /^#{1,6}\s+(.+)$/.exec(line)
  if (head) {
    return `<b>${escapeHtml(head[1]!.trim())}</b>`
  }
  // Bullet: "- foo" or "* foo" → "• foo"
  const bullet = /^[-*]\s+(.+)$/.exec(line)
  if (bullet) {
    return `• ${transformInline(bullet[1]!)}`
  }
  return transformInline(line)
}

// Inline transforms: backtick code, **bold**. Order matters — code blocks
// must be extracted FIRST so their contents are not bold-mangled.
function transformInline(s: string): string {
  const parts: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '`') {
      // Look for the closing backtick.
      const close = s.indexOf('`', i + 1)
      if (close === -1) {
        // No closer — emit the literal backtick (escaped if needed) and move on.
        parts.push(escapeHtml('`'))
        i++
        continue
      }
      const inner = s.slice(i + 1, close)
      parts.push(`<code>${escapeHtml(inner)}</code>`)
      i = close + 1
      continue
    }
    if (ch === '*' && s[i + 1] === '*') {
      // **bold**
      const close = s.indexOf('**', i + 2)
      if (close === -1) {
        parts.push(escapeHtml('**'))
        i += 2
        continue
      }
      const inner = s.slice(i + 2, close)
      parts.push(`<b>${escapeHtml(inner)}</b>`)
      i = close + 2
      continue
    }
    // Normal char.
    parts.push(escapeHtml(ch!))
    i++
  }
  return parts.join('')
}

export function formatForTelegram(raw: string): string {
  if (raw.length === 0) return ''

  // First pass: split out fenced code blocks. Their contents bypass all
  // markdown-ish transforms — they're escaped-only and wrapped in
  // <pre><code>. Anything between fences is a "non-code" segment that gets
  // line-by-line markdown handling.
  const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g
  const out: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(raw)) !== null) {
    const before = raw.slice(last, m.index)
    if (before.length > 0) out.push(transformProse(before))
    const lang = m[1] ?? ''
    const code = m[2] ?? ''
    if (lang) {
      out.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeOnly(code)}</code></pre>`)
    } else {
      out.push(`<pre><code>${escapeOnly(code)}</code></pre>`)
    }
    last = FENCE_RE.lastIndex
  }
  const tail = raw.slice(last)
  if (tail.length > 0) out.push(transformProse(tail))
  return out.join('')
}

function transformProse(text: string): string {
  return text.split('\n').map(transformLine).join('\n')
}
