// tests/e2e/server-process.ts
// Node-side adapter that spawns a Bun child process running the
// WebFrontend, reads the URL + cookie from its stdout, and exposes a
// stop() handle. Lets Playwright (which runs under Node) drive a server
// whose code uses Bun-only APIs.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export type SpawnedServer = {
  url: string
  cookie: string
  stop: () => Promise<void>
}

export type SeededSession = {
  path: string
  overrides?: Record<string, unknown>
}

const SERVER_BIN = join(__dirname, 'server-bin.ts')

export async function startServerProcess(opts?: {
  initialSessions?: SeededSession[]
}): Promise<SpawnedServer> {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    'bun',
    ['run', SERVER_BIN, JSON.stringify(opts?.initialSessions ?? [])],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const lines: string[] = []
  let buffer = ''
  proc.stdout.setEncoding('utf8')

  const ready = new Promise<{ url: string; cookie: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server-bin did not print URL within 10s; stderr:\n${stderrChunks.join('')}`))
    }, 10_000)
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        if (lines.length >= 2) {
          clearTimeout(timeout)
          resolve({ url: lines[0]!, cookie: lines[1]! })
          return
        }
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      if (lines.length < 2) reject(new Error(`server-bin exited (code ${code}) before printing URL\nstderr:\n${stderrChunks.join('')}`))
    })
  })

  const stderrChunks: string[] = []
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))

  const { url, cookie } = await ready

  return {
    url,
    cookie,
    async stop() {
      proc.kill('SIGTERM')
      await new Promise<void>((r) => {
        proc.once('exit', () => r())
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; r() }, 1500)
      })
    },
  }
}
