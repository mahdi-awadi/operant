# Claude Code Operant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-session Claude Code operant with daemon + shim architecture, supporting Telegram, Web PWA, and CLI frontends.

**Architecture:** A long-running daemon listens on a Unix socket and manages session state, frontends, and screen processes. Tiny shim processes bridge each Claude Code session's stdio MCP connection to the daemon via the socket. Three frontends (Web, Telegram, CLI) share the same daemon API.

**Tech Stack:** Bun, TypeScript, @modelcontextprotocol/sdk, grammy, Bun built-in HTTP/WebSocket

---

## File Structure

```
claude-code-operant/
  package.json
  tsconfig.json
  src/
    daemon.ts              # Entry point: starts all daemon modules
    shim.ts                # MCP shim (Claude launches this)
    cli.ts                 # CLI entry point
    types.ts               # Shared types
    config.ts              # Config/session file I/O
    session-registry.ts    # In-memory session registry
    socket-server.ts       # Unix socket server (accepts shim connections)
    permission-engine.ts   # Per-session trust + permission relay
    screen-manager.ts      # Spawn/monitor/respawn screen sessions
    message-router.ts      # Route messages between sessions and frontends
    frontends/
      telegram.ts          # Telegram bot frontend
      web.ts               # HTTP + WebSocket server for PWA
      web-client.html      # Single-file PWA (HTML/CSS/JS)
  tests/
    config.test.ts
    session-registry.test.ts
    socket-server.test.ts
    permission-engine.test.ts
    screen-manager.test.ts
    message-router.test.ts
    shim.test.ts
    frontends/
      telegram.test.ts
      web.test.ts
    cli.test.ts
    integration.test.ts
```

---

## Task 1: Project Setup and Shared Types

**Files:**
- Create: `claude-code-operant/package.json`
- Create: `claude-code-operant/tsconfig.json`
- Create: `claude-code-operant/src/types.ts`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p claude-code-operant/src/frontends claude-code-operant/tests/frontends
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "claude-code-operant",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "daemon": "bun run src/daemon.ts",
    "shim": "bun run src/shim.ts",
    "cli": "bun run src/cli.ts",
    "test": "bun test",
    "build": "bun build src/daemon.ts --outfile dist/daemon.js --target bun && bun build src/shim.ts --outfile dist/shim.js --target bun && bun build src/cli.ts --outfile dist/cli.js --target bun"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "grammy": "^1.21.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Create shared types**

```typescript
// src/types.ts

export type TrustLevel = 'ask' | 'auto-approve'

export type SessionStatus = 'active' | 'disconnected' | 'respawning'

export type SessionConfig = {
  name: string
  trust: TrustLevel
  prefix: string
  uploadDir: string
  managed: boolean
}

export type SessionState = SessionConfig & {
  path: string
  status: SessionStatus
  connectedAt: number | null
}

export type OperantConfig = {
  webPort: number
  telegramToken: string
  telegramAllowFrom: string[]
  defaultTrust: TrustLevel
  defaultUploadDir: string
}

export type FrontendSource = 'telegram' | 'web' | 'cli'

export type InboundMessage = {
  sessionName: string
  text: string
  frontend: FrontendSource
  user: string
  files?: string[]
}

export type OutboundMessage = {
  sessionName: string
  text: string
  files?: string[]
}

export type PermissionRequest = {
  sessionName: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export type PermissionResponse = {
  requestId: string
  behavior: 'allow' | 'deny'
}

// Wire protocol between shim and daemon over Unix socket.
// Each message is a newline-delimited JSON object.
export type ShimToDaemon =
  | { type: 'register'; cwd: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'permission_request'; requestId: string; toolName: string; description: string; inputPreview: string }

export type DaemonToShim =
  | { type: 'registered'; sessionName: string }
  | { type: 'rejected'; reason: string }
  | { type: 'channel_message'; content: string; meta: Record<string, string> }
  | { type: 'tool_result'; name: string; result: unknown; isError?: boolean }
  | { type: 'permission_response'; requestId: string; behavior: 'allow' | 'deny' }
```

- [ ] **Step 5: Install dependencies**

```bash
cd claude-code-operant && bun install
```

- [ ] **Step 6: Commit**

```bash
git init
echo "node_modules/\ndist/\n.DS_Store" > .gitignore
git add -A
git commit -m "feat: project setup with shared types"
```

---

## Task 2: Config Module

**Files:**
- Create: `claude-code-operant/src/config.ts`
- Create: `claude-code-operant/tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadOperantConfig, saveOperantConfig, loadSessions, saveSessions, OPERANT_DIR } from '../src/config'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_DIR = join(import.meta.dir, '.test-operant-config')

describe('config', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('loadOperantConfig returns defaults when file missing', () => {
    const config = loadOperantConfig(TEST_DIR)
    expect(config.webPort).toBe(3000)
    expect(config.defaultTrust).toBe('ask')
    expect(config.telegramToken).toBe('')
    expect(config.telegramAllowFrom).toEqual([])
    expect(config.defaultUploadDir).toBe('.')
  })

  test('saveOperantConfig and loadOperantConfig roundtrip', () => {
    const config = {
      webPort: 4000,
      telegramToken: '123:AAH',
      defaultTrust: 'auto-approve' as const,
      defaultUploadDir: 'uploads/',
    }
    saveOperantConfig(config, TEST_DIR)
    const loaded = loadOperantConfig(TEST_DIR)
    expect(loaded).toEqual(config)
  })

  test('loadSessions returns empty object when file missing', () => {
    const sessions = loadSessions(TEST_DIR)
    expect(sessions).toEqual({})
  })

  test('saveSessions and loadSessions roundtrip', () => {
    const sessions = {
      '/home/user/frontend': {
        name: 'frontend',
        trust: 'ask' as const,
        prefix: '',
        uploadDir: '.',
        managed: false,
      },
    }
    saveSessions(sessions, TEST_DIR)
    const loaded = loadSessions(TEST_DIR)
    expect(loaded).toEqual(sessions)
  })

  test('saveOperantConfig creates directory with mode 0o700', () => {
    const config = loadOperantConfig(TEST_DIR)
    saveOperantConfig(config, TEST_DIR)
    expect(existsSync(TEST_DIR)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/config.test.ts
```

Expected: FAIL — module `../src/config` does not exist.

- [ ] **Step 3: Implement config module**

```typescript
// src/config.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, homedir } from 'path'
import type { OperantConfig, SessionConfig, TrustLevel } from './types'

export const OPERANT_DIR = join(homedir(), '.claude', 'channels', 'operant')

function defaultConfig(): OperantConfig {
  return {
    webPort: 3000,
    telegramToken: '',
    telegramAllowFrom: [],
    defaultTrust: 'ask',
    defaultUploadDir: '.',
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(path: string, data: unknown): void {
  const dir = join(path, '..')
  ensureDir(dir)
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function loadOperantConfig(dir: string = OPERANT_DIR): OperantConfig {
  const raw = readJson<Partial<OperantConfig>>(join(dir, 'config.json'))
  if (!raw) return defaultConfig()
  return {
    webPort: raw.webPort ?? 3000,
    telegramToken: raw.telegramToken ?? '',
    telegramAllowFrom: raw.telegramAllowFrom ?? [],
    defaultTrust: raw.defaultTrust ?? 'ask',
    defaultUploadDir: raw.defaultUploadDir ?? '.',
  }
}

export function saveOperantConfig(config: OperantConfig, dir: string = OPERANT_DIR): void {
  writeJson(join(dir, 'config.json'), config)
}

export function loadSessions(dir: string = OPERANT_DIR): Record<string, SessionConfig> {
  return readJson<Record<string, SessionConfig>>(join(dir, 'sessions.json')) ?? {}
}

export function saveSessions(sessions: Record<string, SessionConfig>, dir: string = OPERANT_DIR): void {
  writeJson(join(dir, 'sessions.json'), sessions)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/config.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/config.ts tests/config.test.ts && git commit -m "feat: config module with file I/O"
```

---

## Task 3: Session Registry

**Files:**
- Create: `claude-code-operant/src/session-registry.ts`
- Create: `claude-code-operant/tests/session-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/session-registry.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionRegistry } from '../src/session-registry'

describe('SessionRegistry', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  })

  test('register adds a session', () => {
    const session = registry.register('/home/user/frontend')
    expect(session.name).toBe('frontend')
    expect(session.status).toBe('active')
    expect(session.path).toBe('/home/user/frontend')
    expect(session.trust).toBe('ask')
  })

  test('register rejects duplicate path', () => {
    registry.register('/home/user/frontend')
    expect(() => registry.register('/home/user/frontend')).toThrow('already registered')
  })

  test('register appends suffix on name collision', () => {
    registry.register('/home/alice/app')
    const s2 = registry.register('/home/bob/app')
    expect(s2.name).toBe('app-2')
  })

  test('disconnect marks session disconnected', () => {
    registry.register('/home/user/frontend')
    registry.disconnect('/home/user/frontend')
    const session = registry.get('/home/user/frontend')
    expect(session?.status).toBe('disconnected')
  })

  test('unregister removes session', () => {
    registry.register('/home/user/frontend')
    registry.unregister('/home/user/frontend')
    expect(registry.get('/home/user/frontend')).toBeUndefined()
  })

  test('list returns all sessions', () => {
    registry.register('/home/user/a')
    registry.register('/home/user/b')
    expect(registry.list().length).toBe(2)
  })

  test('rename changes display name', () => {
    registry.register('/home/user/frontend')
    registry.rename('/home/user/frontend', 'my-app')
    expect(registry.get('/home/user/frontend')?.name).toBe('my-app')
  })

  test('findByName resolves path from display name', () => {
    registry.register('/home/user/frontend')
    expect(registry.findByName('frontend')).toBe('/home/user/frontend')
  })

  test('setTrust changes trust level', () => {
    registry.register('/home/user/frontend')
    registry.setTrust('/home/user/frontend', 'auto-approve')
    expect(registry.get('/home/user/frontend')?.trust).toBe('auto-approve')
  })

  test('setPrefix changes prefix', () => {
    registry.register('/home/user/frontend')
    registry.setPrefix('/home/user/frontend', 'You are a Next.js expert.')
    expect(registry.get('/home/user/frontend')?.prefix).toBe('You are a Next.js expert.')
  })

  test('restoreFrom loads saved sessions as disconnected', () => {
    const saved = {
      '/home/user/frontend': {
        name: 'frontend',
        trust: 'auto-approve' as const,
        prefix: 'test',
        uploadDir: '.',
        managed: true,
      },
    }
    registry.restoreFrom(saved)
    const s = registry.get('/home/user/frontend')
    expect(s?.name).toBe('frontend')
    expect(s?.status).toBe('disconnected')
    expect(s?.trust).toBe('auto-approve')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/session-registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement session registry**

```typescript
// src/session-registry.ts
import { basename } from 'path'
import type { SessionState, SessionConfig, TrustLevel } from './types'

