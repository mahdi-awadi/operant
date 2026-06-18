// tests/shim.test.ts
import { describe, test, expect } from 'bun:test'
import { parseShimMessage, buildMcpToolResult, buildMcpNotification } from '../src/shim'

describe('shim helpers', () => {
  test('parseShimMessage parses register', () => {
    const msg = parseShimMessage('{"type":"registered","sessionName":"frontend"}')
    expect(msg.type).toBe('registered')
    if (msg.type === 'registered') {
      expect(msg.sessionName).toBe('frontend')
    }
  })

  test('buildMcpToolResult formats MCP response', () => {
    const result = buildMcpToolResult('sent (id: 42)')
    expect(result.content).toEqual([{ type: 'text', text: 'sent (id: 42)' }])
  })

  test('buildMcpNotification creates channel notification', () => {
    const notif = buildMcpNotification('hello', { source: 'operant', session: 'frontend' })
    expect(notif.method).toBe('notifications/claude/channel')
    expect(notif.params.content).toBe('hello')
    expect(notif.params.meta.source).toBe('operant')
  })
})
