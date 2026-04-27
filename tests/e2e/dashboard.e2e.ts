// tests/e2e/dashboard.spec.ts
// Smoke tests for the channelhub web dashboard. Each test boots its own
// WebFrontend on a random port, navigates with a pre-signed auth cookie,
// and asserts on the rendered DOM. No daemon, no real Claude.
//
// First-time setup: bunx playwright install chromium

import { test, expect } from '@playwright/test'
import { startTestServer, type StartedServer } from './test-server'

let srv: StartedServer

test.beforeEach(async () => {
  srv = await startTestServer({
    initialSessions: [
      { path: '/proj/alpha:0',  overrides: { name: 'alpha',  trust: 'ask' } },
      { path: '/proj/bravo:0',  overrides: { name: 'bravo',  trust: 'auto' } },
    ],
  })
})

test.afterEach(async () => {
  await srv.stop()
})

// Inject the auth cookie before the browser fetches the dashboard.
async function authedPage(page: import('@playwright/test').Page) {
  const u = new URL(srv.url)
  const [name, value] = srv.cookie.split('=')
  await page.context().addCookies([{
    name, value: value!, domain: u.hostname, path: '/',
    httpOnly: true, sameSite: 'Strict',
  }])
  await page.goto(srv.url)
}

test('dashboard renders the seeded sessions in the sidebar', async ({ page }) => {
  await authedPage(page)
  // The sidebar items show each session's name. Wait for the WebSocket sessions
  // payload to populate, then assert.
  await expect(page.locator('.session-name', { hasText: 'alpha' })).toBeVisible()
  await expect(page.locator('.session-name', { hasText: 'bravo' })).toBeVisible()
})

test('kebab menu opens with autopilot + trust + close items', async ({ page }) => {
  await authedPage(page)
  const alphaRow = page.locator('.session-item', { has: page.locator('.session-name', { hasText: 'alpha' }) })
  await alphaRow.hover()
  await alphaRow.locator('.kebab-btn').click()
  // Trust segments
  await expect(page.locator('.kebab-seg', { hasText: 'ask' })).toBeVisible()
  await expect(page.locator('.kebab-seg', { hasText: 'auto' })).toBeVisible()
  // Autopilot toggle item
  await expect(page.locator('.kebab-item', { hasText: 'Autopilot' })).toBeVisible()
})

test('GET /api/sessions returns the seeded sessions when authed', async ({ request }) => {
  const res = await request.get(`${srv.url}/api/sessions`, {
    headers: { cookie: srv.cookie },
  })
  expect(res.status()).toBe(200)
  const sessions = await res.json()
  const names = sessions.map((s: { name: string }) => s.name).sort()
  expect(names).toEqual(['alpha', 'bravo'])
})

test('GET /api/sessions returns 401 without the cookie', async ({ request }) => {
  const res = await request.get(`${srv.url}/api/sessions`)
  expect(res.status()).toBe(401)
})

test('autopilot toggle shows the spinner while POST is in flight', async ({ page }) => {
  await authedPage(page)
  // Slow the autopilot endpoint so we can actually catch the spinner mid-flight.
  await page.route('**/api/autopilot', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
  })

  const alphaRow = page.locator('.session-item', { has: page.locator('.session-name', { hasText: 'alpha' }) })
  await alphaRow.hover()
  await alphaRow.locator('.kebab-btn').click()
  await page.locator('.kebab-item', { hasText: 'Autopilot' }).click()

  // The spinner appears in the same row while the request is pending.
  await expect(alphaRow.locator('.ap-spinner')).toBeVisible()
  // ...and disappears after the response returns.
  await expect(alphaRow.locator('.ap-spinner')).toBeHidden({ timeout: 3000 })
})
