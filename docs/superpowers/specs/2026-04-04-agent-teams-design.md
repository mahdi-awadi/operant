# Agent Teams Integration — Design Spec

## Overview

Add agent teams support to Claude Code Operant. Multiple Claude sessions in the same folder form a team: first = lead, additional = teammates. Operant spawns, monitors, and displays teams via web UI and Telegram. Claude's built-in agent teams protocol handles coordination.

## Session Model Change

**Before:** One session per folder (path = unique key, duplicates rejected).

**After:** Multiple sessions per folder allowed. They form a team:
- First session in a folder = **team lead** (index 0)
- Additional sessions = **teammates** (index 1, 2, ...)
- Registry key: `path:index` (e.g., `/home/awafi:0`, `/home/awafi:1`)
- Display names: `awafi` (lead), `awafi-2`, `awafi-3`

## Spawn Dialog

The spawn modal gets a team checkbox:

```
Session Name: [awafi        ]
Project Path: [/home/awafi   ]
☐ Run as team    Team size: [3]
                             [Spawn]
```

When checked:
- Operant spawns N tmux sessions: `operant-awafi`, `operant-awafi-2`, `operant-awafi-3`
- Each auto-confirmed via `tmux send-keys Enter`
- All launched with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- First session becomes lead, rest become teammates
- Spawned sequentially (lead first, then teammates after 5s delay)

## Adding Teammates

**Web UI:** `[+]` button next to team lead in sidebar. Spawns one more teammate in the same folder.

**Telegram:** `/team awafi add` — adds one teammate to awafi's team.

## Sidebar UI (Web)

Teams displayed as collapsible groups:

```
▼ awafi (lead) 🟢        [+]
    awafi-2    🟢
    awafi-3    🟡
  Tasks: 3/8 done
```

- Team lead has `[+]` button to add teammates
- Teammates indented underneath lead
- Task summary shown at bottom of group
- Click lead → team overview + task list
- Click teammate → that teammate's activity
- Solo sessions (no team) display as before

## Telegram View

```
/list
🟢 awafi (team: 3 agents, 5/12 tasks done)
🔴 backend

/team awafi
👑 awafi (lead) 🟢
  ├ awafi-2 🟢 working on: auth module
  ├ awafi-3 🟢 working on: API endpoints
  │
  Tasks: 5/12 done
  ├ ✅ setup project structure
  ├ ✅ create database schema
  ├ 🔄 implement auth module (awafi-2)
  ├ 🔄 implement API endpoints (awafi-3)
  ├ ⏳ write tests (blocked by auth)
  └ ⏳ deploy config
```

Commands:
- `/team <name>` — show team details + tasks
- `/team <name> add` — add one more teammate
- `/<teammate-name> message` — message a specific teammate
- Plain text → goes to team lead (active session)

Phase 1: view only (display tasks, don't create/assign from Telegram).

## Environment

Each spawned session needs:
```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Set via the tmux spawn command:
```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-load-development-channels server:operant
```

## Task File Monitoring

Operant watches Claude's agent team files:

```
~/.claude/tasks/           → task lists (JSON files)
~/.claude/teams/           → team configs + inboxes
```

Uses `fs.watch` or polling (every 2-3s) to detect changes. Parses task JSONs and:
- Broadcasts updates to web UI via WebSocket
- Notifies Telegram on significant events (task completed, teammate idle)

Task JSON fields read:
- `status`: pending, in_progress, completed
- `subject`: task title
- `description`: what to do
- `owner`: assigned teammate
- `blockedBy`: dependency IDs

## Operant vs Claude Responsibilities

| Responsibility | Operant | Claude Agent Teams |
|---|---|---|
| Spawn lead + teammates | ✅ | ❌ |
| Auto-confirm dev warning | ✅ | ❌ |
| Set AGENT_TEAMS env var | ✅ | ❌ |
| Task creation & assignment | ❌ (phase 1) | ✅ |
| Task monitoring & display | ✅ | ❌ |
| Inter-agent messaging | ❌ | ✅ |
| File ownership enforcement | ❌ | ✅ |
| Show progress in web/Telegram | ✅ | ❌ |
| Add/remove teammates | ✅ | ❌ |

Operant = **launcher and monitor**. Claude = **coordinator and executor**.

## Implementation Scope

### Registry Changes
- Allow multiple sessions per folder path
- Track team index per session
- `SessionState` gains: `teamIndex: number`, `teamName: string | null`
- New method: `getTeam(path): SessionState[]`

### Screen Manager Changes
- `spawnTeam(name, path, size)` — spawns N sessions with AGENT_TEAMS env
- Delay between spawns (lead first, teammates after 5s)
- Each in separate tmux session with auto-confirm

### Task Monitor (New Module)
- `src/task-monitor.ts`
- Watches `~/.claude/tasks/` and `~/.claude/teams/`
- Emits events: `task:updated`, `team:changed`
- Parses task JSON files

### Web UI Changes
- Sidebar: grouped team display with `[+]` button
- Main area: task list view when team lead selected
- Spawn dialog: team checkbox + size input

### Telegram Changes
- `/team <name>` command
- `/team <name> add` command
- Updated `/list` to show team summaries
- Task notifications on completion

### Daemon Changes
- Wire task monitor events to web/telegram frontends
- Handle team spawn requests
- Pass AGENT_TEAMS env to spawned sessions
