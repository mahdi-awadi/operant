// src/shim.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'net'
import { join } from 'path'
import { homedir } from 'os'
import type { DaemonToShim, ShimToDaemon } from './types'
import { COMPANY_TOOL_DEFS } from './company/tools'

const SOCKET_PATH = process.env.HUB_SOCKET ?? join(homedir(), '.claude', 'channels', 'hub', 'hub.sock')

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

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, then 30s forever.
export function computeBackoff(attempt: number): number {
  const schedule = [1000, 2000, 4000, 8000, 16000]
  return attempt < schedule.length ? schedule[attempt]! : 30000
}

// Called when the daemon socket closes with in-flight tool calls. Each resolver
// receives an MCP error result so Claude sees the failure and can decide to retry.
// The map is cleared in-place; callers keep the same Map instance.
export function rejectPendingWithDisconnect(
  pending: Map<string, (result: ReturnType<typeof buildMcpToolResult>) => void>,
): void {
  for (const resolve of pending.values()) {
    resolve(buildMcpToolResult('hub disconnected, retry', true))
  }
  pending.clear()
}

// Only run main when executed directly (not imported for tests)
if (import.meta.main) {
  main()
}

function isAgentTeammate(): boolean {
  // Check if parent process is a Claude agent teammate (has --agent-id in cmdline)
  try {
    const ppid = process.ppid
    const cmdline = require('fs').readFileSync(`/proc/${ppid}/cmdline`, 'utf8')
    return cmdline.includes('--agent-id')
  } catch {
    return false
  }
}

