#!/usr/bin/env bun
// tests/e2e/server-bin.ts
// Boots a WebFrontend on a random port and prints "<url>\n<cookie>\n" to
// stdout, then idles forever. Designed to be spawned as a child process
// from a Playwright spec running in Node, since the WebFrontend chain
// pulls in Bun-only APIs (bun:sqlite, Bun.serve, screen-manager `$`).
//
// CLI form:
//   bun run tests/e2e/server-bin.ts <sessions-json>
// Where <sessions-json> is a JSON array like
//   [{"path":"/proj/alpha:0","overrides":{"name":"alpha","trust":"ask"}}]

import { startTestServer } from './test-server'

const sessionsArg = process.argv[2] ?? '[]'
const initialSessions = JSON.parse(sessionsArg)

const srv = await startTestServer({ initialSessions })

// Hand the URL + cookie back to the parent over stdout, one line each, then
// stay alive until the parent kills us.
process.stdout.write(srv.url + '\n')
process.stdout.write(srv.cookie + '\n')

const stop = async () => {
  try { await srv.stop() } catch {}
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

// Keep the event loop alive — Bun.serve already does this, but make it
// explicit so a future refactor can't accidentally let the process exit.
setInterval(() => {}, 1 << 30)
