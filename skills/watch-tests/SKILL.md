---
name: watch-tests
description: Re-run the bun:test suite (and optionally the Playwright suite) on a loop, surfacing only failures. Use during long refactors or autopilot tuning where you want continuous green-light confirmation.
---

# Watch the test suites

Two flavors. Pick based on what's changing.

## Fast loop — bun:test only (default)

```
/loop 5m channelhub:watch-tests
```

Each tick:

```bash
bun test 2>&1 | tail -5
```

- All green → print one line: `✓ N pass · 0 fail · <Ns>`.
- Any fail → print the failing test names + the assertion preview, then ask
  the user whether to investigate or keep watching.

## Slow loop — bun:test + Playwright

For UI work where you want both layers verified:

```
/loop 15m channelhub:watch-tests with-e2e
```

Each tick:

```bash
bun test 2>&1 | tail -3
echo '---'
bun run test:e2e --reporter=list 2>&1 | tail -10
```

(Requires `bunx playwright install chromium` once.)

## Stop conditions

- User says "stop" / "done".
- Test count drops by >5 between ticks (someone's mid-refactor and tests are
  vanishing — pause and ask).
- Five consecutive runs all green AND no file changes since last green —
  pointless to keep polling. Suggest the user dismiss.

## Don't

- Don't run on every keystroke. The point is checkpoint-style green-light
  confirmation, not a watch-mode replacement (`bun test --watch` does that).
- Don't summarize green runs verbosely. One line per tick is enough — the
  user should be able to ignore the loop until it surfaces a failure.
- Don't auto-fix failures. Surface them to the user; they decide whether
  it's a real regression or expected mid-refactor noise.
