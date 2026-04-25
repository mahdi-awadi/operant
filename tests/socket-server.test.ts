// tests/socket-server.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SocketServer } from '../src/socket-server'
import { SessionRegistry } from '../src/session-registry'
import { join } from 'path'
import { rmSync } from 'fs'
import { connect } from 'net'

const TEST_SOCK = join(import.meta.dir, '.test-hub.sock')

function sendLine(sock: ReturnType<typeof connect>, data: object): void {
  sock.write(JSON.stringify(data) + '\n')
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

    const data = await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg = JSON.parse(data.trim())
    expect(msg.type).toBe('registered')
    expect(msg.sessionName).toBe('myproject')
    expect(registry.list().length).toBe(1)
    sock.end()
  })

  test('second connection from same folder gets a different name', async () => {
    registry.register('/home/user/myproject:0', { teamIndex: 0, teamSize: 1 })

    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/myproject' })

    const data = await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg = JSON.parse(data.trim())
    expect(msg.type).toBe('registered')
    expect(msg.sessionName).toBe('myproject-2')
    sock.end()
  })

  test('allows second connection from same folder as teammate', async () => {
    const sock1 = connect(TEST_SOCK)
    await new Promise<void>(r => sock1.on('connect', r))
    sendLine(sock1, { type: 'register', cwd: '/home/user/myproject' })
    const data1 = await new Promise<string>(resolve => {
      sock1.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg1 = JSON.parse(data1.trim())
    expect(msg1.type).toBe('registered')
    expect(msg1.sessionName).toBe('myproject')

    const sock2 = connect(TEST_SOCK)
    await new Promise<void>(r => sock2.on('connect', r))
    sendLine(sock2, { type: 'register', cwd: '/home/user/myproject' })
    const data2 = await new Promise<string>(resolve => {
      sock2.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg2 = JSON.parse(data2.trim())
    expect(msg2.type).toBe('registered')
    expect(msg2.sessionName).toBe('myproject-2')
    expect(registry.list().length).toBe(2)

    sock1.end()
    sock2.end()
  })

  test('marks session disconnected when socket closes', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/myproject' })
    await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })

    sock.end()
    await new Promise(r => setTimeout(r, 100))
    expect(registry.get('/home/user/myproject:0')?.status).toBe('disconnected')
  })

  test('register with tmuxName uses the suffix as the session name', async () => {
    // Spawn order: lead first into tmux `hub-myproject`, then teammates
    // `hub-myproject-2` and `hub-myproject-3`. If they REGISTER out of order
    // (e.g. lead's auto-confirm got delayed), without tmuxName the registry
    // would assign names by registration order — wrong. With tmuxName, names
    // come from the actual tmux session suffix.

    const sock1 = connect(TEST_SOCK)
    await new Promise<void>(r => sock1.on('connect', r))
    // First to register is teammate 2 (lead delayed)
    sendLine(sock1, { type: 'register', cwd: '/home/user/myproject', tmuxName: 'hub-myproject-2' })
    const data1 = await new Promise<string>(resolve => {
      sock1.once('data', (chunk) => resolve(chunk.toString()))
    })
    expect(JSON.parse(data1.trim()).sessionName).toBe('myproject-2')

    const sock2 = connect(TEST_SOCK)
    await new Promise<void>(r => sock2.on('connect', r))
    // Then the lead finally registers
    sendLine(sock2, { type: 'register', cwd: '/home/user/myproject', tmuxName: 'hub-myproject' })
    const data2 = await new Promise<string>(resolve => {
      sock2.once('data', (chunk) => resolve(chunk.toString()))
    })
    expect(JSON.parse(data2.trim()).sessionName).toBe('myproject')

    sock1.end()
    sock2.end()
  })

  test('register without tmuxName falls back to folder basename (legacy)', async () => {
    const sock = connect(TEST_SOCK)
    await new Promise<void>(r => sock.on('connect', r))
    sendLine(sock, { type: 'register', cwd: '/home/user/legacyproj' })
    const data = await new Promise<string>(resolve => {
      sock.once('data', (chunk) => resolve(chunk.toString()))
    })
    expect(JSON.parse(data.trim()).sessionName).toBe('legacyproj')
    sock.end()
  })

  test('reconnecting session reuses disconnected slot instead of creating new', async () => {
    // First connection
    const sock1 = connect(TEST_SOCK)
    await new Promise<void>(r => sock1.on('connect', r))
    sendLine(sock1, { type: 'register', cwd: '/home/user/myproject' })
    const data1 = await new Promise<string>(resolve => {
      sock1.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg1 = JSON.parse(data1.trim())
    expect(msg1.sessionName).toBe('myproject')
    expect(registry.list().length).toBe(1)

    // Disconnect
    sock1.end()
    await new Promise(r => setTimeout(r, 200))
    expect(registry.list().length).toBe(1)
    const disconnected = registry.list()[0]
    expect(disconnected.status).toBe('disconnected')

    // Reconnect — should reuse the slot, not create a new one
    const sock2 = connect(TEST_SOCK)
    await new Promise<void>(r => sock2.on('connect', r))
    sendLine(sock2, { type: 'register', cwd: '/home/user/myproject' })
    const data2 = await new Promise<string>(resolve => {
      sock2.once('data', (chunk) => resolve(chunk.toString()))
    })
    const msg2 = JSON.parse(data2.trim())
    expect(msg2.sessionName).toBe('myproject')
    expect(registry.list().length).toBe(1) // reused slot, not 2!

    sock2.end()
  })
})
