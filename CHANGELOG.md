# Changelog

All notable changes to Operant will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `/api/browse` and the spawn dialog's directory picker were broken when the daemon's `$HOME` was not an ancestor of the paths users wanted to spawn sessions in (e.g. daemon running as `root` with projects under `/home/*`). The initial browse was hardcoded to `/home/` in the web client and the scope was fixed to `$HOME`, so the dropdown returned 403 for every operator unless their home happened to contain `/home/`.

### Added
- Web dashboard: clicking the `↻` button on a disconnected session now opens a popover with two choices: **Resume** (picker over past conversations for this project's cwd, most recent pre-selected) and **New session**. Resume uses `claude --continue` / `claude --resume <id>`. Keyboard: Enter = activate, Arrow keys = navigate, Escape = close. Empty project (no prior sessions) shows only **New session**. ([spec](docs/superpowers/specs/2026-04-22-restart-resume-design.md) / [plan](docs/superpowers/plans/2026-04-22-restart-resume.md))
- New backend endpoint `GET /api/sessions/:name/prior` returning up to 10 recent sessions with first-user-message preview and `mtime`, read from `~/.claude/projects/<encoded-cwd>/*.jsonl`.
- `POST /api/spawn` gains an optional `resume: "continue" | { sessionId }` field; session IDs are validated against `^[0-9a-f-]{8,64}$`. Rejects `resume` when `teamSize > 1`.
- `ScreenManager.spawn()` gains an optional 5th `resume` parameter. Auto-respawn (crash recovery) stays resume-free by design.
- Web: `✕` button on disconnected session rows — `POST /api/remove` unregisters from the hub without tmux ops. Rejects active sessions with 409.
- Telegram: `/remove <name>` command for disconnected sessions (mirror of the web UI).
- Web: paste-to-upload for screenshots (`Ctrl+V` / `Cmd+V`) — pasted images attach to the next outgoing message.
- `browseRoot` config option widens the `/api/browse` scope beyond `$HOME`. Operators running the daemon as `root` with projects under `/home` can set `"browseRoot": "/home"` to restore the directory picker. Defaults to `$HOME` — safe-by-default unchanged.
- `/api/browse` response is now `{ root, dirs }` so the web client seeds the spawn dialog with the server's configured root instead of a hardcoded path.
- Shim: automatic reconnect to the daemon with exponential backoff (1/2/4/8/16/30s). A daemon restart is now invisible to the end user; sessions re-register within seconds and go green again. Pending tool calls reject with `hub disconnected, retry` so Claude can decide to retry. `SIGTERM`/`SIGINT` suppresses reconnect for clean shutdown. ([spec](docs/superpowers/specs/2026-04-22-shim-auto-reconnect-design.md))

## [0.1.0-beta.2] - 2026-04-21

### Security
- **Breaking — web frontend now binds to `127.0.0.1` only.** The previous default of `0.0.0.0` exposed an unauthenticated API on the LAN. Use a reverse proxy (Nginx/Caddy/Tailscale/SSH tunnel) for remote access.
- **Breaking — web API and WebSocket now require authentication.** Successful Telegram login sets a signed `HttpOnly`/`SameSite=Strict` `hub_session` cookie. Every `/api/*` call and WS upgrade validates the cookie and rejects with 401 otherwise. The Telegram Login Widget verification is no longer cosmetic.
- **Breaking — empty `telegramAllowFrom` is deny-all.** Previously it meant "allow every Telegram user," which made a mis-configured bot a public RCE primitive. The Telegram frontend now refuses to start and web login refuses every user when the list is empty.
- `/api/browse` is scoped to subtrees of `$HOME`. Requests for paths outside return 403.
- Upload filenames are sanitized (path separators and non-`[A-Za-z0-9._-]` chars stripped) and the resolved destination must stay inside the session's project root. Closes a traversal-write primitive in both Telegram and web upload handlers.
- Auto-fetched file contents (when Claude emits a bare save path in a reply) are scoped to the session's project root. Prompt-injection can no longer cause the daemon to read `~/.ssh/` and forward to Telegram.
- Unix socket (`~/.claude/channels/hub/hub.sock`) is `chmod 0600` after listen, preventing other local users on shared hosts from impersonating a shim.
- Telegram Login HMAC verification uses `crypto.timingSafeEqual` with try/catch for length mismatches.

### Added
- Sub-phase 1d: verification runner. New `/verify <session>` Telegram command runs profile-defined verification commands (or auto-detected `package.json` scripts) in the session's project directory. Silent on success, detailed failure report with exit code and 20-line output tail. Per-command 120s timeout, single concurrent run per session.
- Built-in profiles `tdd` and `careful` gain default verification commands (`bun test`, `bunx tsc --noEmit`).
- `tests/frontends/web-auth.test.ts`: 26 tests covering HMAC correctness, cookie signing, session verification, filename sanitization, path scoping, and the full auth middleware.
- `webHost` config option to override the default `127.0.0.1` bind address. Lets a containerized reverse proxy reach the daemon on a private bridge IP (e.g. `172.20.0.1`) without exposing it to the LAN. Defaults unchanged.

## [0.1.0-beta.1] - 2026-04-07

### Added
- Initial public release
- Multi-session daemon with Unix socket transport
- MCP shim bridging Claude Code stdio to daemon
- Telegram bot frontend with commands (list, spawn, kill, trust, team, etc.)
- Web dashboard with Telegram login, chat view, file upload
- CLI frontend (`operant` command)
- Native MCP permission relay (Allow / Always Allow / Deny)
- Per-session trust levels (ask / auto-approve)
- Agent teams support — spawn coordinated Claude sessions with team protocol
- Task monitoring — reads Claude's agent team task files
- Photo/document upload via Telegram to project folders
- Prompt tag toggles (Superpowers, TDD, Concise, etc.)
- Directory browser in spawn dialog
- Auto-detection of Claude agent teammates (skipped from hub registry)
- Reconnect logic — sessions reuse disconnected slots, no ghost duplicates
- `install.sh` one-liner installer with prerequisite checks
- Plugin manifest (`plugin.json`) and marketplace manifest for Claude Code
- Skills (`configure`, `access`) for in-session setup help
- 65 tests covering registry, socket, router, permissions, screen, task monitor, frontends

[Unreleased]: https://github.com/mahdi-awadi/operant/compare/v0.1.0-beta.2...HEAD
[0.1.0-beta.2]: https://github.com/mahdi-awadi/operant/compare/v0.1.0-beta.1...v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/mahdi-awadi/operant/releases/tag/v0.1.0-beta.1
