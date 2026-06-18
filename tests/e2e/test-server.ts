// tests/e2e/test-server.ts
// Boots an isolated WebFrontend on a random port for browser-based testing.
// Returns the URL + a pre-signed cookie so the Playwright spec can navigate
// straight past the Telegram-login wall.

import { WebFrontend, signSession } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'
import { openOperantDb } from '../../src/operant-db'
import { Personalities } from '../../src/personalities'
import { Decisions } from '../../src/decisions'
import { Messages } from '../../src/messages'
import { ErrorLog } from '../../src/error-log'
import type { SessionConfig } from '../../src/types'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type SeededSession = {
  path: string
  overrides?: Partial<SessionConfig>
}

export type StartedServer = {
  port: number
  url: string
  cookie: string                      // "operant_session=<value>"
  registry: SessionRegistry
  stop: () => Promise<void>
  registerSession: (path: string, overrides?: Partial<SessionConfig>) => void
}

// Any non-empty string works — the HMAC secret derives from this. Don't reuse
// real Telegram bot tokens in tests.
const TEST_TOKEN = 'test-token-do-not-leak'
const TEST_USER = '11111'

export async function startTestServer(opts?: {
  initialSessions?: SeededSession[]
}): Promise<StartedServer> {
  const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  for (const s of opts?.initialSessions ?? []) {
    registry.register(s.path, s.overrides)
  }

  // Each test instance gets its own operant.sqlite in a fresh temp dir so DAOs
  // don't pollute each other or the user's real channel data.
  const dbDir = mkdtempSync(join(tmpdir(), 'operant-e2e-'))
  const operantDb = openOperantDb(dbDir)
  const errorLog = new ErrorLog(operantDb.db)
  const personalities = new Personalities(operantDb.db)
  const decisions = new Decisions(operantDb.db)
  const messages = new Messages(operantDb.db)

  // No-op router: lets endpoints that gate on `router != null` (e.g. /api/send)
  // run without spawning real shim processes. Tests that need to verify the
  // outbound message can intercept via page.route() if the router is exercised.
  const stubRouter = {
    routeToSession: () => undefined,
    routeFromSession: () => undefined,
  } as any

  const web = new WebFrontend({
    port: 0,                          // OS picks a free port
    host: '127.0.0.1',
    registry,
    router: stubRouter,
    permissions: null as any,
    socketServer: null as any,
    screenManager: null as any,
    telegramToken: TEST_TOKEN,
    telegramBotUsername: 'test_bot',
    telegramAllowFrom: [TEST_USER],
    taskMonitor: null,
    errorLog,
    personalities,
    decisions,
    messages,
  })
  await web.start()

  const port = web.port
  const cookieValue = signSession(TEST_USER, TEST_TOKEN)
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    cookie: `operant_session=${cookieValue}`,
    registry,
    stop: async () => {
      await web.stop()
      operantDb.close()
      rmSync(dbDir, { recursive: true, force: true })
    },
    registerSession: (path, overrides) => registry.register(path, overrides),
  }
}