type RegistryOptions = {
  defaultTrust: TrustLevel
  defaultUploadDir: string
}

export class SessionRegistry {
  private sessions = new Map<string, SessionState>()
  private options: RegistryOptions

  constructor(options: RegistryOptions) {
    this.options = options
  }

  register(path: string, overrides?: Partial<SessionConfig>): SessionState {
    if (this.sessions.has(path)) {
      throw new Error(`Session for ${path} already registered`)
    }
    const baseName = overrides?.name ?? basename(path)
    const name = this.uniqueName(baseName)
    const session: SessionState = {
      path,
      name,
      trust: overrides?.trust ?? this.options.defaultTrust,
      prefix: overrides?.prefix ?? '',
      uploadDir: overrides?.uploadDir ?? this.options.defaultUploadDir,
      managed: overrides?.managed ?? false,
      status: 'active',
      connectedAt: Date.now(),
    }
    this.sessions.set(path, session)
    return session
  }

  private uniqueName(base: string): string {
    const existing = new Set([...this.sessions.values()].map(s => s.name))
    if (!existing.has(base)) return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!existing.has(candidate)) return candidate
    }
  }

  disconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) s.status = 'disconnected'
  }

  reconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) {
      s.status = 'active'
      s.connectedAt = Date.now()
    }
  }

  unregister(path: string): void {
    this.sessions.delete(path)
  }

  get(path: string): SessionState | undefined {
    return this.sessions.get(path)
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
  }

  findByName(name: string): string | undefined {
    for (const [path, s] of this.sessions) {
      if (s.name === name) return path
    }
    return undefined
  }

  rename(path: string, newName: string): void {
    const s = this.sessions.get(path)
    if (s) s.name = newName
  }

  setTrust(path: string, trust: TrustLevel): void {
    const s = this.sessions.get(path)
    if (s) s.trust = trust
  }

  setPrefix(path: string, prefix: string): void {
    const s = this.sessions.get(path)
    if (s) s.prefix = prefix
  }

  restoreFrom(saved: Record<string, SessionConfig>): void {
    for (const [path, config] of Object.entries(saved)) {
      this.sessions.set(path, {
        ...config,
        path,
        status: 'disconnected',
        connectedAt: null,
      })
    }
  }

  toSaveFormat(): Record<string, SessionConfig> {
    const result: Record<string, SessionConfig> = {}
    for (const [path, s] of this.sessions) {
      result[path] = {
        name: s.name,
        trust: s.trust,
        prefix: s.prefix,
        uploadDir: s.uploadDir,
        managed: s.managed,
      }
    }
    return result
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/session-registry.test.ts
```

Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/session-registry.ts tests/session-registry.test.ts && git commit -m "feat: session registry with name collision handling"
```

---

## Task 4: Socket Server (Daemon Side)

**Files:**
- Create: `claude-code-operant/src/socket-server.ts`
- Create: `claude-code-operant/tests/socket-server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/socket-server.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SocketServer } from '../src/socket-server'
import { SessionRegistry } from '../src/session-registry'
import { join } from 'path'
import { rmSync } from 'fs'
import { connect } from 'net'

const TEST_SOCK = join(import.meta.dir, '.test-operant.sock')

function sendLine(sock: ReturnType<typeof connect>, data: object): void {
  sock.write(JSON.stringify(data) + '\n')
}

function readLines(sock: ReturnType<typeof connect>): Promise<object[]> {
  return new Promise((resolve) => {
    let buf = ''
    sock.on('data', (chunk) => { buf += chunk.toString() })
    sock.on('end', () => {
      resolve(buf.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
    })
  })
}

describe('SocketServer', () => {
  let server: SocketServer
  let registry: SessionRegistry

  beforeEach(async () => {
    rmSync(TEST_SOCK, { force: true })
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    server = new SocketServer(registry, TEST_SOCK)
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
    rmSync(TEST_SOCK, { force: true })
  })

  test('accepts connection and registers session on register message', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/myproject' })

    // Wait for response
    const data = await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg = JSON.parse(data.trim())
    expect(msg.type).toBe('registered')
    expect(msg.sessionName).toBe('myproject')
    expect(registry.list().length).toBe(1)
    sock.end()
  })

  test('rejects duplicate path', async () => {
    registry.register('/home/user/myproject')

    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/myproject' })

    const data = await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg = JSON.parse(data.trim())
    expect(msg.type).toBe('rejected')
    sock.end()
  })

  test('marks session disconnected when socket closes', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/myproject' })
    await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })

    sock.end()
    // Give the server time to process the close
    await new Promise(r => setTimeout(r, 100))
    expect(registry.get('/home/user/myproject')?.status).toBe('disconnected')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/socket-server.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement socket server**

```typescript
// src/socket-server.ts
import { createServer, type Server, type Socket } from 'net'
import { unlinkSync } from 'fs'
import type { SessionRegistry } from './session-registry'
import type { ShimToDaemon, DaemonToShim } from './types'
import { EventEmitter } from 'events'

export class SocketServer extends EventEmitter {
  private server: Server | null = null
  private registry: SessionRegistry
  private socketPath: string
  // Maps session path → socket connection
  private connections = new Map<string, Socket>()

  constructor(registry: SessionRegistry, socketPath: string) {
    super()
    this.registry = registry
    this.socketPath = socketPath
  }

  async start(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}

    this.server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve())
      this.server!.on('error', reject)
    })
  }

  private handleConnection(socket: Socket): void {
    let sessionPath: string | null = null
    let buffer = ''

    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (line.trim()) {
          this.handleMessage(socket, JSON.parse(line) as ShimToDaemon, () => sessionPath, (p) => { sessionPath = p })
        }
      }
    })

    socket.on('close', () => {
      if (sessionPath) {
        this.registry.disconnect(sessionPath)
        this.connections.delete(sessionPath)
        this.emit('session:disconnected', sessionPath)
      }
    })

    socket.on('error', () => {
      if (sessionPath) {
        this.registry.disconnect(sessionPath)
        this.connections.delete(sessionPath)
      }
    })
  }

  private handleMessage(
    socket: Socket,
    msg: ShimToDaemon,
    getPath: () => string | null,
    setPath: (p: string) => void,
  ): void {
    switch (msg.type) {
      case 'register': {
        const existing = this.registry.get(msg.cwd)
        if (existing && existing.status === 'active') {
          this.send(socket, { type: 'rejected', reason: `Session for ${msg.cwd} already registered` })
          socket.end()
          return
        }
        if (existing && existing.status === 'disconnected') {
          this.registry.reconnect(msg.cwd)
        } else {
          this.registry.register(msg.cwd)
        }
        setPath(msg.cwd)
        this.connections.set(msg.cwd, socket)
        const session = this.registry.get(msg.cwd)!
        this.send(socket, { type: 'registered', sessionName: session.name })
        this.emit('session:connected', msg.cwd)
        break
      }
      case 'tool_call': {
        const path = getPath()
        if (path) {
          this.emit('tool_call', path, msg.name, msg.arguments)
        }
        break
      }
      case 'permission_request': {
        const path = getPath()
        if (path) {
          this.emit('permission_request', path, msg)
        }
        break
      }
    }
  }

  send(socket: Socket, msg: DaemonToShim): void {
    socket.write(JSON.stringify(msg) + '\n')
  }

  sendToSession(path: string, msg: DaemonToShim): boolean {
    const socket = this.connections.get(path)
    if (!socket || socket.destroyed) return false
    this.send(socket, msg)
    return true
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.end()
    }
    this.connections.clear()
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
    try { unlinkSync(this.socketPath) } catch {}
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/socket-server.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/socket-server.ts tests/socket-server.test.ts && git commit -m "feat: Unix socket server for shim connections"
```

---

## Task 5: MCP Shim

**Files:**
- Create: `claude-code-operant/src/shim.ts`
- Create: `claude-code-operant/tests/shim.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/shim.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createServer, type Server, type Socket } from 'net'
import { join } from 'path'
import { rmSync } from 'fs'
import { parseShimMessage, buildMcpToolResult, buildMcpNotification } from '../src/shim'

