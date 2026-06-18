---
name: e2e-web
description: Run Playwright browser tests against the operant web dashboard. Use when validating UI changes (kebab menu, autopilot toggle, escalation card, settings panels) — the SPA has zero coverage from bun:test alone.
---

# Browser-level E2E for the dashboard

`tests/e2e/` runs Playwright specs against an isolated `WebFrontend` booted on
a random port. No real daemon, no shim, no real Claude — each test seeds the
SessionRegistry directly.

## First-time setup

Playwright is installed as a dev dep (`@playwright/test`). The browser
binaries are NOT installed automatically (they're ~150 MB):

```bash
bunx playwright install chromium
# Or all browsers (chromium, firefox, webkit):
bunx playwright install
```

## Running

```bash
bun run test:e2e                # headless, all specs
bun run test:e2e:ui             # interactive UI mode (great for debugging)
bunx playwright test --headed   # see the browser drive itself
bunx playwright test --debug    # step through with the inspector
```

`bun test` does NOT pick up these specs — they end in `.e2e.ts` rather than
`.test.ts` / `.spec.ts`, so the two test runners stay disjoint.

## Architecture: spawn the server in Bun, drive the browser from Node

Playwright runs in Node, but the WebFrontend pulls in Bun-only imports
(`bun:sqlite`, `Bun.serve`, `screen-manager` `$`). So the harness uses two
processes:

```
[ Playwright spec, Node ] ── stdio ──> [ tests/e2e/server-bin.ts, Bun ]
                                              │
                                              └── http://127.0.0.1:NNNNN
```

`tests/e2e/server-process.ts` exposes `startServerProcess(opts)` which
spawns the Bun child, reads `<url>\n<cookie>\n` from its stdout, and
returns a `stop()` handle. Use it in your specs — never import the
WebFrontend directly into a Playwright test.

## Writing a new spec

```ts
import { test, expect } from '@playwright/test'
import { startServerProcess, type SpawnedServer } from './server-process'

let srv: SpawnedServer

test.beforeEach(async () => {
  srv = await startServerProcess({
    initialSessions: [{ path: '/proj/x:0', overrides: { name: 'x', trust: 'auto' } }],
  })
})

test.afterEach(async () => { await srv.stop() })

test('something on x', async ({ page }) => {
  const u = new URL(srv.url)
  const eq = srv.cookie.indexOf('=')
  await page.context().addCookies([{
    name: srv.cookie.slice(0, eq),
    value: srv.cookie.slice(eq + 1),
    domain: u.hostname, path: '/',
    httpOnly: true, sameSite: 'Strict',
  }])
  // The dashboard also gates the UI on a localStorage marker (the cookie
  // is for server-side auth). Seed it so the app renders, not the login.
  await page.addInitScript(() => {
    localStorage.setItem('hub_user', JSON.stringify({ id: 11111, first_name: 'Test' }))
  })
  await page.goto(srv.url)
  // ... your assertions ...
})
```

For tests that need to slow down a request (catch a spinner, race UI state
transitions), use `page.route()`:

```ts
await page.route('**/api/autopilot', async (route) => {
  await new Promise(r => setTimeout(r, 800))
  await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
})
```

## What's covered today

`tests/e2e/dashboard.e2e.ts`:

- Sidebar renders seeded sessions
- Kebab menu opens with trust segments + autopilot item
- `GET /api/sessions` returns 200 with cookie / 401 without
- Autopilot toggle shows the spinner during /api/autopilot in flight

## What to add when working on UI

- **Personalities settings** (planned): list/create/edit/delete flow, default-on-toggle
- **Escalation card**: render on websocket event, three actions (proceed/answer/dismiss)
- **Veto countdown**: timer ticks, send/edit/cancel buttons
- **Theme switcher**: data-theme attribute toggles, contrast-mode survives reload
- **Spawn dialog**: directory picker, browseRoot scoping, paste-to-upload

## CI integration

NOT wired into CI yet. The Playwright run takes ~30-60s plus browser install
(~150 MB) — adds noticeable cost. When ready, the GitHub Actions step is:

```yaml
- name: Install Playwright browsers
  run: bunx playwright install chromium --with-deps
- name: E2E
  run: bun run test:e2e
```

Run it on a separate job from `bun test` so the fast suite stays fast.

## Don't

- Don't hit real network in specs. Always use `page.route()` to mock external
  fetches if you need them.
- Don't share state between specs. Each `test.beforeEach` should boot a fresh
  server. Tests run in parallel.
- Don't assert on dynamic timing (animation duration, exact ms). Use
  Playwright's auto-waiting locators instead.
