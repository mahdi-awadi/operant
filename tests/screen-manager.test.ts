// tests/screen-manager.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { $ } from 'bun'
import { ScreenManager } from '../src/screen-manager'
import { buildClaudeCmd, isValidSessionId } from '../src/screen-manager'

describe('ScreenManager', () => {
  let manager: ScreenManager

  beforeEach(() => {
    manager = new ScreenManager()
  })

  afterEach(async () => {
    await manager.killAll()
  })

  test('isSessionRunning returns false for non-existent session', async () => {
    const running = await manager.isSessionRunning('operant-nonexistent-12345')
    expect(running).toBe(false)
  })

  test('listSessions returns array', async () => {
    const sessions = await manager.listSessions()
    expect(Array.isArray(sessions)).toBe(true)
  })

  test('isManaged returns false for unknown name', () => {
    expect(manager.isManaged('unknown')).toBe(false)
  })

  test('spawnTeam is a function', () => {
    expect(typeof manager.spawnTeam).toBe('function')
  })

  test('addTeammate is a function', () => {
    expect(typeof manager.addTeammate).toBe('function')
  })

  test('gracefulKill is a no-op for unknown name', async () => {
    // Should not throw and should not affect state.
    await manager.gracefulKill('does-not-exist')
    expect(manager.isManaged('does-not-exist')).toBe(false)
  })

  test('gracefulKill falls back to hard kill when session ignores /exit', async () => {
    const name = 'test-fallback'
    const sessionName = `operant-${name}`

    // Start a fake tmux session that ignores Ctrl+C and /exit commands.
    // Uses bash with trap to ignore SIGINT, and runs an infinite loop.
    await $`tmux new-session -d -s ${sessionName} bash -c "trap '' INT; while true; do sleep 1; done"`.quiet()

    // Inject it into ScreenManager's managed map so gracefulKill treats it as managed.
    ;(manager as any).managed.set(name, {
      sessionName,
      projectPath: '/tmp',
      respawnEnabled: true,
    })

    // Sanity check: it's running before we call gracefulKill.
    expect(await manager.isSessionRunning(sessionName)).toBe(true)

    // Run gracefulKill. This should take ~3 seconds (cancel delay + timeout)
    // before the fallback fires.
    const start = Date.now()
    await manager.gracefulKill(name)
    const elapsed = Date.now() - start

    // The fallback should have killed the tmux session.
    expect(await manager.isSessionRunning(sessionName)).toBe(false)

    // The managed map should no longer contain the entry.
    expect(manager.isManaged(name)).toBe(false)

    // Sanity check on timing: GRACEFUL_CANCEL_DELAY (300) + GRACEFUL_TIMEOUT (3000)
    // = ~3300ms minimum. Allow a little slack below and a generous ceiling.
    expect(elapsed).toBeGreaterThanOrEqual(3200)
    expect(elapsed).toBeLessThan(6000)
  }, 10000) // 10s timeout for this test since it waits ~3.3s
})

describe('isValidSessionId', () => {
  test('accepts a UUID', () => {
    expect(isValidSessionId('aaaa1111-2222-3333-4444-555555555555')).toBe(true)
  })

  test('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  test('rejects path traversal', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false)
  })

  test('rejects shell metacharacters', () => {
    expect(isValidSessionId('abc; rm -rf /')).toBe(false)
    expect(isValidSessionId('abc$(whoami)')).toBe(false)
  })

  test('rejects spaces', () => {
    expect(isValidSessionId('a b c')).toBe(false)
  })
})

