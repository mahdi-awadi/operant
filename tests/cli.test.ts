// tests/cli.test.ts
import { describe, test, expect } from 'bun:test'
import { parseCliArgs } from '../src/cli'

describe('CLI arg parsing', () => {
  test('parses list command', () => {
    expect(parseCliArgs(['list'])).toEqual({ command: 'list', args: [] })
  })

  test('parses spawn with name and path', () => {
    expect(parseCliArgs(['spawn', 'frontend', '/home/user/frontend'])).toEqual({
      command: 'spawn',
      args: ['frontend', '/home/user/frontend'],
    })
  })

  test('parses send with name and message', () => {
    expect(parseCliArgs(['send', 'frontend', 'fix the bug'])).toEqual({
      command: 'send',
      args: ['frontend', 'fix the bug'],
    })
  })

  test('returns help for empty args', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help', args: [] })
  })

  test('parses trust with name and level', () => {
    expect(parseCliArgs(['trust', 'frontend', 'auto'])).toEqual({
      command: 'trust',
      args: ['frontend', 'auto'],
    })
  })

  test('parses autopilot with name and on', () => {
    expect(parseCliArgs(['autopilot', 'mysess', 'on'])).toEqual({
      command: 'autopilot',
      args: ['mysess', 'on'],
    })
  })

  test('parses autopilot with name and off', () => {
    expect(parseCliArgs(['autopilot', 'mysess', 'off'])).toEqual({
      command: 'autopilot',
      args: ['mysess', 'off'],
    })
  })
})

describe('CLI autopilot command (integration)', () => {
  async function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', ...args],
      {
        cwd: '/home/channelhub',
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }

  test('autopilot with no args prints usage and exits non-zero', async () => {
    // Use a port that nothing listens on so fetch won't accidentally succeed
    const result = await runCli(['autopilot'], { HUB_URL: 'http://localhost:19999' })
    expect(result.stderr).toContain('Usage: autopilot <name> on|off')
    expect(result.exitCode).not.toBe(0)
  })

  test('autopilot with invalid mode prints usage and exits non-zero', async () => {
    const result = await runCli(['autopilot', 'mysess', 'maybe'], { HUB_URL: 'http://localhost:19999' })
    expect(result.stderr).toContain('Usage: autopilot <name> on|off')
    expect(result.exitCode).not.toBe(0)
  })

  test('autopilot on posts correct body and prints success', async () => {
    // Spin up a tiny mock HTTP server
    let receivedBody: any = null
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.url.includes('/api/autopilot') && req.method === 'POST') {
          return req.json().then((body: any) => {
            receivedBody = body
            return new Response('ok', { status: 200 })
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const result = await runCli(['autopilot', 'mysess', 'on'], {
        HUB_URL: `http://localhost:${server.port}`,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('autopilot on for mysess')
      expect(receivedBody).toEqual({ name: 'mysess', enabled: true })
    } finally {
      server.stop()
    }
  })

  test('autopilot off posts correct body and prints success', async () => {
    let receivedBody: any = null
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.url.includes('/api/autopilot') && req.method === 'POST') {
          return req.json().then((body: any) => {
            receivedBody = body
            return new Response('ok', { status: 200 })
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const result = await runCli(['autopilot', 'mysess', 'off'], {
        HUB_URL: `http://localhost:${server.port}`,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('autopilot off for mysess')
      expect(receivedBody).toEqual({ name: 'mysess', enabled: false })
    } finally {
      server.stop()
    }
  })

  test('autopilot exits non-zero on non-2xx response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.url.includes('/api/autopilot')) {
          return new Response('session not found', { status: 404 })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const result = await runCli(['autopilot', 'mysess', 'on'], {
        HUB_URL: `http://localhost:${server.port}`,
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('autopilot request failed')
    } finally {
      server.stop()
    }
  })
})
