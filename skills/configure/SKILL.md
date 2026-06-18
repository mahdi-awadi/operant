---
name: configure
description: Set up the operant — save the bot token, web port, and configure access. Use when the user wants to configure the operant, set a Telegram token, or check channel status.
---

# Configure Claude Code Operant

Help the user configure their operant installation.

## Configuration File

Location: `~/.claude/channels/operant/config.json`

Fields:
- `webPort` (number): Web UI port (default: 3000)
- `telegramToken` (string): Telegram bot token from @BotFather
- `telegramAllowFrom` (string[]): Telegram user IDs allowed to use the bot
- `defaultTrust` ("ask" | "auto-approve"): Default permission mode for new sessions
- `defaultUploadDir` (string): Default upload directory (default: ".")

## Setup Steps

1. Create config: `mkdir -p ~/.claude/channels/operant`
2. Set token: Write config.json with the bot token
3. Start daemon in tmux: `tmux new-session -d -s operant-daemon "bun run src/daemon.ts"`
4. Connect Claude: `claude --channels plugin:operant@marketplace`

## MCP Server Registration

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "operant": {
      "command": "bun",
      "args": ["run", "/path/to/operant/src/shim.ts"]
    }
  }
}
```
