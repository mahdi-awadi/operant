// playwright.config.ts
// Browser-level tests for the operant web dashboard. Each test boots an
// isolated WebFrontend on a random port (see tests/e2e/test-server.ts), so
// runs are hermetic — no daemon, no real Claude, no shared state.
//
// Run: bunx playwright test
//      bunx playwright test --ui          (visual debugger)
//      bunx playwright test --headed      (see the browser)
//
// First run also needs: bunx playwright install chromium

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // .e2e.ts (not .spec.ts) so bun:test's default discovery skips them.
  testMatch: '**/*.e2e.ts',
  // Each test boots its own server, so parallelism is safe.
  fullyParallel: true,
  // Don't allow .only in CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Bun's test runner runs in tests/ — Playwright must NOT touch those files.
  // We isolate Playwright tests under tests/e2e/.
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    // The test server is started by each spec via the helper, which sets the
    // baseURL on the test fixture. No webServer block needed here.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 5000,
    navigationTimeout: 10000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
