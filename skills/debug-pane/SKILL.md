---
name: debug-pane
description: Snapshot a operant session's tmux pane PLUS its recent autopilot errors and registry state in one structured dump. Use when the user reports an autopilot/permission/spawn problem on a specific session, or when you need fast forensic context before forming a hypothesis.
---

# Debug a operant session

Replaces the manual 4-tool dance (`tmux capture-pane`, `sqlite3`, `grep
sessions.json`, `grep daemon log`) with one structured collection step. Use
this BEFORE proposing any fix.

## Inputs

You need: **session name** (e.g. `sap`, `ap-test`, `eticket-v3`). The user
usually says it; if not, ask once. Run `tmux ls | grep ^hub-` to see what's
live.

## Procedure

```bash
NAME="<session-name>"
TMUX="hub-${NAME}"

echo "=== 1. Visible pane (no scrollback) ==="
tmux capture-pane -t "${TMUX}" -p 2>&1 | tail -40

echo
echo "=== 2. Pane WITH scrollback (200 lines) — for /btw history forensics ==="
tmux capture-pane -t "${TMUX}" -p -S -200 2>&1 | tail -60

echo
echo "=== 3. Registry state (~/.claude/channels/hub/sessions.json) ==="
python3 -c "
import json
with open('$HOME/.claude/channels/hub/sessions.json') as f: m = json.load(f)
for k,v in m.items():
    if v.get('name') == '${NAME}':
        print(f'  path: {k}')
        print(json.dumps(v, indent=2))
        break
else:
    print('  NOT REGISTERED')
"

echo
echo "=== 4. Last 5 autopilot errors for this session ==="
sqlite3 "$HOME/.claude/channels/hub/errors.sqlite" \
  "SELECT id, datetime(ts/1000,'unixepoch','localtime') AS when_, status, reason, length(captured_pane) AS pane_len, duration_ms FROM autopilot_errors WHERE session_name = '${NAME}' ORDER BY ts DESC LIMIT 5" 2>/dev/null \
  || echo "  errors.sqlite not present or no rows"

echo
echo "=== 5. Last 30 daemon log lines mentioning this session ==="
tmux capture-pane -t hub-daemon -p -S -300 2>&1 | grep -E "${NAME}|/$(basename ${NAME})" | tail -30
```

## Analyze

After the dump, work top-down:

| Step | What you're looking for |
|---|---|
| 1 | Is Claude **idle** (`❯` prompt + `? for shortcuts`)? Or stuck on a permission menu (`❯ 1. Yes`)? Or showing `esc to interrupt` (busy)? |
| 2 | Stale `/btw` overlays in scrollback — if the parser sees these without our recent fix, it returns OLD answers. Identify any `↑/↓ to scroll` footers that are NOT in the visible pane. |
| 3 | `autopilot.enabled`? `trust` level? `priorTrust` set? `riskOverride`? |
| 4 | Most recent failure status. If `parse_error`, retrieve the full `captured_pane`: `sqlite3 ... "SELECT captured_pane FROM autopilot_errors WHERE id = N"` |
| 5 | Daemon's view — did /btw fire? what's the timing? any `permission_request` storm? |

## Reply to the user

Lead with the **diagnosis**, not the data dump. Format:

```
🔍 sap diagnosis
- Session state: [idle | stuck on permission | mid-task]
- Autopilot: [on/off, trust=X, started Nm ago]
- Last 3 autopilot results: [answered | parse_error | timeout | escalate]
- Hypothesis: <one sentence>
- Smoking gun: <file:line OR captured_pane snippet>
```

Then offer the next step (fix / continue investigating / ask for clarification).

## Don't

- Don't dump all 5 sections to the user verbatim — that's noise. They want the
  **diagnosis**. Keep raw data behind a collapsed code block at most.
- Don't propose a fix in the same message — separate diagnosis from action so
  the user can reject the hypothesis cheaply.
- Don't include `captured_pane` blobs in chat (they can be 100KB+). Reference
  the row id and let the user query if they want it.
