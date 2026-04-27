// tests/shim-reconnect.test.ts
import { describe, test, expect } from 'bun:test'
import { createServer, type Server, type Socket } from 'net'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeBackoff,
  rejectPendingWithDisconnect,
  buildMcpToolResult,
} from '../src/shim'

describe('shim reconnect backoff', () => {
  test('first attempt waits 1s', () => {
    expect(computeBackoff(0)).toBe(1000)
  })

  test('schedule doubles up to 16s', () => {
    expect(computeBackoff(1)).toBe(2000)
    expect(computeBackoff(2)).toBe(4000)
    expect(computeBackoff(3)).toBe(8000)
    expect(computeBackoff(4)).toBe(16000)
  })

  test('caps at 30s and stays there', () => {
    expect(computeBackoff(5)).toBe(30000)
    expect(computeBackoff(10)).toBe(30000)
    expect(computeBackoff(1000)).toBe(30000)
  })

  test('never returns 0 — always waits at least one second', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff(i)).toBeGreaterThanOrEqual(1000)
    }
  })

  test('full 10-disconnect schedule matches spec', () => {
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
    expect(Array.from({ length: 10 }, (_, i) => computeBackoff(i))).toEqual(expected)
  })
})

describe('rejectPendingWithDisconnect', () => {
  test('resolves each pending call with an MCP error result', () => {
    const results: Array<ReturnType<typeof buildMcpToolResult>> = []
    const pending = new Map<string, (r: ReturnType<typeof buildMcpToolResult>) => void>()
    pending.set('reply', (r) => results.push(r))
    pending.set('edit_message', (r) => results.push(r))

    rejectPendingWithDisconnect(pending)

    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.isError).toBe(true)
      expect(r.content[0]!.text).toBe('hub disconnected, retry')
    }
  })

  test('clears the map in place so subsequent disconnects are no-ops', () => {
    const pending = new Map<string, (r: ReturnType<typeof buildMcpToolResult>) => void>()
    pending.set('reply', () => {})
    rejectPendingWithDisconnect(pending)
    expect(pending.size).toBe(0)

    // Second call with empty map should not throw.
    expect(() => rejectPendingWithDisconnect(pending)).not.toThrow()
  })

  test('is a no-op when no pending calls', () => {
    const pending = new Map<string, (r: ReturnType<typeof buildMcpToolResult>) => void>()
    expect(() => rejectPendingWithDisconnect(pending)).not.toThrow()
    expect(pending.size).toBe(0)
  })
})