function getHubTmuxSession(): string | null {
  // Only register with the hub if we're running inside a tmux pane whose
  // session name begins with "hub-". Anything else (GNU screen, bare terminal,
  // a separate tmux server, nested sessions) is ignored.
  // HUB_TEST_BYPASS_SESSION_CHECK lets subprocess integration tests skip the
  // tmux lookup without depending on a running tmux server.
  if (process.env.HUB_TEST_BYPASS_SESSION_CHECK === '1') return 'hub-test'
  const pane = process.env.TMUX_PANE
  if (!pane) return null
  try {
    const { execSync } = require('child_process')
    const sessionName = execSync(`tmux display-message -p -t ${pane} '#S'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    return sessionName.startsWith('hub-') ? sessionName : null
  } catch {
    return null
  }
}

function startStubMcpServer(): void {
  // Keeps Claude happy (the MCP server it configured exists) but does not
  // connect to the daemon — so this Claude instance is invisible to the hub.
  const mcp = new Server(
    { name: 'operant', version: '0.1.0' },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } },
  )
  mcp.connect(new StdioServerTransport()).catch(() => {})
}

function main() {
  // Skip registration for agent teammates spawned by Claude's agent teams feature.
  if (isAgentTeammate()) {
    process.stderr.write('hub shim: agent teammate detected, skipping hub registration\n')
    startStubMcpServer()
    return
  }

  // Skip registration unless we're inside a hub-managed tmux session.
  // This prevents stray Claude instances (from other terminals, screen, etc.)
  // from joining the hub and appearing as phantom teammates.
  const hubSession = getHubTmuxSession()
  if (!hubSession) {
    process.stderr.write('hub shim: not inside a hub-* tmux session, skipping registration\n')
    startStubMcpServer()
    return
  }
  process.stderr.write(`hub shim: running inside tmux session "${hubSession}"\n`)

  const cwd = process.cwd()

  let daemon: Socket | null = null
  let registered = false
  let shuttingDown = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let daemonBuffer = ''
  const pendingToolCalls = new Map<string, (result: ReturnType<typeof buildMcpToolResult>) => void>()

  const mcp = new Server(
    { name: 'operant', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions: [
        'This session is connected to Claude Code Hub — a multi-project management system.',
        'Messages arrive from the hub frontends (Telegram, Web, CLI).',
        'Reply with the reply tool — pass the text you want to send back.',
        'The hub routes your replies to the user on whichever frontend they are using.',
      ].join('\n'),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Reply to the user via the hub. Text is routed to all connected frontends.',
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
      {
        name: 'list_sessions',
        description:
          'List all operant sessions currently registered in the hub. Use this BEFORE send_to_session to discover the exact display names of peer sessions — the user often refers to teammates by shorthand (e.g. "team 2" or "leader") that does not match the registry. Returns each session\'s name, status (active/disconnected/respawning), folder path, teamIndex, and a self flag marking the calling session. Takes no arguments.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'send_to_session',
        description:
          'Send a message to ANOTHER operant session in the registry. Use this to delegate work to a teammate (peer hub session in the same or different folder) WITHOUT going through the user. The recipient must be identified by EXACT registry name — call list_sessions first if the user used a shorthand or you are unsure of the precise name. Returns ok=true if the recipient was found and active, or ok=false with a reason otherwise.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Recipient session name (must match registry exactly — call list_sessions if unsure).' },
            text: { type: 'string', description: 'Message body to deliver. Will appear to the recipient as a channel message from this session.' },
          },
          required: ['name', 'text'],
        },
      },
      ...COMPANY_TOOL_DEFS,
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    return new Promise<ReturnType<typeof buildMcpToolResult>>((resolve) => {
      pendingToolCalls.set(name, resolve)
      sendToDaemon({ type: 'tool_call', name, arguments: args })
    })
  })

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
      process.stderr.write(`hub shim: received permission_request: ${params.tool_name} (${params.request_id})\n`)
      let toolArgs: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(params.input_preview)
        if (parsed && typeof parsed === 'object') {
          toolArgs = parsed
        }
      } catch {
        toolArgs = { command: params.input_preview }
      }

      sendToDaemon({
        type: 'permission_request',
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
        toolArgs,
      })
    },
  )

  function handleDaemonMessage(msg: DaemonToShim): void {
    switch (msg.type) {
      case 'registered':
        registered = true
        process.stderr.write(`hub shim: registered as "${msg.sessionName}"\n`)
        break
      case 'rejected':
        process.stderr.write(`hub shim: rejected — ${msg.reason}\n`)
        shuttingDown = true
        process.exit(1)
        break
      case 'channel_message': {
        const annotated = `${msg.content}\n\n[hub] You must respond using the operant reply tool — do NOT just type your answer. Plain text in this terminal is not visible to the user; only the reply tool routes back to the frontend.`
        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: annotated, meta: msg.meta },
        }).catch((err) => {
          process.stderr.write(`hub shim: failed to deliver message: ${err}\n`)
        })
        break
      }
      case 'tool_result': {
        const resolve = pendingToolCalls.get(msg.name)
        if (resolve) {
          pendingToolCalls.delete(msg.name)
          resolve(msg.isError
            ? buildMcpToolResult(String(msg.result), true)
            : buildMcpToolResult(String(msg.result)))
        }
        break
      }
      case 'permission_response':
        mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: msg.requestId, behavior: msg.behavior },
        }).catch((err) => {
          process.stderr.write(`hub shim: failed to relay permission: ${err}\n`)
        })
        break
    }
  }

  function sendToDaemon(msg: ShimToDaemon): void {
    if (!daemon || daemon.destroyed) {
      process.stderr.write(`hub shim: dropping ${msg.type} (not connected)\n`)
      return
    }
    daemon.write(JSON.stringify(msg) + '\n')
  }

  function rejectPendingToolCalls(): void {
    rejectPendingWithDisconnect(pendingToolCalls)
  }

  function scheduleReconnect(): void {
    if (shuttingDown || reconnectTimer) return
    const delay = computeBackoff(reconnectAttempt)
    process.stderr.write(`hub shim: reconnecting in ${Math.round(delay / 1000)}s…\n`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectAttempt += 1
      openConnection()
    }, delay)
  }

  function openConnection(): void {
    daemonBuffer = ''
    registered = false
    const sock = connect(SOCKET_PATH)
    daemon = sock

    sock.on('connect', () => {
      reconnectAttempt = 0
      process.stderr.write('hub shim: connected to daemon, registering…\n')
      // hubSession is non-null here — we returned early above when it was null
      sendToDaemon({ type: 'register', cwd, tmuxName: hubSession ?? undefined })
    })

    sock.on('data', (chunk) => {
      daemonBuffer += chunk.toString()
      let idx: number
      while ((idx = daemonBuffer.indexOf('\n')) !== -1) {
        const line = daemonBuffer.slice(0, idx)
        daemonBuffer = daemonBuffer.slice(idx + 1)
        if (line.trim()) handleDaemonMessage(parseShimMessage(line))
      }
    })

    sock.on('error', (err) => {
      process.stderr.write(`hub shim: socket error: ${err.message}\n`)
      // 'close' fires next and handles reconnect.
    })

    sock.on('close', () => {
      registered = false
      rejectPendingToolCalls()
      scheduleReconnect()
    })
  }

  function shutdown(): void {
    shuttingDown = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (daemon && !daemon.destroyed) daemon.end()
    process.exit(0)
  }

  openConnection()

  mcp.connect(new StdioServerTransport()).catch((err) => {
    process.stderr.write(`hub shim: MCP connect failed: ${err}\n`)
    process.exit(1)
  })

  process.stdin.on('end', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
