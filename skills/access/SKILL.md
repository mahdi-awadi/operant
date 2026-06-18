---
name: access
description: Manage operant access — view allowed users, add or remove Telegram user IDs from the allowlist. Use when the user asks about who can access the operant or wants to change access.
---

# Manage Operant Access

## View Current Access

Read `~/.claude/channels/operant/config.json` and show the `telegramAllowFrom` array.

## Add a User

1. Ask for the Telegram user ID (numeric)
2. Read current config
3. Add the ID to `telegramAllowFrom` array
4. Write updated config
5. Restart daemon to apply

## Remove a User

1. Show current allowlist
2. Ask which ID to remove
3. Update config
4. Restart daemon

## Finding a User ID

Tell the user to message @userinfobot on Telegram to get their numeric ID.
