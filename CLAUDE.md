# Claude Code Hub

Multi-session Claude Code channel plugin with Web dashboard, Telegram bot, and CLI.

## Architecture

```
Hub Daemon (long-running, tmux session: hub-daemon)
  ├── Socket Server (Unix: ~/.claude/channels/hub/hub.sock)
  │     ↕ shim processes (one per Claude Code session)
  ├── Web Dashboard (configurable port, Telegram login)
  ├── Telegram Bot (configurable token)
  ├── API Server (for CLI)
  └── Session Registry + Permission Engine
```

Two layers:
- **Daemon** — single process managing everything. Runs in `tmux -t hub-daemon`
- **Shim** — tiny MCP bridge per Claude session. Claude launches it via `--channels server:hub`

## Quick Start

### 1. Configure
```bash
mkdir -p ~/.claude/channels/hub
cat > ~/.claude/channels/hub/config.json << 'EOF'
{
  "webPort": 3000,
  "telegramToken": "<bot-token-from-botfather>",
  "telegramAllowFrom": ["<your-telegram-user-id>"],
  "defaultTrust": "ask",
  "defaultUploadDir": "."
}
EOF
```

### 2. Start the daemon
```bash
cd /path/to/channelhub
tmux new-session -d -s hub-daemon "bun run src/daemon.ts"
```

### 3. Connect Claude Code (from any project)
```bash
cd /path/to/project
claude --dangerously-load-development-channels server:hub
```

The `server:hub` name is configured in `~/.claude.json` under `mcpServers.hub`.

### Attach to sessions
```bash
tmux attach -t hub-daemon         # daemon logs
tmux attach -t hub-<session-name> # spawned session
```
Detach: `Ctrl+B` then `D`

## Permission Relay

Permissions flow through the MCP channel protocol — **no tmux send-keys**:

```
Claude wants to use a tool
  → permission_request via MCP → shim → daemon → Web/Telegram
  → user clicks Allow/Deny
  → daemon → shim → permission response via MCP → Claude proceeds
```

- **Trusted sessions** (`auto-approve`): daemon auto-responds `allow`, user never sees the prompt
- **Untrusted sessions** (`ask`): prompt forwarded to Web UI and Telegram with Allow / Always Allow / Deny buttons
- Both terminal and remote answer race — first response wins

The shim declares `claude/channel/permission` capability. Claude Code sends `notifications/claude/channel/permission_request` with `request_id`, `tool_name`, `description`, `input_preview`. The shim forwards to daemon, which routes to frontends. User response flows back as `notifications/claude/channel/permission`.

## Agent Team Teammates

When Claude's built-in agent teams spawn teammates (via `--agent-id`), the shim detects it by checking the parent process cmdline and **skips hub registration**. Only sessions started by the user appear in the hub. Teammates are managed by Claude's internal team protocol.

## Frontends

### Web Dashboard
- Telegram login required (only allowlisted users)
- Session list with status dots, grouped by team
- Chat view with message history per session
- Permission prompts with Allow / Always Allow / Deny buttons
- File attachments (clip button or drag-and-drop)
- Toggleable prompt tags (Superpowers, TDD, Concise, etc.)
- Directory browser for spawning new sessions
- `tmux attach` command shown in header (click to copy)
- `[+]` button to add teammates to a team

### Telegram Bot
Commands:
- `/list` — show sessions, pick active (inline buttons)
- `/status` — dashboard with details
- `/spawn <name> <path> [team-size]` — launch Claude in tmux
- `/kill <name>` — stop a session
- `/remove <name>` — remove a disconnected session from the list (no tmux ops)
- `/team <name> [add]` — show team status or add teammate
- `/trust <name> [auto|ask]` — toggle auto-approve
- `/prefix <name> <text>` — set command prefix
- `/rename <old> <new>` — rename session
- `/all <message>` — broadcast to all sessions
- `/verify <name>` — run the session's verification commands
- `/autopilot <name> [on|off]` — toggle proxy-answer autopilot mode
- Send photo/document — uploaded to active session's project folder

Message routing:
- Plain text → active session
- `/<session-name> message` → specific session
- Replies prefixed with `[session-name]`

### CLI
```bash
HUB_URL=http://localhost:<webPort> bun run src/cli.ts <command>
```
Commands: `list`, `status`, `spawn`, `kill`, `send`, `trust`, `prefix`, `rename`, `upload`, `autopilot`

## Configuration

### Hub config: `~/.claude/channels/hub/config.json`
```json
{
  "webPort": 3000,
  "telegramToken": "<bot-token-from-botfather>",
  "telegramAllowFrom": ["<your-telegram-user-id>"],
  "defaultTrust": "ask",
  "defaultUploadDir": "."
}
```

