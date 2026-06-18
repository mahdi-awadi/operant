// src/socket-server.ts
import { createServer, type Server, type Socket } from 'net'
import { unlinkSync, chmodSync } from 'fs'
import type { SessionRegistry } from './session-registry'
import type { ShimToDaemon, DaemonToShim, Profile } from './types'
import { EventEmitter } from 'events'

export class SocketServer extends EventEmitter {
  private server: Server | null = null
  private registry: SessionRegistry
  private socketPath: string
  private connections = new Map<string, Socket>()
  onLookupProfile?: (folder: string) => { managed: boolean; profile?: Profile } | undefined

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
    // Lock the socket to the daemon's UID — prevents other local users on a
    // shared host from connecting and impersonating a shim.
    try { chmodSync(this.socketPath, 0o600) } catch {}
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
        const folder = msg.cwd

        // First, try to reclaim a disconnected slot from the same folder
        const team = this.registry.getTeam(folder)
        const disconnected = team.find(s => s.status === 'disconnected')
        let sessionKey: string

        if (disconnected) {
          // Reuse the disconnected slot
          sessionKey = disconnected.path
          this.registry.reconnect(sessionKey)
        } else {
          // No disconnected slot — create new
          const nextIndex = this.registry.nextTeamIndex(folder)
          sessionKey = `${folder}:${nextIndex}`

          const existing = this.registry.get(sessionKey)
          if (existing && existing.status === 'active') {
            this.send(socket, { type: 'rejected', reason: `Session ${sessionKey} already active` })
            socket.end()
            return
          }

          const profileInfo = this.onLookupProfile?.(folder)
          // Prefer the tmux session suffix (e.g. `operant-team-test-2` → `team-test-2`)
          // for the session's display name. Falls back to the folder basename
          // (handled in registry) when the shim doesn't supply tmuxName. This
          // keeps registry name == tmux name regardless of registration order.
          const tmuxDerivedName = msg.tmuxName?.replace(/^operant-/, '')
          this.registry.register(sessionKey, {
            name: tmuxDerivedName,
            teamIndex: nextIndex,
            teamSize: team.length + 1,
            trust: profileInfo?.profile?.trust ?? undefined,
            prefix: profileInfo?.profile?.prefix ?? undefined,
            appliedProfile: profileInfo?.profile?.name,
            profileOverrides: {},
            managed: profileInfo?.managed ?? false,
          })
        }

        setPath(sessionKey)
        this.connections.set(sessionKey, socket)
        const session = this.registry.get(sessionKey)!
        this.send(socket, { type: 'registered', sessionName: session.name })
        this.emit('session:connected', sessionKey)
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

  disconnectSession(path: string): void {
    const socket = this.connections.get(path)
    if (socket && !socket.destroyed) socket.end()
    this.connections.delete(path)
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
