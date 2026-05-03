// tests/browser-controller.test.ts
import { describe, test, expect } from 'bun:test'

class FakeProc {
  pid = 12345
  killed = false
  exitCode: number | null = null
  signal: string | null = null
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = []
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void) {
    if (event === 'exit') this.exitListeners.push(cb)
    return this
  }
  kill(sig?: string) {
    this.killed = true
    this.signal = sig ?? 'SIGTERM'
  }
  fireExit(code: number | null, signal: string | null) {
    this.exitCode = code
    this.signal = signal
    for (const cb of this.exitListeners) cb(code, signal)
  }
}

function makeFetchStub(responses: Map<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const handler = responses.get(url) ?? (() => new Response('not found', { status: 404 }))
    return await handler()
  }) as unknown as typeof fetch
}

import { BrowserController } from '../src/browser-controller'

describe('BrowserController', () => {
  test('exposes start, stop, restart, isUp, waitUntilUp methods', () => {
    const c = new BrowserController({ port: 9999, profileDir: '/tmp/x', executablePath: '/bin/true' })
    expect(typeof c.start).toBe('function')
    expect(typeof c.stop).toBe('function')
    expect(typeof c.restart).toBe('function')
    expect(typeof c.isUp).toBe('function')
    expect(typeof c.waitUntilUp).toBe('function')
    expect(c.isUp()).toBe(false)
  })
})
