---
name: autopilot
description: Set up autopilot mode for a operant project. Use when the user wants to configure how their project answers questions on their behalf — specifically which preferences the proxy should honor.
---

# Autopilot Mode

When a operant session is in autopilot mode, the daemon fires `/btw` inside
the session on every user-facing question. The proxy answers using the
session's own conversation context plus the preferences in `autopilot.md`.

## Set up `autopilot.md`

Create `autopilot.md` in your project root. Use markdown freeform — the proxy
will read it verbatim. A good starter:

```markdown
# Preferences for autopilot

- Prefer Bun over Node
- Prefer minimal dependencies; avoid adding new ones unless unavoidable
- Always TDD: test first, then implement
- Prefer explicit over clever
- For UI decisions, pick the simpler / more-accessible option
- Never add analytics / tracking without asking
```

## Enable autopilot

- **Telegram:** `/autopilot <session-name> on`
- **Web:** click the "Autopilot" toggle in the session row
- **CLI:** `bun run src/cli.ts autopilot <session-name> on`

## What gets escalated

The proxy will skip the /btw and ping you directly when:

- Your question contains a risk keyword (`delete`, `force push`, `production`, `billing`, `api key`, etc.)
- The proxy answers `ESCALATE: <reason>` (for irreversible or out-of-scope choices)
- The /btw overlay fails to parse or times out

## Veto window

By default, autopilot shows the draft answer for 30 seconds before auto-sending.
You can **Send** it as-is, **Edit** the text, or **Cancel** to skip this one and
handle it manually. If you take too long, the answer is sent anyway — this keeps
the workflow moving without needing you to babysit every interaction.
