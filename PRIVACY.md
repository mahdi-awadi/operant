# Privacy Policy

**Operant** is a self-hosted, open-source Claude Code channel plugin. It runs entirely on your local machine and does not collect, transmit, or store any data on any external servers operated by the project maintainers.

_Last updated: 2026-04-07_

## What Operant Does

Operant is a daemon that runs on your machine and bridges Claude Code sessions with a local web dashboard, a Telegram bot (configured by you), and a CLI. It is open source under the Apache-2.0 license. The source code is available at https://github.com/mahdi-awadi/operant.

## Data Collection

Operant **does not**:

- Send any data to the project maintainers or any remote server operated by the project
- Use analytics, telemetry, tracking pixels, or crash reporting services
- Store data in any cloud service
- Share data with third parties

## Data Handled Locally

Operant stores the following data **locally on your machine only**, under `~/.claude/channels/operant/`:

- **Configuration** (`config.json`) — your Telegram bot token, your allowed Telegram user IDs, web port, and trust preferences
- **Session registry** (`sessions.json`) — names, paths, and trust levels of registered Claude Code sessions
- **Uploaded files** — photos, documents, and other attachments you upload via Telegram or the web dashboard, saved to the session's project folder

These files stay on your machine. They are never transmitted to the project maintainers.

## Third-Party Services

If you configure the optional integrations, Operant communicates directly with these services from your machine:

- **Telegram Bot API** (`api.telegram.org`) — only if you provide a bot token. Your messages, files, and replies pass through Telegram's infrastructure. See [Telegram's Privacy Policy](https://telegram.org/privacy).
- **Claude Code / Anthropic** — Operant forwards messages to your local Claude Code sessions via the MCP channel protocol. Your messages reach Anthropic's API through Claude Code itself (not through Operant). See [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

Operant does not intercept, modify, or copy data sent to these services beyond what is necessary to route messages between you and your Claude Code sessions.

## Permissions and Access

When you grant Operant access to your Telegram bot or local filesystem, it uses those permissions only for the features you explicitly invoke (sending messages, spawning sessions, uploading files). Operant does not access data outside the directories you configure.

## Source Code Transparency

All data handling logic is open and auditable at https://github.com/mahdi-awadi/operant. You can inspect exactly what the code does, build it yourself, and modify it to suit your needs.

## Changes to This Policy

Updates to this privacy policy will be committed to the repository and reflected in the `Last updated` date above.

## Contact

For privacy-related questions, open an issue at https://github.com/mahdi-awadi/operant/issues.
