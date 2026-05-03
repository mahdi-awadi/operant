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
    throw new Error('not implemented yet')
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

  private handleExit(_code: number | null, _signal: number | null): void {
    // Implemented in Task 4 (crash backoff). For now we just clear proc.
    this.proc = null
  }
}