- `webPort`: API + Web dashboard port
- `telegramToken`: from @BotFather
- `telegramAllowFrom`: Telegram user IDs (empty = allow all). Also controls web login.
- `defaultTrust`: `ask` (prompt user) or `auto-approve` (auto-allow all tools)
- `defaultUploadDir`: where uploaded files go (relative to project root)
- `browseRoot` (optional): scope for `/api/browse` and the spawn dialog directory picker. Defaults to `$HOME`. Set to `"/home"` if the daemon runs as `root` with projects under `/home/*`.

Supports `CLAUDE_PLUGIN_DATA` env var for plugin-managed data persistence.

### MCP server registration: `~/.claude.json`
```json
{
  "mcpServers": {
    "hub": {
      "command": "bun",
      "args": ["run", "/path/to/channelhub/src/shim.ts"]
    }
  }
}
```

### Session persistence: `~/.claude/channels/hub/sessions.json`
Auto-saved on connect/disconnect. Restored on daemon restart. Reconnecting sessions reuse disconnected slots.

## Multi-Session Model

- **Folder path + index** is the session key (e.g., `/home/user/project:0`, `/home/user/project:1`)
- First session in a folder = team lead (index 0)
- Additional sessions = teammates (index 1, 2, ...)
- Display names auto-generated from folder basename, renameable
- Reconnecting sessions reuse disconnected slots (no ghost duplicates)

## Plugin Structure

Ready for Claude Code marketplace submission:
```
.claude-plugin/plugin.json   # Plugin manifest
.mcp.json                    # MCP server config (shim entry point)
skills/
  configure/SKILL.md         # Hub setup skill
  access/SKILL.md            # Access management skill
LICENSE                      # Apache-2.0
README.md                    # User documentation
```

## File Structure

```
src/
  daemon.ts              # Entry point — wires all modules
  shim.ts                # MCP bridge (Claude ↔ daemon via Unix socket)
  cli.ts                 # CLI frontend
  types.ts               # Shared TypeScript types
  config.ts              # JSON config I/O
  session-registry.ts    # In-memory session tracking (path:index keys)
  socket-server.ts       # Unix socket server (accepts shim connections)
  permission-engine.ts   # Per-session trust + permission relay
  message-router.ts      # Route messages with prefix, broadcast, targeting
  screen-manager.ts      # Spawn/kill/respawn sessions in tmux
  task-monitor.ts        # Watch ~/.claude/tasks/ for agent team tasks
  verification.ts        # Subprocess-based verification runner + package.json probe
  autopilot.ts           # Autopilot mode controller (watches reply tool calls, fires /btw)
  autopilot-parser.ts    # Parse Ink overlay output and extract proxy answer
  autopilot-risk.ts      # Risk keyword filter and escalation detection
  veto-controller.ts     # Optional veto window for review-before-send
  frontends/
    telegram.ts          # Grammy bot with commands + photo/document upload
    web.ts               # Bun HTTP + WebSocket server + Telegram login
    web-client.html      # Single-file PWA (dark theme, chat UI)
tests/
  *.test.ts              # 337 tests
```

## Key Design Decisions

- **Permission relay via MCP channel protocol** — no tmux send-keys. Claude Code sends `permission_request`, shim forwards to daemon, user responds via Web/Telegram.
- **Folder path:index as session key** — supports multiple sessions per folder (agent teams).
- **Agent teammates auto-filtered** — shim detects `--agent-id` in parent process, skips registration.
- **Reconnect reuses slots** — disconnected sessions are reclaimed, no duplicates.
- **Telegram `allowFrom`** controls both bot access and web login.
- **Web login** via Telegram Login Widget, verified server-side with HMAC-SHA256.
- **Daemon runs in tmux** — background `&` kills it on stdin EOF.
- **Prompt tags** appended as `[Instructions: ...]` to messages.
- **Spawn auto-confirms** dev channels warning via `tmux send-keys Enter` (only needed until plugin is approved).
- **Verification runner** — `src/verification.ts` spawns `bash -c "<cmd>"` per profile-defined command with a 120s timeout, CWD set to the session's project path, `CI=true` in env. Single concurrent run per session; silent on success; 20-line tail on failure.
- **Autopilot mode** — per-session opt-in. Daemon watches outgoing `reply` tool calls; if autopilot is on, fires `/btw <wrapped-question>` via `tmux send-keys`, captures the answer from the Ink overlay, and injects it back into the same session via `notifications/claude/channel`. Risk-keyword filter + `ESCALATE:` token drop-through to the user on Telegram/Web. Optional veto window shows draft to user with Send/Edit/Cancel buttons before auto-sending.

## Development

```bash
bun test              # Run all 337 tests
bun run src/daemon.ts # Start daemon (use tmux in production)
bun run src/shim.ts   # Shim (launched by Claude, not manually)
bun run src/cli.ts    # CLI tool
```

## Tech Stack

- **Runtime:** Bun
- **MCP:** @modelcontextprotocol/sdk
- **Telegram:** grammy
- **Web:** Bun built-in HTTP/WebSocket
- **Process management:** tmux
