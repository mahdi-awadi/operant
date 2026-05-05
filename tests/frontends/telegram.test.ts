import { describe, test, expect } from 'bun:test'
import { formatSessionList, formatStatus, parseCommand, chunkText, stripAnsi, tailToCharLimit, parsePeekArgs } from '../../src/frontends/telegram'

describe('telegram helpers', () => {
  test('formatSessionList with no sessions', () => {
    const text = formatSessionList([], null)
    expect(text).toContain('No sessions')
  })

  test('formatSessionList with sessions', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: '', uploadDir: '.', managed: false, teamIndex: 0, teamSize: 0, connectedAt: Date.now() },
      { name: 'backend', status: 'disconnected' as const, path: '/home/user/backend', trust: 'auto' as const, prefix: '', uploadDir: '.', managed: true, teamIndex: 0, teamSize: 0, connectedAt: null },
    ]
    const text = formatSessionList(sessions, 'frontend')
    expect(text).toContain('frontend')
    expect(text).toContain('backend')
    expect(text).toContain('active')
  })

  test('formatStatus shows dashboard', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: 'test', uploadDir: '.', managed: false, teamIndex: 0, teamSize: 0, connectedAt: Date.now() },
    ]
    const text = formatStatus(sessions)
    expect(text).toContain('frontend')
  })

  test('parseCommand extracts command and args', () => {
    expect(parseCommand('/spawn frontend /home/user/frontend')).toEqual({
      command: 'spawn',
      args: ['frontend', '/home/user/frontend'],
    })
    expect(parseCommand('/list')).toEqual({ command: 'list', args: [] })
    expect(parseCommand('/all fix everything')).toEqual({
      command: 'all',
      args: ['fix', 'everything'],
    })
  })

  test('parseCommand returns null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  test('chunkText splits long messages', () => {
    const long = 'a'.repeat(5000)
    const chunks = chunkText(long, 4096)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBeLessThanOrEqual(4096)
  })

  test('chunkText returns single chunk for short messages', () => {
    const chunks = chunkText('short', 4096)
    expect(chunks).toEqual(['short'])
  })

  test('stripAnsi removes CSI color codes', () => {
    const colored = '\x1b[31mhello\x1b[0m world'
    expect(stripAnsi(colored)).toBe('hello world')
  })

  test('stripAnsi removes cursor positioning sequences', () => {
    const moves = 'a\x1b[2Jb\x1b[H\x1b[?25lc'
    expect(stripAnsi(moves)).toBe('abc')
  })

  test('stripAnsi removes OSC sequences (window title)', () => {
    const osc = 'before\x1b]0;some title\x07after'
    expect(stripAnsi(osc)).toBe('beforeafter')
  })

  test('tailToCharLimit returns input when under limit', () => {
    expect(tailToCharLimit('short', 100)).toBe('short')
  })

  test('tailToCharLimit keeps the tail when over limit', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd'
    const trimmed = tailToCharLimit(text, 9)
    // Tail of length ~9, cut at newline boundary — should end with last lines
    expect(trimmed.endsWith('dddd')).toBe(true)
    expect(trimmed.length).toBeLessThanOrEqual(text.length)
  })

  test('parsePeekArgs handles empty input (defaults)', () => {
    expect(parsePeekArgs('')).toEqual({ name: undefined, lines: 80 })
  })

  test('parsePeekArgs handles name only', () => {
    expect(parsePeekArgs('eticket-v3')).toEqual({ name: 'eticket-v3', lines: 80 })
  })

  test('parsePeekArgs handles name + lines', () => {
    expect(parsePeekArgs('eticket-v3 200')).toEqual({ name: 'eticket-v3', lines: 200 })
  })

  test('parsePeekArgs handles bare line count (no name)', () => {
    expect(parsePeekArgs('150')).toEqual({ name: undefined, lines: 150 })
  })

  test('parsePeekArgs clamps line count to max 500', () => {
    expect(parsePeekArgs('foo 9999').lines).toBe(500)
  })

  test('parsePeekArgs clamps line count to min 1', () => {
    expect(parsePeekArgs('foo 0').lines).toBe(1)
  })
})
