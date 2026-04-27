---
name: restart-daemon
description: Restart the channelhub hub-daemon tmux session cleanly and verify it came back up. Use when the user asks to restart the daemon, when code changes need to take effect, or when sessions are showing as disconnected and you suspect the daemon is wedged.
---

# Restart the channelhub daemon

The hub daemon runs in a tmux session named `hub-daemon`. After any change
to `src/daemon.ts`, `src/socket-server.ts`, `src/permission-engine.ts`,
`src/autopilot.ts`, `src/error-log.ts`, or anything else loaded at boot, the
daemon must be restarted to pick up the new code. Shim processes stay alive
across restarts and reconnect automatically.

## Procedure

Run these commands in order. The shell `until` loop blocks until the daemon
prints `daemon ready` (or times out at ~10 seconds).

```bash
tmux kill-session -t hub-daemon 2>/dev/null
tmux new-session -d -s hub-daemon "bun run src/daemon.ts"
deadline=$((SECONDS + 10))
until tmux capture-pane -t hub-daemon -p 2>/dev/null | grep -q "daemon ready" || [ $SECONDS -ge $deadline ]; do sleep 0.3; done
tmux capture-pane -t hub-daemon -p | tail -10
```

The final tail should include `daemon ready` and one `session connected:` line
per active hub session that auto-reconnected.

## Reply to the user

Report (in this order):

1. **Status** — `up` or `failed`. If failed, paste the last 10 lines of the
   pane capture and stop.
2. **Web UI port** — extract from `web UI at http://localhost:NNNN`.
3. **Sessions reconnected** — count of `session connected:` lines after restart,
   list them.
4. **What changed** — if you just edited code, name the files briefly so the
   user knows which fix is now live.

## Common failure modes

- **Port already in use** — pane shows `EADDRINUSE`. Another process is on the
  configured port. Run `lsof -nP -i :3001` (or the configured port) to find it.
- **`telegramAllowFrom is empty`** — refusing to start because the allowlist
  is empty in `~/.claude/channels/hub/config.json`. This is intentional safety;
  add the user's Telegram numeric ID before restarting.
- **`Module not found`** — typo in a recent edit. Run `bunx tsc --noEmit` and
  fix the import.
- **Daemon comes up but sessions don't reconnect** — shim processes died too.
  The user needs to re-attach Claude in each project (`claude
  --dangerously-load-development-channels server:hub`) until the plugin lands
  in the public marketplace.

## Do not

- Do not restart unless the user asked OR a code change actually needs it.
  Unnecessary restarts drop the active autopilot/veto state for ~3 seconds.
- Do not pass `kill-server` (kills ALL tmux sessions, including users'
  Claude sessions). Always target `-t hub-daemon`.
- Do not start the daemon outside tmux (`bun run src/daemon.ts &`). It dies
  on stdin EOF and you'll spend 10 minutes wondering why.
