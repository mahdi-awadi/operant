# ChannelHub

> ⚠️ **Beta Software** — ChannelHub is in active development. Expect bugs, breaking changes, and rough edges. Bug reports and contributions are welcome. Do not rely on it for critical workflows yet.

A multi-session channel plugin for [Claude Code](https://claude.ai/code) that lets you manage all your Claude sessions from one place — Telegram, Rubika, web dashboard, or CLI.

**The problem:** Claude Code channels are 1:1 — one bot per session. If you run multiple projects, you need multiple bots or keep switching.

**The solution:** ChannelHub runs a single daemon that accepts connections from all your Claude sessions. Send messages, approve permissions, upload files, and spawn agent teams — from one Telegram bot, Rubika bot, or web dashboard.

## Features

- **Multi-session management** — all Claude sessions visible in one dashboard
- **Telegram bot** — send messages, approve permissions, upload photos/documents from your phone
- **Rubika bot** — text-message routing through a webhook-based MVP frontend
- **Web dashboard** — real-time chat, permission prompts, session status, file upload
- **Permission relay** — approve/deny tool use from Telegram or web (native MCP channel protocol)
- **Agent teams** — spawn teams of Claude instances with shared task coordination
- **Session routing** — switch between projects, broadcast to all, or target specific sessions
- **CLI** — manage sessions from the terminal
- **Prompt tags** — toggle instructions (use superpowers, TDD, be concise) appended to messages

## How It Works

```
You (Telegram / Rubika / Web / CLI)
       ↓
Hub Daemon (manages everything)
  ├── Socket Server (Unix socket)
  │     ↕ shim ↔ Claude session A
  │     ↕ shim ↔ Claude session B
  │     ↕ shim ↔ Claude session C
  ├── Telegram Bot
  ├── Rubika Bot
  ├── Web Dashboard
  └── Permission Engine
```

Each Claude session runs with `--channels server:hub`. The hub's **shim** (MCP server) bridges Claude's stdio to the daemon via Unix socket. The daemon routes messages between your frontends and all connected sessions.

## Prerequisites

Before installing, make sure you have:

- **[Bun](https://bun.sh) >= 1.0** — the installer will offer to install it for you if missing
- **[tmux](https://github.com/tmux/tmux)** — required for daemon and session management
  - Debian/Ubuntu: `apt install tmux`
  - RHEL/Fedora: `dnf install tmux`
  - macOS: `brew install tmux`
- **[Claude Code](https://claude.ai/code)** with claude.ai login
- **git** — to clone the repository
- **jq** (recommended) — for automatic config updates
- **A Telegram bot token** (optional) — create one with [@BotFather](https://t.me/BotFather) if you want the Telegram frontend
- **A Rubika bot token** (optional) — set `rubikaToken`, `rubikaAllowFrom`, and `rubikaWebhookBase` if you want the Rubika frontend

## Quick Install

One-liner that handles everything:

```bash
curl -fsSL https://raw.githubusercontent.com/mahdi-awadi/channelhub/main/install.sh | bash
```

This will:
1. Check prerequisites (install Bun if missing)
2. Clone ChannelHub to `~/.channelhub`
3. Install dependencies
4. Create config template at `~/.claude/channels/hub/config.json`
5. Register the MCP server in `~/.claude.json`
6. Install the `channelhub` command to `~/.local/bin`

### Configure

Edit `~/.claude/channels/hub/config.json` and add your Telegram token and user ID:

```json
{
  "webPort": 3000,
  "telegramToken": "<bot-token-from-botfather>",
  "telegramAllowFrom": ["<your-telegram-user-id>"],
  "rubikaToken": "",
  "rubikaAllowFrom": [],
  "rubikaWebhookBase": "",
  "defaultTrust": "ask",
  "defaultUploadDir": "."
}
```

Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### Start

```bash
channelhub start              # Start the daemon in tmux
channelhub status             # Check if it's running
channelhub attach             # View daemon logs (Ctrl+B then D to detach)
```

### Connect Claude Code

In any project folder:

```bash
claude --dangerously-load-development-channels server:hub
```

Your session appears in the dashboard at `http://localhost:3000` immediately.

### CLI Commands

```bash
channelhub start       # Start daemon
channelhub stop        # Stop daemon
channelhub restart     # Restart daemon
channelhub status      # Status
channelhub attach      # Attach to daemon tmux
channelhub update      # Pull latest and restart
channelhub list        # List sessions
channelhub send <name> "message"
channelhub spawn <name> <path>
channelhub trust <name> auto
```

## Manual Install

If you prefer to install manually instead of the one-liner:

```bash
git clone https://github.com/mahdi-awadi/channelhub.git ~/.channelhub
cd ~/.channelhub
bun install

# Create config
mkdir -p ~/.claude/channels/hub
cp config.example.json ~/.claude/channels/hub/config.json
$EDITOR ~/.claude/channels/hub/config.json

# Register MCP server — add to ~/.claude.json mcpServers:
# "hub": { "command": "bun", "args": ["run", "~/.channelhub/src/shim.ts"] }

# Start daemon
tmux new-session -d -s hub-daemon "bun run ~/.channelhub/src/daemon.ts"
```

## Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/list` | Show sessions, pick active (inline buttons) |
| `/status` | Dashboard with session details |
| `/spawn <name> <path> [team-size]` | Launch Claude in tmux |
| `/kill <name>` | Stop a session |
| `/remove <name>` | Remove a disconnected session from the list |
| `/team <name> [add]` | Show team status or add teammate |
| `/trust <name> [auto\|ask]` | Toggle auto-approve permissions |
| `/prefix <name> <text>` | Set command prefix for a session |
| `/rename <old> <new>` | Rename a session |
| `/all <message>` | Broadcast to all sessions |
| `/verify <name>` | Run the session's verification commands (tests, typecheck, lint) |
| `/autopilot <name> [on\|off]` | Toggle proxy-answer autopilot mode |

**Message routing:**
- Plain text goes to your active session
- `/<session-name> message` targets a specific session
- Send a photo or document to upload it to the active session's project folder

## Rubika Bot

Rubika support is currently a text-only webhook MVP.

- Configure `rubikaToken` with your Rubika bot token.
- Set `rubikaAllowFrom` to the Rubika `sender_id` values allowed to use the bot. Empty means deny all.
- Set `rubikaWebhookBase` to the public HTTPS origin that can reach the web frontend, for example `https://hub.example.com`.
- The daemon registers `receiveUpdate` with Rubika at `/api/rubika/webhook/<secret>`.
- Inbound text from an allowed sender routes to that sender's active session, defaulting to the first active session.
- Claude replies are sent with a `[session]` prefix after an allowed sender has messaged the bot once, which lets ChannelHub learn Rubika's `chat_id`.

Rubika does not yet support ChannelHub commands, permission buttons, autopilot draft buttons, file uploads, or session switching UI.

### Verification

Running `/verify <session>` executes the session's profile-defined verification commands against the session's project directory. If the applied profile has no commands, the runner auto-detects them from the project's `package.json` scripts (`test`, `typecheck`, `lint`).

Commands run sequentially and stop on the first failure. You get `✅` back on success, or a failure message containing the failed command, exit code, and the last 20 lines of merged stdout/stderr on failure. Per-command timeout is 120 seconds.

Built-in profiles with defaults:
- **careful** — `bun test`, `bunx tsc --noEmit`
- **tdd** — `bun test`, `bunx tsc --noEmit`
- **docs** / **yolo** — no commands (probe decides from `package.json`)

## Web Dashboard

Access at `http://localhost:<webPort>` (or via reverse proxy).

- **Telegram login** — only allowlisted users can access
- **Session sidebar** — status dots, team grouping, `[+]` to add teammates
- **Chat view** — send messages, see replies, permission prompts with Allow/Always Allow/Deny
- **File upload** — clip button or drag-and-drop
- **Prompt tags** — toggleable pills (Superpowers, TDD, Concise, etc.)
- **Spawn dialog** — directory browser, team checkbox

## Permission Relay

When Claude wants to run a tool (Bash, Write, etc.), the permission prompt appears in both the terminal AND your Telegram/web dashboard. You can approve from either place — first response wins.

```
Claude wants to use Bash → permission_request → Hub → Telegram/Web
You click Allow → Hub → Claude proceeds
```

- **Trusted sessions** (`auto-approve`): auto-allowed, you never see the prompt
- **Untrusted sessions** (`ask`): forwarded with Allow / Always Allow / Deny buttons

## Agent Teams

Spawn multiple Claude instances that work together:

- **Web UI:** check "Run as team" when spawning, set team size
- **Telegram:** `/spawn myproject /home/user/project 3` (1 lead + 2 teammates)
- **Add teammates later:** `[+]` button in web, or `/team myproject add` in Telegram

The hub monitors `~/.claude/tasks/` for agent team task files and displays progress.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `webPort` | number | 3000 | Web dashboard and API port |
| `telegramToken` | string | `""` | Bot token from [@BotFather](https://t.me/BotFather) |
| `telegramAllowFrom` | string[] | `[]` | Telegram user IDs allowed. **Empty = deny all.** The Telegram frontend refuses to start and web auth rejects every login when this list is empty. |
| `rubikaToken` | string | `""` | Rubika bot token. Empty disables the Rubika frontend. |
| `rubikaAllowFrom` | string[] | `[]` | Rubika sender IDs allowed. **Empty = deny all.** The Rubika frontend refuses to start when a token is configured without allowed senders. |
| `rubikaWebhookBase` | string | `""` | Public HTTPS origin where Rubika can POST webhook updates. |
| `rubikaApiBase` | string | `https://botapi.rubika.ir/v3` | Optional Rubika Bot API base override. |
| `defaultTrust` | `"ask"` \| `"auto-approve"` | `"ask"` | Default permission mode for new sessions |
| `defaultUploadDir` | string | `"."` | Upload directory relative to project root |
| `browseRoot` | string | `$HOME` | Scope for the spawn dialog's directory picker. Set to `"/home"` when the daemon runs as `root` with projects under `/home/*`. |

Config file: `~/.claude/channels/hub/config.json`

## CLI

```bash
HUB_URL=http://localhost:3000 bun run src/cli.ts <command>
```

| Command | Example |
|---------|---------|
| `list` | Show all sessions |
| `status` | Detailed session info |
| `spawn <name> <path>` | Launch Claude in tmux |
| `kill <name>` | Stop a session |
| `send <name> <message>` | Send message to session |
| `trust <name> auto` | Set auto-approve |
| `prefix <name> <text>` | Set command prefix |
| `rename <old> <new>` | Rename session |
| `upload <name> <file>` | Upload file to project |
| `autopilot <name> on` | Enable autopilot mode |

## Security Model

ChannelHub runs as **you** on your own machine and treats anyone who can authenticate as having your shell. Accordingly:

- **The web server binds to `127.0.0.1` only.** It is not reachable from the LAN. Remote access must go through a reverse proxy or tunnel (see below).
- **Authentication is cookie-based.** Logging in via the Telegram Login Widget verifies an HMAC and sets an `HttpOnly`, `SameSite=Strict` session cookie signed with your bot token. Every `/api/*` request and WebSocket upgrade requires that cookie; unauthenticated requests return `401`.
- **`telegramAllowFrom` is deny-by-default.** Leaving the list empty disables both the Telegram frontend (refuses to start) and web login. There is no "allow everyone" mode.
- **The Unix socket is `0600`** and restricted to your UID, so other local users cannot impersonate a shim.
- **Uploads are sanitized and scoped** — filenames are stripped of path separators and unsafe characters; the resolved destination must stay inside the session's project directory.
- **Auto-fetched file contents** (when Claude says "saved to /path/..." and the hub forwards the file body to your Telegram/web) are scoped to each session's project root. Prompt-injection cannot make the daemon read `~/.ssh/` or `/etc/`.

## Exposing the Web Dashboard

The web dashboard runs on `127.0.0.1` only. To access it remotely, put an authenticated proxy in front — the dashboard's own cookie auth is not a substitute for TLS + an external access control. Options:

- **Nginx / Traefik / Caddy with TLS and basic auth or SSO** — point your domain to `http://127.0.0.1:<webPort>`, enable WebSocket passthrough, require authentication at the proxy.
- **Tailscale / Cloudflare Tunnel** — identity-aware tunnels. Good default for personal use.
- **SSH tunnel** — `ssh -L 3000:localhost:3000 your-server`. Simplest; only you have the key.

Do not expose the port directly (`0.0.0.0` or a public address) — the daemon deliberately refuses that binding for safety, and proxying is cheap.

Configure your bot's domain in @BotFather (`/setdomain`) so the Telegram Login Widget works on your proxy domain.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [tmux](https://github.com/tmux/tmux) (for daemon and session management)
- [Claude Code](https://claude.ai/code) with claude.ai login
- A Telegram bot token (optional, for Telegram frontend)
- A Rubika bot token (optional, for Rubika frontend)

## Autopilot Mode

Enable unattended question-answering in a session:

```bash
# Telegram
/autopilot myproject on

# Web UI
Click the "Autopilot" toggle in the session row

# CLI
bun run src/cli.ts autopilot myproject on
```

When autopilot is on, the daemon fires `/btw` inside the session on every user-facing question (from Telegram, Web, or CLI). The proxy answers using the session's conversation context plus preferences in `autopilot.md`. See `skills/autopilot/SKILL.md` for setup details.

Risk gates: answers containing risk keywords (`delete`, `force push`, `production`, etc.) or marked with `ESCALATE:` are escalated to you on Telegram/Web. Default veto window is 30 seconds — you can review the draft answer and Send, Edit, or Cancel before it's auto-sent.

## Development

```bash
bun test              # 337 tests
bun run src/daemon.ts # start daemon
bun run src/cli.ts    # CLI tool
```

## Plugin Status

> **ChannelHub is not yet on the approved marketplace.** During the research preview, custom channels must use `--dangerously-load-development-channels server:hub` to run. This flag bypasses the allowlist check for your specific server entry. Permission relay and all other channel features work normally.

The project is structured as a Claude Code channel plugin and ready to submit to the [official marketplace](https://platform.claude.com/plugins/submit). Once approved, users will be able to install it with `/plugin install channelhub@marketplace` and use `--channels plugin:channelhub@marketplace` without the development flag.

## License

[Apache-2.0](LICENSE)