test('capturePane returns text from tmux when session exists', async () => {
  const sm = new ScreenManager()
  // Create a throwaway tmux session with a known pane content
  const s = `test-capture-${Date.now()}`
  await $`tmux new-session -d -s ${s} "bash -c 'echo HELLOWORLD; sleep 30'"`.quiet()
  try {
    // Wait briefly for the echo to hit the pane
    await new Promise(r => setTimeout(r, 200))
    const pane = await sm.capturePane(s, 20)
    expect(pane).toContain('HELLOWORLD')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

test('capturePane only returns the visible pane, never scrollback', async () => {
  // Real-world bug: dismissed /btw overlays leave their footer + answer in
  // scrollback. If capturePane includes scrollback, the autopilot parser sees
  // a stale "settled" overlay and returns the OLD answer for a new question.
  // We push many lines into scrollback by clearing the screen — the cleared
  // content goes into the history buffer and must NOT appear in capturePane.
  const sm = new ScreenManager()
  const s = `test-no-scrollback-${Date.now()}`
  await $`tmux new-session -d -s ${s} -x 80 -y 10 "bash -c 'echo SCROLLBACK_ONLY_LINE; sleep 0.2; clear; echo VISIBLE_LINE; sleep 30'"`.quiet()
  try {
    await new Promise(r => setTimeout(r, 600))
    const pane = await sm.capturePane(s, 200)
    expect(pane).toContain('VISIBLE_LINE')
    // SCROLLBACK_ONLY_LINE was cleared off the visible pane — must not leak in
    expect(pane).not.toContain('SCROLLBACK_ONLY_LINE')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

test('sendKeysRaw writes a line and capturePane sees it', async () => {
  const sm = new ScreenManager()
  const s = `test-sendkeys-${Date.now()}`
  // cat will echo whatever we type
  await $`tmux new-session -d -s ${s} "cat"`.quiet()
  try {
    await sm.sendKeysRaw(s, 'HELLO-FROM-TEST', true)
    await new Promise(r => setTimeout(r, 200))
    const pane = await sm.capturePane(s)
    expect(pane).toContain('HELLO-FROM-TEST')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

test('sendEscape does not throw when session is missing', async () => {
  const sm = new ScreenManager()
  await sm.sendEscape('nonexistent-session-xyz-' + Date.now())
  // No assertion needed — test passes if no exception is thrown
})

test('capturePaneWithScrollback includes content from scrollback history', async () => {
  // Inverse of the capturePane scrollback test — /peek MUST surface old lines
  // that have scrolled off the visible frame so the user can read recent
  // terminal output.
  const sm = new ScreenManager()
  const s = `test-peek-scrollback-${Date.now()}`
  await $`tmux new-session -d -s ${s} -x 80 -y 10 "bash -c 'echo SCROLLBACK_LINE; sleep 0.2; clear; echo VISIBLE_LINE; sleep 30'"`.quiet()
  try {
    await new Promise(r => setTimeout(r, 600))
    const pane = await sm.capturePaneWithScrollback(s, 500)
    expect(pane).toContain('VISIBLE_LINE')
    expect(pane).toContain('SCROLLBACK_LINE')
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

test('capturePaneWithScrollback throws when session does not exist', async () => {
  const sm = new ScreenManager()
  await expect(sm.capturePaneWithScrollback('operant-no-such-' + Date.now(), 80))
    .rejects.toThrow(/No tmux session/)
})

test('capturePaneWithScrollback clamps line count', async () => {
  // Asking for an absurd line count or zero should still work — the helper
  // clamps to a sane range internally.
  const sm = new ScreenManager()
  const s = `test-peek-clamp-${Date.now()}`
  await $`tmux new-session -d -s ${s} "bash -c 'echo CLAMP_OK; sleep 30'"`.quiet()
  try {
    await new Promise(r => setTimeout(r, 200))
    const big = await sm.capturePaneWithScrollback(s, 999999)
    expect(big).toContain('CLAMP_OK')
    const zero = await sm.capturePaneWithScrollback(s, 0)
    expect(zero.length).toBeGreaterThanOrEqual(0)
  } finally {
    try { await $`tmux kill-session -t ${s}`.quiet() } catch {}
  }
})

describe('buildClaudeCmd', () => {
  test('no resume → bare claude', () => {
    const cmd = buildClaudeCmd({ team: false })
    expect(cmd).toBe('claude --dangerously-load-development-channels server:operant')
  })

  test('resume=continue → claude --continue', () => {
    const cmd = buildClaudeCmd({ team: false, resume: { mode: 'continue' } })
    expect(cmd).toBe('claude --continue --dangerously-load-development-channels server:operant')
  })

  test('resume=session → claude --resume <id>', () => {
    const cmd = buildClaudeCmd({ team: false, resume: { mode: 'session', id: 'aaaa1111-2222-3333-4444-555555555555' } })
    expect(cmd).toBe('claude --resume aaaa1111-2222-3333-4444-555555555555 --dangerously-load-development-channels server:operant')
  })

  test('team mode preserves CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS prefix', () => {
    const cmd = buildClaudeCmd({ team: true })
    expect(cmd).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1')
    expect(cmd).toContain('claude --dangerously-load-development-channels server:operant')
  })

  test('rejects a resume session with an invalid id', () => {
    expect(() =>
      buildClaudeCmd({ team: false, resume: { mode: 'session', id: '; rm -rf /' } })
    ).toThrow(/invalid session id/i)
  })
})
