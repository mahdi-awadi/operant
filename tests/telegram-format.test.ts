// tests/telegram-format.test.ts
import { describe, test, expect } from 'bun:test'
import { formatForTelegram } from '../src/telegram-format'

describe('formatForTelegram', () => {
  test('plain text passes through, only HTML-special chars escaped', () => {
    expect(formatForTelegram('hello world')).toBe('hello world')
    expect(formatForTelegram('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d')
  })

  test('triple-backtick fenced code block becomes <pre><code>', () => {
    const out = formatForTelegram('Try this:\n```\nbun test\nbunx tsc\n```\nThen ship.')
    expect(out).toContain('<pre><code>')
    expect(out).toContain('bun test')
    expect(out).toContain('bunx tsc')
    expect(out).toContain('</code></pre>')
    expect(out).toContain('Then ship.')
  })

  test('language tag on a fenced block becomes <pre><code class="language-...">', () => {
    const out = formatForTelegram('```bash\nls -la\n```')
    expect(out).toContain('<pre><code class="language-bash">')
    expect(out).toContain('ls -la')
  })

  test('html-special chars INSIDE a fenced code block are escaped, not interpreted', () => {
    const out = formatForTelegram('```\n<script>alert(1)</script>\n```')
    // Tag must appear as literal text inside the code block
    expect(out).toContain('&lt;script&gt;')
    // The <pre> wrapper is the only real HTML
    expect(out.match(/<pre>/g)?.length).toBe(1)
  })

  test('inline `code` becomes <code>', () => {
    expect(formatForTelegram('run `npm install` first')).toBe('run <code>npm install</code> first')
  })

  test('inline code is escaped inside the <code> tag', () => {
    expect(formatForTelegram('check `a < b`')).toBe('check <code>a &lt; b</code>')
  })

  test('**bold** becomes <b>', () => {
    expect(formatForTelegram('this is **important** stuff')).toBe('this is <b>important</b> stuff')
  })

  test('lines starting with "- " become • bullets', () => {
    const out = formatForTelegram('- one\n- two\n- three')
    expect(out).toBe('• one\n• two\n• three')
  })

  test('# heading becomes <b>heading</b>', () => {
    const out = formatForTelegram('# Steps\nthen body')
    expect(out).toBe('<b>Steps</b>\nthen body')
  })

  test('## subheading also becomes <b>', () => {
    expect(formatForTelegram('## Why')).toBe('<b>Why</b>')
  })

  test('mixed: heading + bullets + inline code + fenced block', () => {
    const out = formatForTelegram(
      '# Quick fix\nDo these:\n- run `bun install`\n- then\n```\nbun test\n```',
    )
    expect(out).toContain('<b>Quick fix</b>')
    expect(out).toContain('• run <code>bun install</code>')
    expect(out).toContain('• then')
    expect(out).toContain('<pre><code>')
    expect(out).toContain('bun test')
  })

  test('does not double-process: inline code with asterisks is not bolded', () => {
    expect(formatForTelegram('try `**raw**`')).toBe('try <code>**raw**</code>')
  })

  test('does not parse markdown INSIDE a fenced code block', () => {
    const out = formatForTelegram('```\n**bold inside**\n- bullet inside\n```')
    expect(out).toContain('**bold inside**')
    expect(out).toContain('- bullet inside')   // not converted to •
    expect(out).not.toContain('<b>')
  })

  test('preserves blank lines (paragraph breaks)', () => {
    expect(formatForTelegram('first\n\nsecond')).toBe('first\n\nsecond')
  })

  test('handles unbalanced backtick gracefully — leftover tick is escaped, not <code>', () => {
    // Single backtick with no closer should NOT become a code tag.
    expect(formatForTelegram('one ` unclosed')).toBe('one ` unclosed')
  })

  test('empty input is empty', () => {
    expect(formatForTelegram('')).toBe('')
  })
})
