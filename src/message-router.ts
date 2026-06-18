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
    if (RESERVED_COMMANDS.has(name)) return null
    const path = this.registry.findByName(name)
    if (!path) return null
    return { sessionName: name, text: match[2] }
  }
}