describe('shim helpers', () => {
  test('parseShimMessage parses register', () => {
    const msg = parseShimMessage('{"type":"registered","sessionName":"frontend"}')
    expect(msg.type).toBe('registered')
    if (msg.type === 'registered') {
      expect(msg.sessionName).toBe('frontend')
    }
  })

  test('buildMcpToolResult formats MCP response', () => {
    const result = buildMcpToolResult('sent (id: 42)')
    expect(result.content).toEqual([{ type: 'text', text: 'sent (id: 42)' }])
  })

  test('buildMcpNotification creates channel notification', () => {
    const notif = buildMcpNotification('hello', { source: 'operant', session: 'frontend' })
    expect(notif.method).toBe('notifications/claude/channel')
    expect(notif.params.content).toBe('hello')
    expect(notif.params.meta.source).toBe('operant')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/shim.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement shim**

```typescript
// src/shim.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect } from 'net'
import { join } from 'path'
import { homedir } from 'os'
import type { DaemonToShim, ShimToDaemon } from './types'

const SOCKET_PATH = process.env.OPERANT_SOCKET ?? join(homedir(), '.claude', 'channels', 'operant', 'operant.sock')

// Exported helpers for testing
export function parseShimMessage(line: string): DaemonToShim {
  return JSON.parse(line) as DaemonToShim
}

export function buildMcpToolResult(text: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

export function buildMcpNotification(content: string, meta: Record<string, string>) {
  return {
    method: 'notifications/claude/channel' as const,
    params: { content, meta },
  }
}

// Only run main when executed directly (not imported for tests)
if (import.meta.main) {
  main()
}

function main() {
  const cwd = process.cwd()
  const daemon = connect(SOCKET_PATH)
  let registered = false

  const mcp = new Server(
    { name: 'claude-code-operant', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions: [
        'This session is connected to Claude Code Operant — a multi-project management system.',
        'Messages arrive from the operant frontends (Telegram, Web, CLI).',
        'Reply with the reply tool — pass the text you want to send back.',
        'The operant routes your replies to the user on whichever frontend they are using.',
      ].join('\n'),
    },
  )

  // Tool definitions — same interface as official Telegram plugin
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Reply to the user via the operant. Text is routed to all connected frontends.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach.',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a previously sent message. Edits do not trigger push notifications.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['message_id', 'text'],
        },
      },
    ],
  }))

  // Forward tool calls to daemon
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    return new Promise((resolve) => {
      const handler = (chunk: Buffer) => {
        const lines = chunk.toString().trim().split('\n')
        for (const line of lines) {
          const msg = parseShimMessage(line)
          if (msg.type === 'tool_result' && msg.name === name) {
            daemon.off('data', handler)
            resolve(msg.isError
              ? buildMcpToolResult(String(msg.result), true)
              : buildMcpToolResult(String(msg.result))
            )
            return
          }
        }
      }
      daemon.on('data', handler)
      sendToDaemon({ type: 'tool_call', name, arguments: args })
    })
  })

  // Forward permission requests from Claude to daemon
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      sendToDaemon({
        type: 'permission_request',
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      })
    },
  )

  // Handle messages from daemon
  let daemonBuffer = ''
  daemon.on('data', (chunk) => {
    daemonBuffer += chunk.toString()
    let idx: number
    while ((idx = daemonBuffer.indexOf('\n')) !== -1) {
      const line = daemonBuffer.slice(0, idx)
      daemonBuffer = daemonBuffer.slice(idx + 1)
      if (line.trim()) handleDaemonMessage(parseShimMessage(line))
    }
  })

  function handleDaemonMessage(msg: DaemonToShim): void {
    switch (msg.type) {
      case 'registered':
        registered = true
        process.stderr.write(`operant shim: registered as "${msg.sessionName}"\n`)
        break
      case 'rejected':
        process.stderr.write(`operant shim: rejected — ${msg.reason}\n`)
        process.exit(1)
        break
      case 'channel_message':
        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: msg.content, meta: msg.meta },
        }).catch((err) => {
          process.stderr.write(`operant shim: failed to deliver message: ${err}\n`)
        })
        break
      case 'permission_response':
        mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: msg.requestId, behavior: msg.behavior },
        }).catch((err) => {
          process.stderr.write(`operant shim: failed to relay permission: ${err}\n`)
        })
        break
    }
  }

  function sendToDaemon(msg: ShimToDaemon): void {
    daemon.write(JSON.stringify(msg) + '\n')
  }

  daemon.on('connect', () => {
    sendToDaemon({ type: 'register', cwd })
  })

  daemon.on('error', (err) => {
    process.stderr.write(`operant shim: daemon connection error: ${err.message}\n`)
    process.stderr.write(`operant shim: is the daemon running? Start with: bun run daemon\n`)
    process.exit(1)
  })

  daemon.on('close', () => {
    process.stderr.write('operant shim: daemon disconnected\n')
    process.exit(0)
  })

  // Start MCP stdio transport
  mcp.connect(new StdioServerTransport()).catch((err) => {
    process.stderr.write(`operant shim: MCP connect failed: ${err}\n`)
    process.exit(1)
  })

  // Shutdown on stdin close (Claude Code exited)
  process.stdin.on('end', () => {
    daemon.end()
    process.exit(0)
  })
  process.on('SIGTERM', () => { daemon.end(); process.exit(0) })
  process.on('SIGINT', () => { daemon.end(); process.exit(0) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/shim.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/shim.ts tests/shim.test.ts && git commit -m "feat: MCP shim bridging stdio to daemon socket"
```

---

## Task 6: Permission Engine

**Files:**
- Create: `claude-code-operant/src/permission-engine.ts`
- Create: `claude-code-operant/tests/permission-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/permission-engine.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { PermissionEngine } from '../src/permission-engine'
import { SessionRegistry } from '../src/session-registry'

describe('PermissionEngine', () => {
  let registry: SessionRegistry
  let engine: PermissionEngine
  const forwarded: Array<{ sessionName: string; requestId: string }> = []

  beforeEach(() => {
    forwarded.length = 0
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    engine = new PermissionEngine(registry, (req) => {
      forwarded.push({ sessionName: req.sessionName, requestId: req.requestId })
    })
  })

  test('auto-approve returns allow immediately', () => {
    registry.register('/home/user/trusted')
    registry.setTrust('/home/user/trusted', 'auto-approve')
    const result = engine.handle('/home/user/trusted', {
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: 'ls',
    })
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(forwarded.length).toBe(0)
  })

  test('ask mode forwards to callback and returns null', () => {
    registry.register('/home/user/untrusted')
    const result = engine.handle('/home/user/untrusted', {
      requestId: 'fghij',
      toolName: 'Bash',
      description: 'run rm',
      inputPreview: 'rm -rf /',
    })
    expect(result).toBeNull()
    expect(forwarded.length).toBe(1)
    expect(forwarded[0].requestId).toBe('fghij')
  })

  test('resolve sends stored response', () => {
    registry.register('/home/user/untrusted')
    engine.handle('/home/user/untrusted', {
      requestId: 'fghij',
      toolName: 'Bash',
      description: 'run rm',
      inputPreview: 'rm -rf /',
    })
    const response = engine.resolve('fghij', 'deny')
    expect(response).toEqual({ requestId: 'fghij', behavior: 'deny' })
  })

  test('resolve returns null for unknown requestId', () => {
    expect(engine.resolve('zzzzz', 'allow')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/permission-engine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement permission engine**

```typescript
// src/permission-engine.ts
import type { SessionRegistry } from './session-registry'
import type { PermissionRequest, PermissionResponse } from './types'

type PermissionInput = {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

type PendingPermission = {
  sessionPath: string
  requestId: string
}

export class PermissionEngine {
  private registry: SessionRegistry
  private onForward: (req: PermissionRequest) => void
  private pending = new Map<string, PendingPermission>()

  constructor(
    registry: SessionRegistry,
    onForward: (req: PermissionRequest) => void,
  ) {
    this.registry = registry
    this.onForward = onForward
  }

  handle(sessionPath: string, input: PermissionInput): PermissionResponse | null {
    const session = this.registry.get(sessionPath)
    if (!session) return null

    if (session.trust === 'auto-approve') {
      return { requestId: input.requestId, behavior: 'allow' }
    }

    // Forward to user
    this.pending.set(input.requestId, { sessionPath, requestId: input.requestId })
    this.onForward({
      sessionName: session.name,
      requestId: input.requestId,
      toolName: input.toolName,
      description: input.description,
      inputPreview: input.inputPreview,
    })
    return null
  }

  resolve(requestId: string, behavior: 'allow' | 'deny'): PermissionResponse | null {
    const pending = this.pending.get(requestId)
    if (!pending) return null
    this.pending.delete(requestId)
    return { requestId, behavior }
  }

  getSessionPath(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionPath
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/permission-engine.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/permission-engine.ts tests/permission-engine.test.ts && git commit -m "feat: permission engine with auto-approve and ask modes"
```

---

## Task 7: Message Router

**Files:**
- Create: `claude-code-operant/src/message-router.ts`
- Create: `claude-code-operant/tests/message-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/message-router.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MessageRouter } from '../src/message-router'
import { SessionRegistry } from '../src/session-registry'

describe('MessageRouter', () => {
  let registry: SessionRegistry
  let router: MessageRouter
  const sent: Array<{ path: string; content: string }> = []
  const delivered: Array<{ sessionName: string; text: string }> = []

  beforeEach(() => {
    sent.length = 0
    delivered.length = 0
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    router = new MessageRouter(
      registry,
      (path, content, meta) => { sent.push({ path, content }); return true },
      (sessionName, text, files) => { delivered.push({ sessionName, text }) },
    )
  })

  test('routeToSession sends to active session with prefix', () => {
    registry.register('/home/user/frontend')
    registry.setPrefix('/home/user/frontend', 'You are a Next.js expert.')
    router.routeToSession('frontend', 'fix the login', 'telegram', 'user1')
    expect(sent.length).toBe(1)
    expect(sent[0].content).toBe('You are a Next.js expert. fix the login')
  })

  test('routeToSession sends without prefix when empty', () => {
    registry.register('/home/user/frontend')
    router.routeToSession('frontend', 'fix the login', 'telegram', 'user1')
    expect(sent[0].content).toBe('fix the login')
  })

  test('routeToSession returns false for unknown session', () => {
    const ok = router.routeToSession('unknown', 'hello', 'telegram', 'user1')
    expect(ok).toBe(false)
  })

  test('routeFromSession delivers to frontends', () => {
    registry.register('/home/user/frontend')
    router.routeFromSession('/home/user/frontend', 'done!', [])
    expect(delivered.length).toBe(1)
    expect(delivered[0].sessionName).toBe('frontend')
    expect(delivered[0].text).toBe('done!')
  })

  test('broadcast sends to all active sessions', () => {
    registry.register('/home/user/a')
    registry.register('/home/user/b')
    router.broadcast('update deps', 'telegram', 'user1')
    expect(sent.length).toBe(2)
  })

  test('parseTargetedMessage extracts session name', () => {
    const result = router.parseTargetedMessage('/frontend fix the bug')
    expect(result).toEqual({ sessionName: 'frontend', text: 'fix the bug' })
  })

  test('parseTargetedMessage returns null for plain text', () => {
    expect(router.parseTargetedMessage('fix the bug')).toBeNull()
  })

  test('parseTargetedMessage returns null for commands', () => {
    expect(router.parseTargetedMessage('/list')).toBeNull()
    expect(router.parseTargetedMessage('/spawn x y')).toBeNull()
    expect(router.parseTargetedMessage('/all hello')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/message-router.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement message router**

```typescript
// src/message-router.ts
import type { SessionRegistry } from './session-registry'
import type { FrontendSource } from './types'

const RESERVED_COMMANDS = new Set([
  'list', 'status', 'spawn', 'kill', 'rename', 'trust', 'prefix', 'all',
  'start', 'help',
])

type SendToSessionFn = (path: string, content: string, meta: Record<string, string>) => boolean
type DeliverToFrontendsFn = (sessionName: string, text: string, files?: string[]) => void

export class MessageRouter {
  private registry: SessionRegistry
  private sendToSession: SendToSessionFn
  private deliverToFrontends: DeliverToFrontendsFn

  constructor(
    registry: SessionRegistry,
    sendToSession: SendToSessionFn,
    deliverToFrontends: DeliverToFrontendsFn,
  ) {
    this.registry = registry
    this.sendToSession = sendToSession
    this.deliverToFrontends = deliverToFrontends
  }

  routeToSession(sessionName: string, text: string, frontend: FrontendSource, user: string): boolean {
    const path = this.registry.findByName(sessionName)
    if (!path) return false
    const session = this.registry.get(path)
    if (!session || session.status !== 'active') return false

    const content = session.prefix ? `${session.prefix} ${text}` : text
    const meta: Record<string, string> = {
      source: 'operant',
      frontend,
      user,
      session: sessionName,
    }
    return this.sendToSession(path, content, meta)
  }

  routeFromSession(path: string, text: string, files?: string[]): void {
    const session = this.registry.get(path)
    if (!session) return
    this.deliverToFrontends(session.name, text, files)
  }

  broadcast(text: string, frontend: FrontendSource, user: string): void {
    for (const session of this.registry.list()) {
      if (session.status === 'active') {
        this.routeToSession(session.name, text, frontend, user)
      }
    }
  }

  parseTargetedMessage(text: string): { sessionName: string; text: string } | null {
    const match = text.match(/^\/(\S+)\s+(.+)$/s)
    if (!match) return null
    const name = match[1]
    // Don't treat reserved commands as session targets
    if (RESERVED_COMMANDS.has(name)) return null
    // Check if this name exists as a session
    const path = this.registry.findByName(name)
    if (!path) return null
    return { sessionName: name, text: match[2] }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/message-router.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/message-router.ts tests/message-router.test.ts && git commit -m "feat: message router with prefix, broadcast, and targeted messages"
```

---

## Task 8: Screen Manager

**Files:**
- Create: `claude-code-operant/src/screen-manager.ts`
- Create: `claude-code-operant/tests/screen-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/screen-manager.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ScreenManager } from '../src/screen-manager'

describe('ScreenManager', () => {
  let manager: ScreenManager

  beforeEach(() => {
    manager = new ScreenManager()
  })

  afterEach(async () => {
    await manager.killAll()
  })

  test('buildScreenCommand creates correct command', () => {
    const cmd = manager.buildScreenCommand('operant-frontend', '/home/user/frontend', 'bun run src/shim.ts')
    expect(cmd).toBe('screen -dmS operant-frontend bash -c \'cd /home/user/frontend && bun run src/shim.ts\'')
  })

  test('isScreenRunning returns false for non-existent screen', async () => {
    const running = await manager.isScreenRunning('operant-nonexistent-12345')
    expect(running).toBe(false)
  })

  test('listScreens returns array', async () => {
    const screens = await manager.listScreens()
    expect(Array.isArray(screens)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/screen-manager.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement screen manager**

```typescript
// src/screen-manager.ts
import { $ } from 'bun'

type ManagedScreen = {
  screenName: string
  projectPath: string
  respawnEnabled: boolean
}

export class ScreenManager {
  private managed = new Map<string, ManagedScreen>()
  private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

  buildScreenCommand(screenName: string, projectPath: string, shimCommand: string): string {
    return `screen -dmS ${screenName} bash -c 'cd ${projectPath} && ${shimCommand}'`
  }

  async spawn(name: string, projectPath: string, shimCommand: string): Promise<void> {
    const screenName = `operant-${name}`
    const cmd = this.buildScreenCommand(screenName, projectPath, shimCommand)
    await $`bash -c ${cmd}`.quiet()
    this.managed.set(name, { screenName, projectPath, respawnEnabled: true })
  }

  async kill(name: string): Promise<void> {
    const entry = this.managed.get(name)
    if (!entry) return
    entry.respawnEnabled = false
    const timer = this.respawnTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.respawnTimers.delete(name)
    }
    try {
      await $`screen -S ${entry.screenName} -X quit`.quiet()
    } catch {
      // screen may already be dead
    }
    this.managed.delete(name)
  }

  async killAll(): Promise<void> {
    for (const name of [...this.managed.keys()]) {
      await this.kill(name)
    }
  }

  async isScreenRunning(screenName: string): Promise<boolean> {
    try {
      const result = await $`screen -list`.quiet().text()
      return result.includes(screenName)
    } catch {
      // screen -list exits with code 1 when screens exist but returns output
      try {
        const result = await $`screen -list 2>&1`.quiet().text()
        return result.includes(screenName)
      } catch {
        return false
      }
    }
  }

  async listScreens(): Promise<string[]> {
    try {
      const result = await $`screen -list 2>&1`.quiet().text()
      const lines = result.split('\n')
      return lines
        .filter(l => l.includes('.operant-'))
        .map(l => {
          const match = l.match(/\d+\.(operant-\S+)/)
          return match ? match[1] : ''
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  scheduleRespawn(name: string, shimCommand: string): void {
    const entry = this.managed.get(name)
    if (!entry || !entry.respawnEnabled) return

    this.respawnTimers.set(name, setTimeout(async () => {
      this.respawnTimers.delete(name)
      if (!entry.respawnEnabled) return
      try {
        await this.spawn(name, entry.projectPath, shimCommand)
      } catch (err) {
        process.stderr.write(`operant: failed to respawn ${name}: ${err}\n`)
      }
    }, 3000))
  }

  isManaged(name: string): boolean {
    return this.managed.has(name)
  }

  getManagedNames(): string[] {
    return [...this.managed.keys()]
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/screen-manager.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/screen-manager.ts tests/screen-manager.test.ts && git commit -m "feat: screen manager for spawning and monitoring sessions"
```

---

## Task 9: Telegram Frontend

**Files:**
- Create: `claude-code-operant/src/frontends/telegram.ts`
- Create: `claude-code-operant/tests/frontends/telegram.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/frontends/telegram.test.ts
import { describe, test, expect } from 'bun:test'
import { formatSessionList, formatStatus, parseCommand, chunkText } from '../../src/frontends/telegram'

describe('telegram helpers', () => {
  test('formatSessionList with no sessions', () => {
    const text = formatSessionList([], null)
    expect(text).toContain('No sessions')
  })

  test('formatSessionList with sessions', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: '', uploadDir: '.', managed: false, connectedAt: Date.now() },
      { name: 'backend', status: 'disconnected' as const, path: '/home/user/backend', trust: 'auto-approve' as const, prefix: '', uploadDir: '.', managed: true, connectedAt: null },
    ]
    const text = formatSessionList(sessions, 'frontend')
    expect(text).toContain('frontend')
    expect(text).toContain('backend')
    expect(text).toContain('active')
    expect(text).toContain('disconnected')
  })

  test('formatStatus shows dashboard', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: 'test', uploadDir: '.', managed: false, connectedAt: Date.now() },
    ]
    const text = formatStatus(sessions)
    expect(text).toContain('frontend')
    expect(text).toContain('active')
  })

  test('parseCommand extracts command and args', () => {
    expect(parseCommand('/spawn frontend /home/user/frontend')).toEqual({
      command: 'spawn',
      args: ['frontend', '/home/user/frontend'],
    })
    expect(parseCommand('/list')).toEqual({ command: 'list', args: [] })
    expect(parseCommand('/all fix everything')).toEqual({
      command: 'all',
      args: ['fix', 'everything'],
    })
  })

  test('parseCommand returns null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  test('chunkText splits long messages', () => {
    const long = 'a'.repeat(5000)
    const chunks = chunkText(long, 4096)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBeLessThanOrEqual(4096)
  })

  test('chunkText returns single chunk for short messages', () => {
    const chunks = chunkText('short', 4096)
    expect(chunks).toEqual(['short'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/frontends/telegram.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement Telegram frontend**

```typescript
// src/frontends/telegram.ts
import { Bot, InlineKeyboard } from 'grammy'
import type { Context } from 'grammy'
import type { SessionState, PermissionRequest, FrontendSource } from '../types'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { ScreenManager } from '../screen-manager'
import type { SocketServer } from '../socket-server'
import { copyFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'

// Exported helpers for testing
export function formatSessionList(sessions: SessionState[], activeSession: string | null): string {
  if (sessions.length === 0) return 'No sessions connected.'
  return sessions.map(s => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const active = s.name === activeSession ? ' ← active' : ''
    const trust = s.trust === 'auto-approve' ? ' [trusted]' : ''
    return `${icon} ${s.name}${trust}${active}`
  }).join('\n')
}

export function formatStatus(sessions: SessionState[]): string {
  if (sessions.length === 0) return 'No sessions.'
  const lines = sessions.map(s => {
    const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
    const trust = s.trust === 'auto-approve' ? 'trusted' : 'ask'
    const prefix = s.prefix ? `prefix: "${s.prefix.slice(0, 30)}..."` : 'no prefix'
    const managed = s.managed ? 'managed' : 'manual'
    return `${icon} **${s.name}** (${s.status})\n   ${s.path}\n   ${trust} | ${managed} | ${prefix}`
  })
  return lines.join('\n\n')
}

export function parseCommand(text: string): { command: string; args: string[] } | null {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/)
  if (!match) return null
  return {
    command: match[1],
    args: match[2] ? match[2].split(/\s+/) : [],
  }
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Prefer splitting at newlines
    const newline = rest.lastIndexOf('\n', limit)
    const cut = newline > limit / 2 ? newline : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

type TelegramFrontendDeps = {
  token: string
  registry: SessionRegistry
  router: MessageRouter
  permissions: PermissionEngine
  screenManager: ScreenManager
  socketServer: SocketServer
  shimCommand: string
  allowFrom: string[]
}

export class TelegramFrontend {
  private bot: Bot
  private deps: TelegramFrontendDeps
  // Per-user active session (Telegram user ID → session display name)
  private activeSession = new Map<string, string>()

  constructor(deps: TelegramFrontendDeps) {
    this.deps = deps
    this.bot = new Bot(deps.token)
    this.setupHandlers()
  }

  private isAllowed(ctx: Context): boolean {
    const from = ctx.from
    if (!from) return false
    return this.deps.allowFrom.length === 0 || this.deps.allowFrom.includes(String(from.id))
  }

  private setupHandlers(): void {
    this.bot.command('list', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.deps.registry.list()
      const userId = String(ctx.from!.id)
      const active = this.activeSession.get(userId) ?? null
      const text = formatSessionList(sessions, active)

      if (sessions.length === 0) {
        await ctx.reply(text)
        return
      }

      const keyboard = new InlineKeyboard()
      for (const s of sessions) {
        keyboard.text(s.name, `select:${s.name}`).row()
      }
      await ctx.reply(text, { reply_markup: keyboard })
    })

    this.bot.command('status', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.deps.registry.list()
      await ctx.reply(formatStatus(sessions))
    })

    this.bot.command('spawn', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? []
      if (args.length < 2) {
        await ctx.reply('Usage: /spawn <name> <path>')
        return
      }
      const [name, path] = args
      try {
        await this.deps.screenManager.spawn(name, path, this.deps.shimCommand)
        await ctx.reply(`Spawning ${name} at ${path}...`)
      } catch (err) {
        await ctx.reply(`Failed: ${err}`)
      }
    })

    this.bot.command('kill', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const name = ctx.message?.text?.split(/\s+/)[1]
      if (!name) { await ctx.reply('Usage: /kill <name>'); return }
      await this.deps.screenManager.kill(name)
      await ctx.reply(`Killed ${name}`)
    })

    this.bot.command('rename', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? []
      if (args.length < 2) { await ctx.reply('Usage: /rename <old> <new>'); return }
      const path = this.deps.registry.findByName(args[0])
      if (!path) { await ctx.reply(`Session "${args[0]}" not found`); return }
      this.deps.registry.rename(path, args[1])
      await ctx.reply(`Renamed ${args[0]} → ${args[1]}`)
    })

    this.bot.command('trust', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? []
      if (args.length < 1) { await ctx.reply('Usage: /trust <name> [auto|ask]'); return }
      const path = this.deps.registry.findByName(args[0])
      if (!path) { await ctx.reply(`Session "${args[0]}" not found`); return }
      const session = this.deps.registry.get(path)!
      const newTrust = args[1] === 'auto' ? 'auto-approve' : args[1] === 'ask' ? 'ask' : (session.trust === 'auto-approve' ? 'ask' : 'auto-approve')
      this.deps.registry.setTrust(path, newTrust)
      await ctx.reply(`${args[0]} trust: ${newTrust}`)
    })

    this.bot.command('prefix', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const text = ctx.message?.text ?? ''
      const match = text.match(/^\/prefix\s+(\S+)\s+(.+)$/s)
      if (!match) { await ctx.reply('Usage: /prefix <name> <text>'); return }
      const path = this.deps.registry.findByName(match[1])
      if (!path) { await ctx.reply(`Session "${match[1]}" not found`); return }
      this.deps.registry.setPrefix(path, match[2])
      await ctx.reply(`Prefix for ${match[1]} set.`)
    })

    this.bot.command('all', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const text = ctx.message?.text?.replace(/^\/all\s+/, '') ?? ''
      if (!text) { await ctx.reply('Usage: /all <message>'); return }
      this.deps.router.broadcast(text, 'telegram', ctx.from!.username ?? String(ctx.from!.id))
      await ctx.reply(`Broadcast sent to ${this.deps.registry.list().filter(s => s.status === 'active').length} sessions`)
    })

    // Inline button handler for session selection
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data

      // Session selection
      if (data.startsWith('select:')) {
        const name = data.slice(7)
        const userId = String(ctx.from.id)
        this.activeSession.set(userId, name)
        await ctx.answerCallbackQuery({ text: `Active: ${name}` })
        await ctx.editMessageText(`Active session: ${name}`)
        return
      }

      // Permission responses
      const permMatch = data.match(/^perm:(allow|deny):(.+)$/)
      if (permMatch) {
        const [, behavior, requestId] = permMatch
        const response = this.deps.permissions.resolve(requestId, behavior as 'allow' | 'deny')
        if (response) {
          const sessionPath = this.deps.permissions.getSessionPath(requestId)
          if (sessionPath) {
            this.deps.socketServer.sendToSession(sessionPath, {
              type: 'permission_response',
              requestId: response.requestId,
              behavior: response.behavior,
            })
          }
        }
        const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
        await ctx.answerCallbackQuery({ text: label })
        const msg = ctx.callbackQuery.message
        if (msg && 'text' in msg && msg.text) {
          await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
        }
        return
      }

      await ctx.answerCallbackQuery()
    })

    // File uploads
    this.bot.on('message:document', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const userId = String(ctx.from!.id)
      const activeName = this.activeSession.get(userId)
      if (!activeName) { await ctx.reply('No active session. Use /list to select one.'); return }
      const path = this.deps.registry.findByName(activeName)
      if (!path) { await ctx.reply('Active session not found.'); return }
      const session = this.deps.registry.get(path)!

      const doc = ctx.message.document
      const file = await ctx.api.getFile(doc.file_id)
      if (!file.file_path) { await ctx.reply('Failed to download file.'); return }

      const url = `https://api.telegram.org/file/bot${this.deps.token}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const fileName = doc.file_name ?? `file-${Date.now()}`
      const uploadDir = join(path, session.uploadDir)
      mkdirSync(uploadDir, { recursive: true })
      const destPath = join(uploadDir, fileName)
      const { writeFileSync } = await import('fs')
      writeFileSync(destPath, buf)

      // Notify Claude
      this.deps.socketServer.sendToSession(path, {
        type: 'channel_message',
        content: `File "${fileName}" uploaded to ${destPath}`,
        meta: { source: 'operant', frontend: 'telegram', user: ctx.from!.username ?? String(ctx.from!.id), session: activeName },
      })

      await ctx.reply(`Uploaded ${fileName} to ${activeName}:${session.uploadDir}`)
    })

    // Plain text messages
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const text = ctx.message.text
      const userId = String(ctx.from!.id)
      const user = ctx.from!.username ?? userId

      // Check for targeted message (/<session-name> message)
      const targeted = this.deps.router.parseTargetedMessage(text)
      if (targeted) {
        const ok = this.deps.router.routeToSession(targeted.sessionName, targeted.text, 'telegram', user)
        if (!ok) await ctx.reply(`Session "${targeted.sessionName}" not found or not active.`)
        return
      }

      // Send to active session
      const activeName = this.activeSession.get(userId)
      if (!activeName) {
        await ctx.reply('No active session. Use /list to select one.')
        return
      }
      const ok = this.deps.router.routeToSession(activeName, text, 'telegram', user)
      if (!ok) {
        await ctx.reply(`Session "${activeName}" is not active.`)
      }
    })

    this.bot.catch((err) => {
      process.stderr.write(`operant telegram: handler error: ${err.error}\n`)
    })
  }

  // Called by daemon when Claude replies
  async deliverToUser(sessionName: string, text: string, _files?: string[]): Promise<void> {
    const chunks = chunkText(`[${sessionName}] ${text}`, 4096)
    for (const chatId of this.deps.allowFrom) {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk).catch(err => {
          process.stderr.write(`operant telegram: failed to send to ${chatId}: ${err}\n`)
        })
      }
    }
  }

  // Called by daemon when a permission needs user approval
  async deliverPermissionRequest(req: PermissionRequest): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${req.requestId}`)
      .text('❌ Deny', `perm:deny:${req.requestId}`)
    const text = `[${req.sessionName}] 🔐 ${req.toolName}: ${req.description}`
    for (const chatId of this.deps.allowFrom) {
      await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard }).catch(err => {
        process.stderr.write(`operant telegram: permission prompt failed: ${err}\n`)
      })
    }
  }

  async start(): Promise<void> {
    await this.bot.start({
      onStart: (info) => {
        process.stderr.write(`operant telegram: polling as @${info.username}\n`)
      },
    })
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/frontends/telegram.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/frontends/telegram.ts tests/frontends/telegram.test.ts && git commit -m "feat: Telegram frontend with commands, routing, and permissions"
```

---

## Task 10: Web PWA Frontend

**Files:**
- Create: `claude-code-operant/src/frontends/web.ts`
- Create: `claude-code-operant/src/frontends/web-client.html`
- Create: `claude-code-operant/tests/frontends/web.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/frontends/web.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'

describe('WebFrontend', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/home/user/frontend')
    web = new WebFrontend({
      port: 0, // random port
      registry,
      router: null as any, // not needed for API tests
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      shimCommand: 'bun run src/shim.ts',
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/sessions returns session list', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data.length).toBe(1)
    expect(data[0].name).toBe('frontend')
  })

  test('GET / serves HTML', async () => {
    const res = await fetch(`http://localhost:${web.port}/`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<!DOCTYPE html>')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/frontends/web.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create web client HTML**

```html
<!-- src/frontends/web-client.html -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Operant</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#1a1a2e">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; }
#sidebar { width: 260px; background: #16213e; border-right: 1px solid #0f3460; display: flex; flex-direction: column; }
#sidebar h2 { padding: 16px; font-size: 14px; color: #a0a0b0; text-transform: uppercase; letter-spacing: 1px; }
.session-item { padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 8px; }
.session-item:hover { background: #0f3460; }
.session-item.active { background: #0f3460; border-left: 3px solid #e94560; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; }
.status-dot.active { background: #4ade80; }
.status-dot.disconnected { background: #f87171; }
.status-dot.respawning { background: #fbbf24; }
.session-name { font-size: 14px; font-weight: 500; }
.badge { background: #e94560; color: white; border-radius: 10px; padding: 2px 6px; font-size: 11px; margin-left: auto; display: none; }
#main { flex: 1; display: flex; flex-direction: column; }
#header { padding: 12px 20px; background: #16213e; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 12px; }
#header h3 { font-size: 16px; }
#header .trust-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #0f3460; }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 8px 12px; border-radius: 8px; max-width: 80%; word-wrap: break-word; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }
.msg.from-user { background: #0f3460; align-self: flex-end; }
.msg.from-claude { background: #16213e; border: 1px solid #0f3460; align-self: flex-start; }
.msg.from-other { background: #1a1a2e; border: 1px solid #333; align-self: flex-start; font-style: italic; }
.msg .session-tag { font-size: 11px; color: #e94560; font-weight: 600; }
.permission-card { background: #2a1a3e; border: 1px solid #e94560; padding: 12px; border-radius: 8px; }
.permission-card .actions { display: flex; gap: 8px; margin-top: 8px; }
.permission-card button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn-allow { background: #4ade80; color: #000; }
.btn-deny { background: #f87171; color: #000; }
#input-area { padding: 12px 20px; background: #16213e; border-top: 1px solid #0f3460; display: flex; gap: 8px; }
#input-area input { flex: 1; background: #1a1a2e; border: 1px solid #0f3460; color: #e0e0e0; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
#input-area input:focus { border-color: #e94560; }
#input-area button { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; }
#toolbar { padding: 8px 16px; display: flex; gap: 8px; border-top: 1px solid #0f3460; }
#toolbar button { background: #0f3460; color: #a0a0b0; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
#toolbar button:hover { background: #e94560; color: white; }
.upload-zone { border: 2px dashed #0f3460; border-radius: 8px; padding: 20px; text-align: center; color: #a0a0b0; display: none; margin: 8px 20px; }
.upload-zone.active { display: block; border-color: #e94560; }
@media (max-width: 768px) {
  #sidebar { width: 60px; }
  .session-name, #sidebar h2 { display: none; }
  .session-item { justify-content: center; }
}
</style>
</head>
<body>
<div id="sidebar">
  <h2>Sessions</h2>
  <div id="session-list"></div>
  <div id="toolbar">
    <button onclick="promptSpawn()">+ Spawn</button>
  </div>
</div>
<div id="main">
  <div id="header">
    <h3 id="active-name">Select a session</h3>
    <span id="trust-badge" class="trust-badge" style="display:none"></span>
  </div>
  <div id="messages"></div>
  <div class="upload-zone" id="upload-zone">Drop file here to upload</div>
  <div id="input-area">
    <input type="text" id="msg-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendMsg()">
    <button onclick="sendMsg()">Send</button>
  </div>
</div>
<script>
let ws, activeSession = null, sessions = [], messagesBySession = {};

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

function handleWsMessage(msg) {
  if (msg.type === 'sessions') {
    sessions = msg.data;
    renderSessions();
  } else if (msg.type === 'message') {
    const key = msg.sessionName;
    if (!messagesBySession[key]) messagesBySession[key] = [];
    messagesBySession[key].push(msg);
    if (key === activeSession) renderMessages();
    else showBadge(key);
  } else if (msg.type === 'permission') {
    showPermission(msg);
  }
}

function renderSessions() {
  const el = document.getElementById('session-list');
  el.innerHTML = sessions.map(s => `
    <div class="session-item ${s.name === activeSession ? 'active' : ''}" onclick="selectSession('${s.name}')">
      <div class="status-dot ${s.status}"></div>
      <span class="session-name">${s.name}</span>
      <span class="badge" id="badge-${s.name}"></span>
    </div>
  `).join('');
}

function selectSession(name) {
  activeSession = name;
  const s = sessions.find(s => s.name === name);
  document.getElementById('active-name').textContent = name;
  const badge = document.getElementById('trust-badge');
  if (s) { badge.textContent = s.trust; badge.style.display = 'inline'; }
  renderSessions();
  renderMessages();
}

function renderMessages() {
  const el = document.getElementById('messages');
  const msgs = messagesBySession[activeSession] || [];
  el.innerHTML = msgs.map(m => {
    const cls = m.from === 'user' ? 'from-user' : m.sessionName !== activeSession ? 'from-other' : 'from-claude';
    const tag = m.sessionName !== activeSession ? `<div class="session-tag">[${m.sessionName}]</div>` : '';
    return `<div class="msg ${cls}">${tag}${escapeHtml(m.text)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function showBadge(sessionName) {
  const el = document.getElementById(`badge-${sessionName}`);
  if (el) { el.style.display = 'inline'; el.textContent = '●'; }
}

function showPermission(msg) {
  const el = document.getElementById('messages');
  const card = document.createElement('div');
  card.className = 'permission-card';
  card.innerHTML = `
    <div><strong>[${msg.sessionName}]</strong> 🔐 ${msg.toolName}</div>
    <div>${escapeHtml(msg.description)}</div>
    <div class="actions">
      <button class="btn-allow" onclick="respondPermission('${msg.requestId}','allow',this)">Allow</button>
      <button class="btn-deny" onclick="respondPermission('${msg.requestId}','deny',this)">Deny</button>
    </div>
  `;
  el.appendChild(card);
  el.scrollTop = el.scrollHeight;
}

function respondPermission(requestId, behavior, btn) {
  ws.send(JSON.stringify({ type: 'permission_response', requestId, behavior }));
  btn.parentElement.innerHTML = behavior === 'allow' ? '✅ Allowed' : '❌ Denied';
}

function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'message', text, sessionName: activeSession }));
  if (!messagesBySession[activeSession]) messagesBySession[activeSession] = [];
  messagesBySession[activeSession].push({ from: 'user', text, sessionName: activeSession });
  renderMessages();
  input.value = '';
}

function promptSpawn() {
  const name = prompt('Session name:');
  if (!name) return;
  const path = prompt('Project path:');
  if (!path) return;
  ws.send(JSON.stringify({ type: 'spawn', name, path }));
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Drag and drop file upload
const main = document.getElementById('main');
const uploadZone = document.getElementById('upload-zone');
main.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('active'); });
main.addEventListener('dragleave', () => uploadZone.classList.remove('active'));
main.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadZone.classList.remove('active');
  if (!activeSession) return;
  for (const file of e.dataTransfer.files) {
    const form = new FormData();
    form.append('file', file);
    form.append('sessionName', activeSession);
    await fetch('/api/upload', { method: 'POST', body: form });
  }
});

connect();
</script>
</body>
</html>
```

- [ ] **Step 4: Implement web server**

```typescript
// src/frontends/web.ts
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { SocketServer } from '../socket-server'
import type { ScreenManager } from '../screen-manager'
import type { PermissionRequest } from '../types'
import type { Server, ServerWebSocket } from 'bun'

type WebFrontendDeps = {
  port: number
  registry: SessionRegistry
  router: MessageRouter | null
  permissions: PermissionEngine | null
  socketServer: SocketServer | null
  screenManager: ScreenManager | null
  shimCommand: string
}

type WsData = { id: string }

export class WebFrontend {
  private deps: WebFrontendDeps
  private server: Server | null = null
  private clients = new Set<ServerWebSocket<WsData>>()
  private htmlContent: string
  port = 0

  constructor(deps: WebFrontendDeps) {
    this.deps = deps
    try {
      const dir = dirname(fileURLToPath(import.meta.url))
      this.htmlContent = readFileSync(join(dir, 'web-client.html'), 'utf8')
    } catch {
      this.htmlContent = '<!DOCTYPE html><html><body>Claude Code Operant</body></html>'
    }
  }

  async start(): Promise<void> {
    const self = this
    this.server = Bun.serve<WsData>({
      port: this.deps.port,
      fetch(req, server) {
        const url = new URL(req.url)

        if (url.pathname === '/ws') {
          const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID() } })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        if (url.pathname === '/api/sessions') {
          return Response.json(self.deps.registry.list())
        }

        if (url.pathname === '/api/upload' && req.method === 'POST') {
          return self.handleUpload(req)
        }

        return new Response(self.htmlContent, {
          headers: { 'content-type': 'text/html' },
        })
      },
      websocket: {
        open(ws) {
          self.clients.add(ws)
          ws.send(JSON.stringify({ type: 'sessions', data: self.deps.registry.list() }))
        },
        message(ws, message) {
          try {
            const msg = JSON.parse(String(message))
            self.handleWsMessage(ws, msg)
          } catch {}
        },
        close(ws) {
          self.clients.delete(ws)
        },
      },
    })
    this.port = this.server.port
  }

  private async handleUpload(req: Request): Promise<Response> {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const sessionName = form.get('sessionName') as string | null
    if (!file || !sessionName) return new Response('Missing file or session', { status: 400 })

    const path = this.deps.registry.findByName(sessionName)
    if (!path) return new Response('Session not found', { status: 404 })
    const session = this.deps.registry.get(path)!

    const uploadDir = join(path, session.uploadDir)
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(uploadDir, { recursive: true })
    const destPath = join(uploadDir, file.name)
    writeFileSync(destPath, Buffer.from(await file.arrayBuffer()))

    // Notify Claude
    this.deps.socketServer?.sendToSession(path, {
      type: 'channel_message',
      content: `File "${file.name}" uploaded to ${destPath}`,
      meta: { source: 'operant', frontend: 'web', user: 'web', session: sessionName },
    })

    return new Response('ok')
  }

  private handleWsMessage(ws: ServerWebSocket<WsData>, msg: any): void {
    switch (msg.type) {
      case 'message': {
        if (!this.deps.router) return
        const targeted = this.deps.router.parseTargetedMessage(msg.text)
        if (targeted) {
          this.deps.router.routeToSession(targeted.sessionName, targeted.text, 'web', 'web')
        } else if (msg.sessionName) {
          this.deps.router.routeToSession(msg.sessionName, msg.text, 'web', 'web')
        }
        break
      }
      case 'spawn': {
        this.deps.screenManager?.spawn(msg.name, msg.path, this.deps.shimCommand)
        break
      }
      case 'permission_response': {
        if (!this.deps.permissions) return
        const response = this.deps.permissions.resolve(msg.requestId, msg.behavior)
        if (response) {
          const sessionPath = this.deps.permissions.getSessionPath(msg.requestId)
          if (sessionPath) {
            this.deps.socketServer?.sendToSession(sessionPath, {
              type: 'permission_response',
              requestId: response.requestId,
              behavior: response.behavior,
            })
          }
        }
        break
      }
    }
  }

  broadcastToClients(msg: object): void {
    const data = JSON.stringify(msg)
    for (const client of this.clients) {
      client.send(data)
    }
  }

  deliverToUser(sessionName: string, text: string, files?: string[]): void {
    this.broadcastToClients({ type: 'message', sessionName, text, from: 'claude', files })
  }

  deliverPermissionRequest(req: PermissionRequest): void {
    this.broadcastToClients({ type: 'permission', ...req })
  }

  refreshSessions(): void {
    this.broadcastToClients({ type: 'sessions', data: this.deps.registry.list() })
  }

  async stop(): Promise<void> {
    this.server?.stop()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/frontends/web.test.ts
```

Expected: all 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd claude-code-operant && git add src/frontends/web.ts src/frontends/web-client.html tests/frontends/web.test.ts && git commit -m "feat: web PWA frontend with dashboard and chat"
```

---

## Task 11: CLI Frontend

**Files:**
- Create: `claude-code-operant/src/cli.ts`
- Create: `claude-code-operant/tests/cli.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd claude-code-operant && bun test tests/cli.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement CLI**

```typescript
// src/cli.ts
import { homedir } from 'os'
import { join } from 'path'

const OPERANT_URL = process.env.OPERANT_URL ?? 'http://localhost:3000'

export function parseCliArgs(args: string[]): { command: string; args: string[] } {
  if (args.length === 0) return { command: 'help', args: [] }
  const command = args[0]
  // For 'send' and 'prefix', join remaining args after name as a single string
  if ((command === 'send' || command === 'prefix') && args.length >= 3) {
    return { command, args: [args[1], args.slice(2).join(' ')] }
  }
  return { command, args: args.slice(1) }
}

const HELP = `
Claude Code Operant CLI

Usage:
  operant list                          Show all sessions
  operant status                        Dashboard view
  operant spawn <name> <path>           Launch session in screen
  operant kill <name>                   Stop a session
  operant send <name> <message>         Send message to a session
  operant trust <name> <auto|ask>       Set trust level
  operant prefix <name> <text>          Set command prefix
  operant rename <old> <new>            Rename a session
  operant upload <name> <file>          Upload file to project
  operant start                         Start the daemon
`.trim()

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${OPERANT_URL}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${OPERANT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

if (import.meta.main) {
  const { command, args } = parseCliArgs(process.argv.slice(2))

  try {
    switch (command) {
      case 'help':
        console.log(HELP)
        break

      case 'list':
      case 'status': {
        const sessions = await apiGet('/api/sessions')
        if (sessions.length === 0) {
          console.log('No sessions.')
        } else {
          for (const s of sessions) {
            const icon = s.status === 'active' ? '🟢' : s.status === 'respawning' ? '🟡' : '🔴'
            const trust = s.trust === 'auto-approve' ? ' [trusted]' : ''
            const prefix = s.prefix ? ` prefix="${s.prefix.slice(0, 40)}"` : ''
            console.log(`${icon} ${s.name} (${s.status})${trust}${prefix}`)
            if (command === 'status') console.log(`   ${s.path}`)
          }
        }
        break
      }

      case 'spawn': {
        if (args.length < 2) { console.error('Usage: operant spawn <name> <path>'); process.exit(1) }
        await apiPost('/api/spawn', { name: args[0], path: args[1] })
        console.log(`Spawning ${args[0]}...`)
        break
      }

      case 'kill': {
        if (args.length < 1) { console.error('Usage: operant kill <name>'); process.exit(1) }
        await apiPost('/api/kill', { name: args[0] })
        console.log(`Killed ${args[0]}`)
        break
      }

      case 'send': {
        if (args.length < 2) { console.error('Usage: operant send <name> <message>'); process.exit(1) }
        await apiPost('/api/send', { sessionName: args[0], text: args[1] })
        console.log(`Sent to ${args[0]}`)
        break
      }

      case 'trust': {
        if (args.length < 2) { console.error('Usage: operant trust <name> <auto|ask>'); process.exit(1) }
        await apiPost('/api/trust', { name: args[0], level: args[1] })
        console.log(`${args[0]} trust: ${args[1]}`)
        break
      }

      case 'prefix': {
        if (args.length < 2) { console.error('Usage: operant prefix <name> <text>'); process.exit(1) }
        await apiPost('/api/prefix', { name: args[0], text: args[1] })
        console.log(`Prefix set for ${args[0]}`)
        break
      }

      case 'rename': {
        if (args.length < 2) { console.error('Usage: operant rename <old> <new>'); process.exit(1) }
        await apiPost('/api/rename', { oldName: args[0], newName: args[1] })
        console.log(`Renamed ${args[0]} → ${args[1]}`)
        break
      }

      case 'upload': {
        if (args.length < 2) { console.error('Usage: operant upload <name> <file>'); process.exit(1) }
        const { readFileSync } = await import('fs')
        const { basename } = await import('path')
        const fileData = readFileSync(args[1])
        const form = new FormData()
        form.append('file', new Blob([fileData]), basename(args[1]))
        form.append('sessionName', args[0])
        const res = await fetch(`${OPERANT_URL}/api/upload`, { method: 'POST', body: form })
        if (!res.ok) throw new Error(await res.text())
        console.log(`Uploaded ${basename(args[1])} to ${args[0]}`)
        break
      }

      case 'start': {
        console.log('Starting daemon...')
        const { spawn } = await import('child_process')
        const child = spawn('bun', ['run', join(import.meta.dir, 'daemon.ts')], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
        console.log(`Daemon started (PID: ${child.pid})`)
        break
      }

      default:
        console.error(`Unknown command: ${command}`)
        console.log(HELP)
        process.exit(1)
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd claude-code-operant && bun test tests/cli.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd claude-code-operant && git add src/cli.ts tests/cli.test.ts && git commit -m "feat: CLI frontend with all management commands"
```

---

## Task 12: Daemon Entry Point

**Files:**
- Create: `claude-code-operant/src/daemon.ts`

- [ ] **Step 1: Implement daemon**

This wires all modules together.

```typescript
// src/daemon.ts
import { join } from 'path'
import { loadOperantConfig, loadSessions, saveSessions, OPERANT_DIR } from './config'
import { SessionRegistry } from './session-registry'
import { SocketServer } from './socket-server'
import { PermissionEngine } from './permission-engine'
import { MessageRouter } from './message-router'
import { ScreenManager } from './screen-manager'
import { TelegramFrontend } from './frontends/telegram'
import { WebFrontend } from './frontends/web'
import type { PermissionRequest } from './types'

const config = loadOperantConfig()
const savedSessions = loadSessions()

const SOCKET_PATH = process.env.OPERANT_SOCKET ?? join(OPERANT_DIR, 'operant.sock')
const SHIM_COMMAND = `bun run ${join(import.meta.dir, 'shim.ts')}`

// Session registry
const registry = new SessionRegistry({
  defaultTrust: config.defaultTrust,
  defaultUploadDir: config.defaultUploadDir,
})
registry.restoreFrom(savedSessions)

// Permission engine
let telegramFrontend: TelegramFrontend | null = null
let webFrontend: WebFrontend | null = null

const permissions = new PermissionEngine(registry, (req: PermissionRequest) => {
  telegramFrontend?.deliverPermissionRequest(req)
  webFrontend?.deliverPermissionRequest(req)
})

// Screen manager
const screenManager = new ScreenManager()

// Socket server
const socketServer = new SocketServer(registry, SOCKET_PATH)

// Message router
const router = new MessageRouter(
  registry,
  // Send to Claude session
  (path, content, meta) => {
    return socketServer.sendToSession(path, {
      type: 'channel_message',
      content,
      meta,
    })
  },
  // Deliver to frontends
  (sessionName, text, files) => {
    telegramFrontend?.deliverToUser(sessionName, text, files)
    webFrontend?.deliverToUser(sessionName, text, files)
  },
)

// Wire socket server events
socketServer.on('session:connected', (path: string) => {
  process.stderr.write(`operant: session connected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()
})

socketServer.on('session:disconnected', (path: string) => {
  const session = registry.get(path)
  process.stderr.write(`operant: session disconnected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()

  // Respawn if managed
  if (session?.managed) {
    registry.get(path)!.status = 'respawning'
    webFrontend?.refreshSessions()
    screenManager.scheduleRespawn(session.name, SHIM_COMMAND)
  }
})

socketServer.on('tool_call', (path: string, name: string, args: Record<string, unknown>) => {
  const session = registry.get(path)
  if (!session) return

  if (name === 'reply') {
    const text = args.text as string
    const files = args.files as string[] | undefined
    router.routeFromSession(path, text, files)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'reply',
      result: 'sent',
    })
  } else if (name === 'edit_message') {
    // Forward edit to frontends
    telegramFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    webFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'edit_message',
      result: 'edited',
    })
  }
})

socketServer.on('permission_request', (path: string, msg: any) => {
  const response = permissions.handle(path, {
    requestId: msg.requestId,
    toolName: msg.toolName,
    description: msg.description,
    inputPreview: msg.inputPreview,
  })
  if (response) {
    // Auto-approved
    socketServer.sendToSession(path, {
      type: 'permission_response',
      requestId: response.requestId,
      behavior: response.behavior,
    })
  }
})

// Start everything
async function start(): Promise<void> {
  await socketServer.start()
  process.stderr.write(`operant: socket server listening on ${SOCKET_PATH}\n`)

  // Web frontend (always starts)
  webFrontend = new WebFrontend({
    port: config.webPort,
    registry,
    router,
    permissions,
    socketServer,
    screenManager,
    shimCommand: SHIM_COMMAND,
  })
  await webFrontend.start()
  process.stderr.write(`operant: web UI at http://localhost:${webFrontend.port}\n`)

  // Add API routes for CLI
  // (These are handled by the web frontend's fetch handler — we need to add them)

  // Telegram frontend (only if token configured)
  if (config.telegramToken) {
    telegramFrontend = new TelegramFrontend({
      token: config.telegramToken,
      registry,
      router,
      permissions,
      screenManager,
      socketServer,
      shimCommand: SHIM_COMMAND,
      allowFrom: config.telegramAllowFrom,
    })
    telegramFrontend.start().catch(err => {
      process.stderr.write(`operant: telegram failed to start: ${err}\n`)
    })
  } else {
    process.stderr.write('operant: no telegram token — skipping telegram frontend\n')
  }

  process.stderr.write('operant: daemon ready\n')
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  process.stderr.write('operant: shutting down...\n')
  saveSessions(registry.toSaveFormat())
  await screenManager.killAll()
  await socketServer.stop()
  await webFrontend?.stop()
  await telegramFrontend?.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  process.stderr.write(`operant: failed to start: ${err}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Add missing API routes to web frontend**

Edit `src/frontends/web.ts` — add POST routes for CLI commands inside the `fetch` handler:

```typescript
// Add these cases to the fetch handler, after the /api/upload check:

if (url.pathname === '/api/spawn' && req.method === 'POST') {
  const body = await req.json() as { name: string; path: string }
  await self.deps.screenManager?.spawn(body.name, body.path, self.deps.shimCommand)
  return Response.json({ ok: true })
}

if (url.pathname === '/api/kill' && req.method === 'POST') {
  const body = await req.json() as { name: string }
  await self.deps.screenManager?.kill(body.name)
  return Response.json({ ok: true })
}

if (url.pathname === '/api/send' && req.method === 'POST') {
  const body = await req.json() as { sessionName: string; text: string }
  self.deps.router?.routeToSession(body.sessionName, body.text, 'cli', 'cli')
  return Response.json({ ok: true })
}

if (url.pathname === '/api/trust' && req.method === 'POST') {
  const body = await req.json() as { name: string; level: string }
  const path = self.deps.registry.findByName(body.name)
  if (path) self.deps.registry.setTrust(path, body.level === 'auto' ? 'auto-approve' : 'ask')
  return Response.json({ ok: true })
}

if (url.pathname === '/api/prefix' && req.method === 'POST') {
  const body = await req.json() as { name: string; text: string }
  const path = self.deps.registry.findByName(body.name)
  if (path) self.deps.registry.setPrefix(path, body.text)
  return Response.json({ ok: true })
}

if (url.pathname === '/api/rename' && req.method === 'POST') {
  const body = await req.json() as { oldName: string; newName: string }
  const path = self.deps.registry.findByName(body.oldName)
  if (path) self.deps.registry.rename(path, body.newName)
  return Response.json({ ok: true })
}
```

- [ ] **Step 3: Verify daemon compiles**

```bash
cd claude-code-operant && bun build src/daemon.ts --outfile /dev/null --target bun 2>&1
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
cd claude-code-operant && git add src/daemon.ts src/frontends/web.ts && git commit -m "feat: daemon entry point wiring all modules together"
```

---

## Task 13: Integration Test

**Files:**
- Create: `claude-code-operant/tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { rmSync } from 'fs'
import { SessionRegistry } from '../src/session-registry'
import { SocketServer } from '../src/socket-server'
import { PermissionEngine } from '../src/permission-engine'
import { MessageRouter } from '../src/message-router'
import { connect } from 'net'

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
    // 1. Simulate shim connecting
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/myproject' }) + '\n')

    // Wait for registration
    const regData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const regMsg = JSON.parse(regData.trim())
    expect(regMsg.type).toBe('registered')
    expect(regMsg.sessionName).toBe('myproject')

    // 2. Send message from "frontend" to session
    router.routeToSession('myproject', 'hello claude', 'web', 'user1')

    // 3. Wait for message to arrive at shim
    const msgData = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const channelMsg = JSON.parse(msgData.trim())
    expect(channelMsg.type).toBe('channel_message')
    expect(channelMsg.content).toBe('hello claude')

    // 4. Shim sends reply (simulating Claude's tool call)
    sock.write(JSON.stringify({ type: 'tool_call', name: 'reply', arguments: { text: 'hello human' } }) + '\n')

    // Wait for tool result + frontend delivery
    await new Promise(r => setTimeout(r, 100))
    expect(deliveredToFrontend.length).toBe(1)
    expect(deliveredToFrontend[0].text).toBe('hello human')

    sock.end()
  })

  test('permission auto-approve for trusted session', async () => {
    // Register and set to auto-approve
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sock.write(JSON.stringify({ type: 'register', cwd: '/home/user/trusted' }) + '\n')
    await new Promise<string>(resolve => { sock.once('data', chunk => resolve(chunk.toString())) })

    registry.setTrust('/home/user/trusted', 'auto-approve')

    // Wire permission handler
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

    // Send permission request from shim
    sock.write(JSON.stringify({
      type: 'permission_request',
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: 'ls',
    }) + '\n')

    // Should get auto-approved
    const data = await new Promise<string>(resolve => {
      sock.once('data', chunk => resolve(chunk.toString()))
    })
    const permMsg = JSON.parse(data.trim())
    expect(permMsg.type).toBe('permission_response')
    expect(permMsg.behavior).toBe('allow')

    sock.end()
  })
})
```

- [ ] **Step 2: Run integration tests**

```bash
cd claude-code-operant && bun test tests/integration.test.ts
```

Expected: all 2 tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
cd claude-code-operant && bun test
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd claude-code-operant && git add tests/integration.test.ts && git commit -m "feat: integration tests for full message round-trip"
```

---

## Task 14: Package and Documentation

**Files:**
- Modify: `claude-code-operant/package.json` (add bin entries)

- [ ] **Step 1: Add bin entries to package.json**

Update the `package.json` to add executable entries:

```json
{
  "bin": {
    "operant": "./src/cli.ts",
    "operant-shim": "./src/shim.ts",
    "operant-daemon": "./src/daemon.ts"
  }
}
```

- [ ] **Step 2: Create .mcp.json for channel plugin compatibility**

```json
{
  "mcpServers": {
    "operant": {
      "command": "bun",
      "args": ["run", "${CLAUDE_PLUGIN_ROOT}/src/shim.ts"]
    }
  }
}
```

Save as `claude-code-operant/.mcp.json`.

- [ ] **Step 3: Run all tests one final time**

```bash
cd claude-code-operant && bun test
```

Expected: all tests PASS.

- [ ] **Step 4: Final commit**

```bash
cd claude-code-operant && git add -A && git commit -m "feat: package config with bin entries and MCP plugin manifest"
```
