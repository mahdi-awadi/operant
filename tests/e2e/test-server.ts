// tests/e2e/test-server.ts
// Boots an isolated WebFrontend on a random port for browser-based testing.
// Returns the URL + a pre-signed cookie so the Playwright spec can navigate
// straight past the Telegram-login wall.

import { WebFrontend, signSession } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'
import type { SessionConfig } from '../../src/types'

export type SeededSession = {
  path: string
  overrides?: Partial<SessionConfig>
}

export type StartedServer = {
  port: number
  url: string
  cookie: string                      // "hub_session=<value>"
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

  const web = new WebFrontend({
    port: 0,                          // OS picks a free port
    host: '127.0.0.1',
    registry,
    router: null as any,
    permissions: null as any,
    socketServer: null as any,
    screenManager: null as any,
    telegramToken: TEST_TOKEN,
    telegramBotUsername: 'test_bot',
    telegramAllowFrom: [TEST_USER],
    taskMonitor: null,
  })
  await web.start()

  const port = web.port
  const cookieValue = signSession(TEST_USER, TEST_TOKEN)
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    cookie: `hub_session=${cookieValue}`,
    registry,
    stop: () => web.stop(),
    registerSession: (path, overrides) => registry.register(path, overrides),
  }
}