// Integration: spawn the shim as a subprocess, point it at a fake daemon socket,
// and assert its connect/reconnect behavior.
describe('shim reconnect integration', () => {
  // Helpers scoped to this describe; each test creates a fresh tmp dir + server.
  // Track live sockets per-server so stop() can destroy them before close().
  // Without this, close() hangs waiting for the client to disconnect on its own.
  const serverSockets = new WeakMap<Server, Set<Socket>>()

  function startFakeDaemon(socketPath: string, onConnect: (sock: Socket) => void): Promise<Server> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>()
      const srv = createServer((sock) => {
        sockets.add(sock)
        sock.on('close', () => sockets.delete(sock))
        onConnect(sock)
      })
      serverSockets.set(srv, sockets)
      srv.once('error', reject)
      srv.listen(socketPath, () => resolve(srv))
    })
  }

  function stopFakeDaemon(srv: Server, socketPath: string): Promise<void> {
    return new Promise((resolve) => {
      // Destroy any live client sockets so close() doesn't hang waiting for them.
      const sockets = serverSockets.get(srv)
      if (sockets) {
        for (const s of sockets) { try { s.destroy() } catch {} }
        sockets.clear()
      }
      srv.close(() => {
        // Node/Bun does not always unlink the socket file on close.
        // Unlink defensively so a subsequent listen() on the same path succeeds.
        try { if (existsSync(socketPath)) unlinkSync(socketPath) } catch {}
        resolve()
      })
    })
  }

  function readMessages(sock: Socket, onMessage: (msg: any) => void): void {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.trim()) {
          try { onMessage(JSON.parse(line)) } catch {}
        }
      }
    })
  }

  function spawnShim(socketPath: string) {
    return Bun.spawn(['bun', 'run', 'src/shim.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_SOCKET: socketPath,
        HUB_TEST_BYPASS_SESSION_CHECK: '1',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  test('reconnects after the daemon restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-shim-rc-'))
    const socketPath = join(dir, 'hub.sock')
    const registers: number[] = []
    const stderrChunks: string[] = []

    const onConnect = (sock: Socket) => {
      readMessages(sock, (msg) => {
        if (msg.type === 'register') {
          registers.push(Date.now())
          sock.write(JSON.stringify({ type: 'registered', sessionName: 'test' }) + '\n')
        }
      })
    }

    let srv = await startFakeDaemon(socketPath, onConnect)
    const shim = spawnShim(socketPath)

    // Drain stderr for diagnostics on failure.
    ;(async () => {
      const reader = shim.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stderrChunks.push(decoder.decode(value))
      }
    })().catch(() => {})

    let phase = 'init'
    try {
      // Wait for first register
      phase = 'waiting-first-register'
      const deadline1 = Date.now() + 4000
      while (registers.length < 1 && Date.now() < deadline1) {
        await new Promise(r => setTimeout(r, 50))
      }
      if (registers.length !== 1) {
        throw new Error(`no initial register (got ${registers.length}); shim stderr:\n${stderrChunks.join('')}`)
      }

      // Restart the daemon on the same socket path
      phase = 'restarting-daemon'
      await stopFakeDaemon(srv, socketPath)
      await new Promise(r => setTimeout(r, 200))
      srv = await startFakeDaemon(socketPath, onConnect)

      // First backoff is 1s; allow up to 6s for re-register
      phase = 'waiting-second-register'
      const deadline2 = Date.now() + 6000
      while (registers.length < 2 && Date.now() < deadline2) {
        await new Promise(r => setTimeout(r, 50))
      }
      // TS narrows `registers.length` to literal `1` from the earlier check,
      // not seeing the async mutation above. Snapshot to a fresh number so
      // the comparison and expect() type-check correctly.
      const count2: number = registers.length
      if (count2 !== 2) {
        throw new Error(`no reconnect register (got ${count2}); phase=${phase}; shim stderr:\n${stderrChunks.join('')}`)
      }
      expect(count2).toBe(2)
    } finally {
      shim.kill('SIGTERM')
      // Guard against a stuck process hanging the test.
      await Promise.race([
        shim.exited,
        new Promise(r => setTimeout(r, 1000)),
      ])
      try { shim.kill('SIGKILL') } catch {}
      await stopFakeDaemon(srv, socketPath)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  test('clean SIGTERM does not trigger a reconnect attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-shim-term-'))
    const socketPath = join(dir, 'hub.sock')
    const connections: number[] = []

    const onConnect = (sock: Socket) => {
      connections.push(Date.now())
      readMessages(sock, (msg) => {
        if (msg.type === 'register') {
          sock.write(JSON.stringify({ type: 'registered', sessionName: 'test' }) + '\n')
        }
      })
    }

    const srv = await startFakeDaemon(socketPath, onConnect)
    const shim = spawnShim(socketPath)

    try {
      // Wait for initial connection
      const deadline = Date.now() + 5000
      while (connections.length < 1 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50))
      }
      expect(connections.length).toBe(1)

      // Clean shutdown: SIGTERM to the shim.
      shim.kill('SIGTERM')
      await shim.exited

      // Wait 2s (> first backoff) and assert no new connection arrived.
      const snapshot = connections.length
      await new Promise(r => setTimeout(r, 2000))
      expect(connections.length).toBe(snapshot)
    } finally {
      await stopFakeDaemon(srv, socketPath)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})
