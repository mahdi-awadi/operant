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
    throw new Error('not implemented yet')
  }

  async stop(): Promise<void> {
    throw new Error('not implemented yet')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async waitUntilUp(_timeoutMs: number): Promise<void> {
    throw new Error('not implemented yet')
  }
}
