---
name: e2e-autopilot
description: Run an end-to-end autopilot test in a disposable /tmp project — spawn a Claude session, enable autopilot, fire a known prompt, capture the response, tear down. Use when validating an autopilot code change without disturbing the user's real sessions.
---

# E2E test the autopilot loop

Today's debugging exposed three real autopilot bugs (multi-paragraph
truncation, scrollback cache poisoning, mid-sentence capture) — none of them
caught by unit tests because they only surface against real Claude Code +
tmux + the live /btw component. This skill codifies the manual ritual.

## When to use

- After any change to `src/autopilot.ts`, `src/autopilot-parser.ts`,
  `src/autopilot-risk.ts`, `src/screen-manager.ts:capturePane`, or the
  daemon's reply-handler autopilot block.
- Before claiming an autopilot fix works.
- When the user reports an autopilot symptom you can't reproduce against
  their session.

Don't use this for parser-only fixes — those have unit tests in
`tests/autopilot-parser.test.ts`. This skill is for the *integration*.

## Setup (one-time per test run)

```bash
TEST_DIR="/tmp/ap-test-$$"
TEST_NAME="ap-test-$$"
TMUX="operant-${TEST_NAME}"

mkdir -p "${TEST_DIR}" && echo "# Disposable test bed" > "${TEST_DIR}/CLAUDE.md"

# Spawn Claude Code in the test dir, attached to our operant
tmux new-session -d -s "${TMUX}" -c "${TEST_DIR}" \
  "claude --dangerously-load-development-channels server:operant"

# Auto-confirm the trust + dev-channel prompts
sleep 8
tmux send-keys -t "${TMUX}" Enter
sleep 4
tmux send-keys -t "${TMUX}" Enter
sleep 6
tmux capture-pane -t "${TMUX}" -p | tail -10
```

Verify the daemon registered the session:

```bash
tmux capture-pane -t operant-daemon -p -S -50 | grep "${TEST_DIR}"
```

You should see `operant: session connected: ${TEST_DIR}:0`.

## Enable autopilot (no auth, direct registry)

The `/api/autopilot` endpoint requires a web cookie. For a test, write
directly to the persisted state and restart the daemon (see
`operant:restart-daemon`):

```bash
python3 -c "
import json
p = '$HOME/.claude/channels/operant/sessions.json'
with open(p) as f: m = json.load(f)
key = f'${TEST_DIR}:0'
m[key] = {
    'name': '${TEST_NAME}', 'trust': 'auto', 'prefix': '', 'uploadDir': '.',
    'managed': False, 'teamIndex': 0, 'teamSize': 1, 'profileOverrides': {},
    'autopilot': {'enabled': True, 'vetoWindowMs': 0, 'btwTimeoutMs': 60000,
                  'maxDurationMinutes': 99999, 'startedAt': $(date +%s)000},
}
with open(p,'w') as f: json.dump(m,f,indent=2)
"
```

Then invoke the `operant:restart-daemon` skill.

## Run a test prompt

Choose a question that exercises the path you changed. Defaults:

| What you're testing | Prompt |
|---|---|
| Basic injection | `Use the operant.reply tool to ask: Should we use Bun or Node? Wait for the answer.` |
| Multi-paragraph parsing | `Use the operant.reply tool to ask: Walk me through the trade-offs between A) microservices and B) modular monolith for our use case.` |
| Risk filter | `Use the operant.reply tool to ask: Should I force push to main to fix the broken build?` |
| Scroll-to-top | (use multi-paragraph prompt) |

Send it:

```bash
tmux send-keys -t "${TMUX}" "<your prompt here>"
sleep 0.3
tmux send-keys -t "${TMUX}" Enter
```

Wait for the autopilot result line in the daemon log:

```bash
until tmux capture-pane -t operant-daemon -p -S -200 | grep -q "autopilot ${TEST_NAME}.*status="; do
  sleep 5
done
tmux capture-pane -t operant-daemon -p -S -200 | grep "autopilot ${TEST_NAME}" | tail -3
```

## Verify

Check three things, in order:

1. **Status** — should be `answered`. Anything else (`parse_error`, `timeout`,
   `escalate`) is a real failure → query `/api/errors` or `errors.sqlite` for
   the captured pane.
2. **Length** — sanity check it's not 0 or absurdly small (truncation).
3. **Injection** — capture the test session pane: the autopilot answer
   appears as `← operant: <answer>` immediately after `Asked. Waiting…`. Verify
   it starts at a sentence boundary, not mid-sentence (the scroll-to-top
   bug we fixed was the prime example).

```bash
tmux capture-pane -t "${TMUX}" -p -S -50 | grep -B1 -A2 "← operant:" | tail -15
```

## Tear down

```bash
tmux kill-session -t "${TMUX}" 2>/dev/null
rm -rf "${TEST_DIR}"
# Remove the test entry from sessions.json
python3 -c "
import json
p = '$HOME/.claude/channels/operant/sessions.json'
with open(p) as f: m = json.load(f)
m.pop('${TEST_DIR}:0', None)
with open(p,'w') as f: json.dump(m,f,indent=2)
"
```

(Skipping teardown is fine for short iteration — disposable `/tmp` cleans up
on reboot. But the registry entry will keep showing as disconnected in the
sidebar, which is noise.)

## Reply to the user

Format:

```
✅ E2E pass — <test name>
- Status: answered in N ms, M chars
- Injection start: "<first 10 words of answer>"
- Pane state after: <idle | follow-up question | error>
```

Or on failure:

```
❌ E2E fail — <test name>
- Status: parse_error
- Captured pane (truncated to 30 lines): <pane>
- Hypothesis: <one sentence>
- /api/errors row: id=N
```

## Don't

- Don't run this against the user's real sessions (`sap`, etc.) — it sends
  prompts that will absolutely confuse Claude in those sessions.
- Don't skip teardown if you're going to run more than 2 iterations — the
  registry accumulates dead `ap-test-*` entries.
- Don't enable autopilot via writing `sessions.json` and skipping the daemon
  restart — the in-memory registry won't see the change.
