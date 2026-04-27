---
name: e2e-web
description: Run Playwright browser tests against the channelhub web dashboard. Use when validating UI changes (kebab menu, autopilot toggle, escalation card, settings panels) — the SPA has zero coverage from bun:test alone.
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

## Writing a new spec

Use the `startTestServer` helper from `tests/e2e/test-server.ts`. It returns
`url`, a pre-signed `cookie`, and a `registry` you can poke mid-test.

```ts
import { test, expect } from '@playwright/test'
import { startTestServer } from './test-server'

test('autopilot 🤖 badge appears after toggle', async ({ page }) => {
  const srv = await startTestServer({
    initialSessions: [{ path: '/proj/x:0', overrides: { name: 'x', trust: 'auto' } }],
  })
  try {
    const u = new URL(srv.url)
    const [n, v] = srv.cookie.split('=')
    await page.context().addCookies([{
      name: n, value: v!, domain: u.hostname, path: '/',
      httpOnly: true, sameSite: 'Strict',
    }])
    await page.goto(srv.url)
    // ... your assertions ...
  } finally {
    await srv.stop()
  }
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
