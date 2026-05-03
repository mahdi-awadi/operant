// tests/browser-controller.test.ts
import { describe, test, expect } from 'bun:test'

class FakeProc {
  pid = 12345
  killed = false
  exitCode: number | null = null
  signal: string | null = null
  onExit?: (subprocess: any, exitCode: number | null, signalCode: string | null) => void
  private exitedResolve!: () => void
  exited: Promise<void> = new Promise(r => { this.exitedResolve = r })
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void) {
    if (event === 'exit') this.onExit = (_p: any, c: number | null, s: string | null) => cb(c, s)
    return this
  }
  kill(sig?: string) {
    this.killed = true
    this.signal = sig ?? 'SIGTERM'
  }
  fireExit(code: number | null, signal: string | null) {
    this.exitCode = code
    this.signal = signal
    if (this.onExit) this.onExit(this, code, signal)
    this.exitedResolve()
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

  test('start() spawns chromium with the expected args', async () => {
    const calls: { cmd: (string | URL)[]; opts: any }[] = []
    const fakeProc = new FakeProc()
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (cmd: any, opts: any) => {
      fakeProc.onExit = opts.onExit
      calls.push({ cmd, opts })
      return fakeProc as any
    }

    // /json/version becomes reachable immediately
    const originalFetch = globalThis.fetch
    globalThis.fetch = makeFetchStub(new Map([
      ['http://127.0.0.1:9999/json/version', () => new Response(JSON.stringify({ Browser: 'HeadlessChrome/130' }), { status: 200 })],
    ]))

    try {
      const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/usr/bin/chromium' })
      await c.start()
      expect(calls.length).toBe(1)
      const argv = calls[0]!.cmd as string[]
      expect(argv[0]).toBe('/usr/bin/chromium')
      expect(argv).toContain('--headless=new')
      expect(argv).toContain('--remote-debugging-port=9999')
      expect(argv).toContain('--remote-debugging-address=127.0.0.1')
      expect(argv).toContain('--user-data-dir=/tmp/p')
      expect(argv).toContain('--no-first-run')
      expect(argv).toContain('--no-default-browser-check')
      expect(argv).toContain('--disable-gpu')
      expect(argv).toContain('--disable-dev-shm-usage')
      expect(c.isUp()).toBe(true)
    } finally {
      ;(Bun as any).spawn = originalSpawn
      globalThis.fetch = originalFetch
    }
  })

  test('start() rejects when /json/version never returns 200', async () => {
    const fakeProc = new FakeProc()
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; return fakeProc as any }
    const originalFetch = globalThis.fetch
    globalThis.fetch = makeFetchStub(new Map([
      ['http://127.0.0.1:9999/json/version', () => { throw new Error('connection refused') }],
    ]))

    try {
      const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
      await expect(c.start()).rejects.toThrow(/not reachable/)
    } finally {
      ;(Bun as any).spawn = originalSpawn
      globalThis.fetch = originalFetch
    }
  }, 12_000)

  test('start() is idempotent — second call while up is a no-op', async () => {
    let spawnCalls = 0
    const fakeProc = new FakeProc()
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; spawnCalls++; return fakeProc as any }
    const originalFetch = globalThis.fetch
    globalThis.fetch = makeFetchStub(new Map([
      ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
    ]))

    try {
      const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
      await c.start()
      await c.start()
      expect(spawnCalls).toBe(1)
    } finally {
      ;(Bun as any).spawn = originalSpawn
      globalThis.fetch = originalFetch
    }
  })

  test('stop() sends SIGTERM, then SIGKILL after 5s if still alive', async () => {
    const fakeProc = new FakeProc()
    const originalSpawn = Bun.spawn
    ;(Bun as any).spawn = (_cmd: any, opts: any) => { fakeProc.onExit = opts.onExit; return fakeProc as any }
    const originalFetch = globalThis.fetch
    globalThis.fetch = makeFetchStub(new Map([
      ['http://127.0.0.1:9999/json/version', () => new Response('{}', { status: 200 })],
    ]))

    try {
      const c = new BrowserController({ port: 9999, profileDir: '/tmp/p', executablePath: '/bin/true' })
      await c.start()

      // Don't fire exit — simulate Chrome ignoring SIGTERM
      const stopPromise = c.stop()

      // Should have sent SIGTERM
      await new Promise(r => setTimeout(r, 50))
      expect(fakeProc.signal).toBe('SIGTERM')

      // After ~5s, expect SIGKILL
      await new Promise(r => setTimeout(r, 5_100))
      expect(fakeProc.signal).toBe('SIGKILL')

      // Resolve the stop by firing exit
      fakeProc.fireExit(0, 'SIGKILL')
      await stopPromise
      expect(c.isUp()).toBe(false)
    } finally {
      ;(Bun as any).spawn = originalSpawn
      globalThis.fetch = originalFetch
    }
  }, 8_000)
})
