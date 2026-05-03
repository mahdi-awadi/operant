// src/browser-controller.ts
//
// Owns the lifecycle of a single headless Chromium subprocess that
// channelhub uses as the shared CDP target for chrome-devtools-mcp.
// Auto-starts at daemon boot, restarts on crash with exponential
// backoff, escalates after repeated failures.

import { EventEmitter } from 'node:events'
import type { Subprocess } from 'bun'

export type BrowserControllerDeps = {
  port: number
  profileDir: string
  executablePath: string
  args?: string[]
}

export class BrowserController extends EventEmitter {
  private deps: BrowserControllerDeps
  private proc: Subprocess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private shutdown = false
  private crashCount = 0
  private startedAt = 0

  constructor(deps: BrowserControllerDeps) {
    super()
    this.deps = deps
  }

  isUp(): boolean {
    return this.proc !== null && (this.proc as any).exitCode === null
  }

  async start(): Promise<void> {
    if (this.isUp()) return
    const args = [
      this.deps.executablePath,
      '--headless=new',
      `--remote-debugging-port=${this.deps.port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.deps.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...(this.deps.args ?? []),
    ]
    this.shutdown = false
    this.proc = Bun.spawn(args, {
      stdout: 'ignore',
      stderr: 'ignore',
      onExit: (_subprocess, exitCode, signalCode) => {
        this.handleExit(exitCode, signalCode ?? null)
      },
    })
    this.startedAt = Date.now()
    await this.waitUntilUp(10_000)
    this.emit('started')
    process.stderr.write(`hub: chrome started (pid=${this.proc.pid}, port=${this.deps.port})\n`)
  }

  async stop(): Promise<void> {
    this.shutdown = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const proc = this.proc
    if (!proc) return
    this.proc = null

    proc.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }, 5_000)

    await (proc as any).exited.catch(() => {})
    clearTimeout(killTimer)
    this.emit('stopped')
    process.stderr.write('hub: chrome stopped\n')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async waitUntilUp(timeoutMs: number): Promise<void> {
    const url = `http://127.0.0.1:${this.deps.port}/json/version`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url)
        if (res.ok) return
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`chrome /json/version not reachable on port ${this.deps.port} within ${timeoutMs}ms`)
  }

  private handleExit(code: number | null, signalCode: number | null): void {
    this.proc = null
    if (this.shutdown) return

    // Reset crash count if Chrome was stable for ≥60s before exiting
    if (Date.now() - this.startedAt > 60_000) this.crashCount = 0

    this.crashCount++
    process.stderr.write(`hub: chrome exited (code=${code} signal=${signalCode}) — crash ${this.crashCount}\n`)

    if (this.crashCount > 5) {
      process.stderr.write('hub: chrome escalated after 5 crashes\n')
      this.emit('chrome:escalated')
      return
    }

    const delay = Math.min(2 ** (this.crashCount - 1), 30) * 1000
    process.stderr.write(`hub: chrome restarting in ${delay / 1000}s\n`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch(err => process.stderr.write(`hub: chrome restart failed: ${err}\n`))
    }, delay)
  }
}
