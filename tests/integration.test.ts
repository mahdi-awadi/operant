// tests/integration.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { rmSync } from 'fs'
import { SessionRegistry } from '../src/session-registry'
import { SocketServer } from '../src/socket-server'
import { PermissionEngine } from '../src/permission-engine'
import { MessageRouter } from '../src/message-router'
import { resolveSession, injectContext } from '../src/profiles'
import type { FrontendSource } from '../src/types'
import { connect } from 'net'
import { renderVerificationResult } from '../src/frontends/telegram'
import type { VerificationResult } from '../src/verification'

const TEST_SOCK = join(import.meta.dir, '.test-integration.sock')

describe('integration: shim → daemon flow', () => {
  let registry: SessionRegistry
  let socketServer: SocketServer
  let permissions: PermissionEngine
  let router: MessageRouter
  const deliveredToFrontend: Array<{ sessionName: string; text: string }> = []
  const sentToSession: Array<{ path: string; content: string }> = []

  beforeEach(async () => {
    deliveredToFrontend.length = 0
    sentToSession.length = 0
    rmSync(TEST_SOCK, { force: true })

    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    permissions = new PermissionEngine(registry, () => {})

    socketServer = new SocketServer(registry, TEST_SOCK)

    router = new MessageRouter(
      registry,
      (path, content) => {
        sentToSession.push({ path, content })
        return socketServer.sendToSession(path, {
          type: 'channel_message',
          content,
          meta: { source: 'operant', frontend: 'test', user: 'test', session: '' },
        })
      },
      (sessionName, text) => {
        deliveredToFrontend.push({ sessionName, text })
      },
    )

    socketServer.on('tool_call', (path: string, name: string, args: Record<string, unknown>) => {
      if (name === 'reply') {
        router.routeFromSession(path, args.text as string)
        socketServer.sendToSession(path, {
          type: 'tool_result',
          name: 'reply',
          result: 'sent',
        })
      }
    })

    await socketServer.start()
  })

  afterEach(async () => {
    await socketServer.stop()
    rmSync(TEST_SOCK, { force: true })
  })

  test('full message round-trip: frontend → session → frontend', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/myproject' }) + '\n')

    const regData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const regMsg = JSON.parse(regData.trim())
    expect(regMsg.type).toBe('registered')
    expect(regMsg.sessionName).toBe('myproject')

    router.routeToSession('myproject', 'hello claude', 'web', 'user1')

    const msgData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const channelMsg = JSON.parse(msgData.trim())
    expect(channelMsg.type).toBe('channel_message')
    expect(channelMsg.content).toBe('hello claude')

    sock.write(JSON.stringify({ type: 'tool_call', name: 'reply', arguments: { text: 'hello human' } }) + '\n')

    await new Promise(r => setTimeout(r, 100))
    expect(deliveredToFrontend.length).toBe(1)
    expect(deliveredToFrontend[0].text).toBe('hello human')

    sock.end()
  })

  test('permission auto-approve for trusted session', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/trusted' }) + '\n')
    await new Promise<string>(resolve => { sock.once('data', chunk => resolve(chunk.toString())) })

    registry.setTrust('/home/user/trusted:0', 'auto')

    socketServer.on('permission_request', (path: string, msg: any) => {
      const response = permissions.handle(path, msg)
      if (response) {
        socketServer.sendToSession(path, {
          type: 'permission_response',
          requestId: response.requestId,
          behavior: response.behavior,
        })
      }
    })

    sock.write(JSON.stringify({
      type: 'permission_request',
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: 'ls',
    }) + '\n')

    const data = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const permMsg = JSON.parse(data.trim())
    expect(permMsg.type).toBe('permission_response')
    expect(permMsg.behavior).toBe('allow')

    sock.end()
  })

  test('silent tool (Read) auto-allowed without escalation', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/silenttest' }) + '\n')
    await new Promise<string>(resolve => { sock.once('data', chunk => resolve(chunk.toString())) })

    // Track forwarded (escalated) requests
    const forwardedReqs: any[] = []
    const localPermissions = new PermissionEngine(registry, (req) => forwardedReqs.push(req))

    socketServer.on('permission_request', (path: string, msg: any) => {
      const response = localPermissions.handle(path, {
        requestId: msg.requestId,
        toolName: msg.toolName,
        description: msg.description,
        inputPreview: msg.inputPreview ?? '',
        toolArgs: msg.toolArgs ?? {},
      })
      if (response) {
        socketServer.sendToSession(path, {
          type: 'permission_response',
          requestId: response.requestId,
          behavior: response.behavior,
        })
      }
    })

    // Send permission_request for Read (silent tool)
    sock.write(JSON.stringify({
      type: 'permission_request',
      requestId: 'silent1',
      toolName: 'Read',
      description: 'Read a file',
      inputPreview: '{}',
      toolArgs: {},
    }) + '\n')

    // Read response — should be auto-allowed
    const data = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const msg = JSON.parse(data.trim())
    expect(msg.type).toBe('permission_response')
    expect(msg.behavior).toBe('allow')
    expect(forwardedReqs.length).toBe(0) // never escalated

    sock.end()
  })

  test('rules set via registry are injected into outbound messages', async () => {
    // Build a context-injecting router — mirrors the wrapper in daemon.ts
    // so the assertion actually exercises the production injection path.
    const injectingRouter = new MessageRouter(
      registry,
      (path, content, meta) => {
        const session = registry.get(path)
        let enriched = content
        if (session) {
          const effective = resolveSession(
            { appliedProfile: session.appliedProfile, profileOverrides: session.profileOverrides },
            [],
          )
          const frontend = (meta.frontend ?? 'web') as FrontendSource
          enriched = injectContext(content, frontend, effective)
        }
        return socketServer.sendToSession(path, {
          type: 'channel_message',
          content: enriched,
          meta,
        })
      },
      () => {},
    )

    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/ruletest' }) + '\n')
    await new Promise<string>(resolve => { sock.once('data', chunk => resolve(chunk.toString())) })

    registry.setRules('/home/user/ruletest:0', ['no shortcuts', 'use TDD'])
    registry.setFacts('/home/user/ruletest:0', ['db is sqlite'])

    injectingRouter.routeToSession('ruletest', 'fix the bug', 'telegram', 'user1')

    const msgData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const channelMsg = JSON.parse(msgData.trim())
    expect(channelMsg.type).toBe('channel_message')
    expect(channelMsg.content).toContain('no shortcuts')
    expect(channelMsg.content).toContain('use TDD')
    expect(channelMsg.content).toContain('db is sqlite')
    expect(channelMsg.content).toContain('fix the bug')

    sock.end()
  })

  test('renderVerificationResult: pass sends ✅', async () => {
    const calls: Array<{ text: string; opts?: any }> = []
    const reply = async (text: string, opts?: any) => {
      calls.push({ text, opts })
    }
    const result: VerificationResult = { status: 'pass' }
    await renderVerificationResult(reply, 'myproj', result)
    expect(calls).toEqual([{ text: '✅', opts: undefined }])
  })

  test('renderVerificationResult: fail includes command, exit code, tail', async () => {
    const calls: Array<{ text: string; opts?: any }> = []
    const reply = async (text: string, opts?: any) => {
      calls.push({ text, opts })
    }
    const result: VerificationResult = {
      status: 'fail',
      failedCommand: 'bun test',
      exitCode: 2,
      tail: ['line1', 'line2'],
    }
    await renderVerificationResult(reply, 'myproj', result)
    expect(calls.length).toBe(1)
    expect(calls[0].text).toContain('myproj')
    expect(calls[0].text).toContain('bun test')
    expect(calls[0].text).toContain('exit 2')
    expect(calls[0].text).toContain('line1')
    expect(calls[0].text).toContain('line2')
    expect(calls[0].opts?.parse_mode).toBe('HTML')
  })

  test('renderVerificationResult: timeout, no-commands, already-running, spawn-failed', async () => {
    const scenarios: Array<{ result: VerificationResult; mustContain: string }> = [
      {
        result: { status: 'error', reason: 'timeout', details: 'bun test' },
        mustContain: '120s',
      },
      {
        result: { status: 'error', reason: 'no-commands', details: 'myproj' },
        mustContain: 'no verification commands',
      },
      {
        result: { status: 'error', reason: 'already-running', details: '/x' },
        mustContain: 'already running',
      },
      {
        result: { status: 'error', reason: 'spawn-failed', details: 'session not registered' },
        mustContain: 'session not registered',
      },
    ]
    for (const { result, mustContain } of scenarios) {
      const calls: string[] = []
      await renderVerificationResult(async (t: string) => {
        calls.push(t)
      }, 'myproj', result)
      expect(calls[0]).toContain(mustContain)
    }
  })
})
