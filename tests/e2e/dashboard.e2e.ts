// tests/e2e/dashboard.e2e.ts
// Smoke tests for the operant web dashboard. Each test boots its own
// WebFrontend on a random port (in a Bun child process so its bun:sqlite
// imports work), navigates with a pre-signed auth cookie, and asserts on
// the rendered DOM. No daemon, no real Claude.
//
// First-time setup: bunx playwright install chromium

import { test, expect } from '@playwright/test'
import { startServerProcess, type SpawnedServer } from './server-process'

let srv: SpawnedServer

test.beforeEach(async () => {
  srv = await startServerProcess({
    initialSessions: [
      { path: '/proj/alpha:0',  overrides: { name: 'alpha',  trust: 'ask' } },
      { path: '/proj/bravo:0',  overrides: { name: 'bravo',  trust: 'auto' } },
    ],
  })
})

test.afterEach(async () => {
  await srv.stop()
})

// Inject the auth cookie + the client-side operant_user gate before the
// browser fetches the dashboard. The dashboard uses BOTH: the cookie for
// server-side auth on /api/* and the localStorage entry to decide whether
// to render the app or the Telegram login screen.
async function authedPage(page: import('@playwright/test').Page) {
  const u = new URL(srv.url)
  const eq = srv.cookie.indexOf('=')
  const name = srv.cookie.slice(0, eq)
  const value = srv.cookie.slice(eq + 1)
  await page.context().addCookies([{
    name, value, domain: u.hostname, path: '/',
    httpOnly: true, sameSite: 'Strict',
  }])
  // Pretend the user already completed Telegram login.
  await page.addInitScript(() => {
    localStorage.setItem('operant_user', JSON.stringify({ id: 11111, first_name: 'Test' }))
  })
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
  // Autopilot toggle item — match the "click to turn on/off" suffix to
  // disambiguate from the History item which also contains "autopilot".
  await expect(page.locator('.kebab-item', { hasText: /Autopilot — (ON|OFF)/ })).toBeVisible()
  // Personality submenu + History items also exist now
  await expect(page.locator('.kebab-item', { hasText: /^P\s*Personality:/ })).toBeVisible()
  await expect(page.locator('.kebab-item', { hasText: /History/ })).toBeVisible()
})

test('personality picker opens as a modal with grouped options + active indicator', async ({ page }) => {
  await authedPage(page)
  const alphaRow = page.locator('.session-item', { has: page.locator('.session-name', { hasText: 'alpha' }) })
  await alphaRow.hover()
  await alphaRow.locator('.kebab-btn').click()
  // Click the Personality submenu item
  await page.locator('.kebab-item', { hasText: /Personality:/ }).click()

  // Modal should be visible
  const modal = page.locator('.persona-picker-modal')
  await expect(modal).toBeVisible()

  // Header includes the session name in the title
  await expect(modal).toContainText('Personality for')
  await expect(modal).toContainText('alpha')

  // The "Default" option exists and is active by default (no personality assigned yet)
  const defaultOption = modal.locator('.persona-option', {
    has: page.locator('.persona-option-name', { hasText: /^Default$/ }),
  })
  await expect(defaultOption).toBeVisible()
  await expect(defaultOption).toHaveClass(/active/)
  await expect(defaultOption.locator('.persona-option-check')).toBeVisible()

  // Built-in section header
  await expect(modal.locator('.persona-group-heading', { hasText: /^Built-in$/i })).toBeVisible()

  // All five built-in personalities show up with the built-in tag — match
  // by exact name on the title element so descriptions don't cross-contaminate
  // the selector.
  for (const name of ['Senior Engineer', 'Pragmatist', 'Architect', 'Safety-First', 'Researcher']) {
    const opt = modal.locator('.persona-option', {
      has: page.locator('.persona-option-name', { hasText: new RegExp('^' + name) }),
    })
    await expect(opt).toBeVisible()
    await expect(opt.locator('.persona-option-tag', { hasText: 'built-in' })).toBeVisible()
  }

  // Esc closes the modal
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
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

test('compose textarea content is per-session — draft survives session switching', async ({ page }) => {
  await authedPage(page)
  await page.locator('.session-name', { hasText: 'alpha' }).click()
  const input = page.locator('#msg-input')
  await input.fill('draft for ALPHA')
  await expect(input).toHaveValue('draft for ALPHA')

  // Switch to bravo — textarea should clear (no prior draft)
  await page.locator('.session-name', { hasText: 'bravo' }).click()
  await expect(input).toHaveValue('')

  // Type a different draft for bravo
  await input.fill('hello from bravo')

  // Switch back to alpha — original draft must be restored
  await page.locator('.session-name', { hasText: 'alpha' }).click()
  await expect(input).toHaveValue('draft for ALPHA')

  // And bravo's draft is preserved when we go back to it
  await page.locator('.session-name', { hasText: 'bravo' }).click()
  await expect(input).toHaveValue('hello from bravo')
})

test('compose-draft dot appears on sidebar rows that have unsent text (other than the active one)', async ({ page }) => {
  await authedPage(page)
  await page.locator('.session-name', { hasText: 'alpha' }).click()
  await page.locator('#msg-input').fill('typed but not sent')
  const alphaRow = page.locator('.session-item', { has: page.locator('.session-name', { hasText: 'alpha' }) })
  // Active row does NOT show the dot
  await expect(alphaRow.locator('.compose-dot')).toHaveCount(0)
  // Switch away — alpha row now surfaces the dot
  await page.locator('.session-name', { hasText: 'bravo' }).click()
  await expect(alphaRow.locator('.compose-dot')).toBeVisible()
})

test('chat history is persisted to the server and replayed on a hard refresh', async ({ page }) => {
  await authedPage(page)
  // Block real WS message routing — the test only cares about persistence,
  // and routing requires a router which the test server doesn't wire.
  // Sending via the API endpoint persists the user message regardless.

  // Send a message via the public API as the "web-user" identity.
  const res = await page.request.post(`${srv.url}/api/send`, {
    headers: { cookie: srv.cookie, 'content-type': 'application/json' },
    data: { sessionName: 'alpha', text: 'remember me across reloads' },
  })
  expect(res.ok()).toBe(true)

  // Land on alpha — history is empty because the message just landed
  // server-side. Force a reload so the client lazy-loads from /messages.
  await page.locator('.session-name', { hasText: 'alpha' }).click()
  await page.reload()
  // Re-seed the localStorage gate after reload (cookie persists).
  await page.evaluate(() => {
    localStorage.setItem('operant_user', JSON.stringify({ id: 11111, first_name: 'Test' }))
  })
  await page.reload()
  await page.locator('.session-name', { hasText: 'alpha' }).click()

  // The historical message must be in the chat
  await expect(page.locator('.msg-bubble', { hasText: 'remember me across reloads' })).toBeVisible()
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
  await page.locator('.kebab-item', { hasText: /Autopilot — (ON|OFF)/ }).click()

  // The spinner appears in the same row while the request is pending.
  await expect(alphaRow.locator('.ap-spinner')).toBeVisible()
  // ...and disappears after the response returns.
  await expect(alphaRow.locator('.ap-spinner')).toBeHidden({ timeout: 3000 })
})
