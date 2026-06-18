---
name: configure
description: Set up the hub — save the bot token, web port, and configure access. Use when the user wants to configure the hub, set a Telegram token, or check channel status.
---

# Configure Claude Code Hub

Help the user configure their hub installation.

## Configuration File

Location: `~/.claude/channels/hub/config.json`

Fields:
- `webPort` (number): Web UI port (default: 3000)
- `telegramToken` (string): Telegram bot token from @BotFather
- `telegramAllowFrom` (string[]): Telegram user IDs allowed to use the bot
- `defaultTrust` ("ask" | "auto-approve"): Default permission mode for new sessions
- `defaultUploadDir` (string): Default upload directory (default: ".")

## Setup Steps

1. Create config: `mkdir -p ~/.claude/channels/hub`
2. Set token: Write config.json with the bot token
3. Start daemon in tmux: `tmux new-session -d -s hub-daemon "bun run src/daemon.ts"`
4. Connect Claude: `claude --channels plugin:hub@marketplace`

## MCP Server Registration

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "hub": {
      "command": "bun",
      "args": ["run", "/path/to/operant/src/shim.ts"]
    }
  }
}
```
