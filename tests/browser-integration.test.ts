// tests/browser-integration.test.ts
import { describe, test, expect } from 'bun:test'
import { BrowserController } from '../src/browser-controller'
import { mkdtemp, rm } from 'node:fs/promises'

const ENABLED = process.env.BROWSER_E2E === '1'
const d = ENABLED ? describe : describe.skip

d('BrowserController (real Chrome)', () => {
  test('start, /json/version reachable, stop kills it', async () => {
    const tmp = await mkdtemp('/tmp/cc-bce-')
    const { chromium } = await import('playwright')
    const exec = chromium.executablePath()
    if (!exec) throw new Error('playwright chromium binary not installed (run: bunx playwright install chromium)')

    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop()
    if (port === undefined) throw new Error('failed to allocate browser test port')

    const ctrl = new BrowserController({ port, profileDir: tmp, executablePath: exec })
    try {
      await ctrl.start()
      const v = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()) as { Browser?: string }
      expect(v.Browser ?? '').toMatch(/^HeadlessChrome/)
      await ctrl.stop()
      expect(ctrl.isUp()).toBe(false)
    } finally {
      try { await ctrl.stop() } catch { /* already stopped */ }
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
