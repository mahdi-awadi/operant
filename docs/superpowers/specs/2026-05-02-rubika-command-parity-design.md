# Rubika Command Parity — Design

**Status:** approved 2026-05-02
**Author:** mahdi.awadi@gmail.com (with Claude)
**Branch:** `feat/rubika-frontend-webhook`

## 1. Goal

Bring the Rubika frontend to feature parity with the Telegram frontend. Today the
Rubika frontend (`src/frontends/rubika.ts`, 195 lines) is an MVP that only relays
text in both directions with a single webhook endpoint. The Telegram frontend
(`src/frontends/telegram.ts`, 1,169 lines) implements 18 slash commands, inline
button callbacks, file uploads in/out, permission prompts with Allow/Deny
buttons, and the autopilot veto flow. After this work, the same set of features
is available on Rubika, using Rubika's own button/keypad/file APIs.

## 2. Scope

In:

1. All 18 Telegram slash commands implemented as Rubika command handlers, with
   the same outputs and the same usage messages.
2. `inline_keypad` button rendering for `/list`, `/team`, `/autopilot`,
   permission prompts, and autopilot veto prompts.
3. Inbound file handling — photos and documents arriving on Rubika are
   downloaded and saved to the active session's `<project>/<uploadDir>`.
4. Outbound file delivery — `RubikaFrontend.deliverToUser(name, text, files)`
   uploads each file via Rubika's `uploadFile` and sends them with `sendFile`.
5. `/start` greeting — Rubika delivers `/start` when the user taps Start; the
   bot replies with a one-line help message.
6. Permission prompts (Allow / Always Allow / Deny) and autopilot veto prompts
   (Send / Edit / Cancel), wired to the existing engines.
7. Per-user state: `chatIdByUser`, `activeSessionByUser` — all in-memory,
   no persistence beyond MVP. (Earlier draft listed `vetoEditPending` and
   `cmdAddPending`; removed because the Telegram frontend has neither.)

Out:

- Polling fallback (`getUpdates` loop). Documented as a follow-up.
- Sharing command logic between Telegram and Rubika. Approach **A — monolithic
  mirror** was chosen for speed; refactor toward a shared core can land later if
  drift becomes painful.
- Web-frontend changes beyond mounting one new HTTP route.
- New persistence (e.g., `hub.sqlite` chat history for Rubika).

## 3. Approach

**Monolithic mirror.** `src/frontends/rubika.ts` grows from 195 → ~1,200 lines
to mirror `telegram.ts` shape and size. No shared abstraction, no new modules.
Bug-for-bug parity, translated to Rubika's wire format.

The trade-off: every command's logic now lives in two files, and a future bug
fix is a two-PR job. Accepted, because (a) the MVP comment in `rubika.ts`
already commits to this staged rollout, (b) we have 337 tests as a safety net
for Telegram, and (c) extracting a shared core would touch working Telegram
code and risk regressions on the higher-traffic frontend.

## 4. Architecture

### 4.1 File layout

```
src/frontends/rubika.ts          — grows from 195 → ~1,200 lines
tests/frontends/rubika.test.ts   — grows from 15 → ~80 cases
tests/frontends/rubika.integration.test.ts (new) — HTTP-level tests
src/frontends/web.ts             — one new route mount
docs/superpowers/specs/2026-05-02-rubika-command-parity-design.md (this file)
```

### 4.2 `RubikaFrontend` shape

```
class RubikaFrontend
├── start()                          — registers BOTH endpoint types
│     ├─ ReceiveUpdate          (text/file/photo updates)
│     └─ ReceiveInlineMessage    (inline button clicks)
├── handleWebhook(body)              — inbound NewMessage dispatch
├── handleInlineWebhook(body)        — inbound button click dispatch
├── deliverToUser(name, text, files) — outbound text + file fan-out
├── command handlers (one per slash command)
│     cmdList, cmdStatus, cmdSpawn, cmdKill, cmdRemove, cmdRename,
│     cmdTrust, cmdPrefix, cmdAll, cmdTeam, cmdAutopilot, cmdVerify,
│     cmdProfiles, cmdProfile, cmdRules, cmdFact, cmdFacts, cmdChannel,
│     cmdStart
├── callback prefix handlers
│     onPermission, onAutopilotVeto, onListSelect, onDrift
├── per-user state maps
│     chatIdByUser, activeSessionByUser
└── helpers
│     parseArgs, sendButtons, sendFile, downloadFile, uploadFile, formatErr
```

### 4.3 Daemon wiring

`src/daemon.ts` already constructs `RubikaFrontend` and calls
`webFrontend.attachRubikaWebhook(rubikaFrontend)`. We extend the attachment
to mount **both** endpoints. `RubikaFrontend` exposes `inlineWebhookPath`
alongside the existing `webhookPath`; `WebFrontend.attachRubikaWebhook` mounts
both.

### 4.4 Web frontend

Two routes exist after this PR (auth bypass for both):

- `POST /api/rubika/webhook/:secret`        — `RubikaFrontend.handleWebhook`
- `POST /api/rubika/inline-webhook/:secret` — `RubikaFrontend.handleInlineWebhook`

Same secret derivation (HMAC-SHA256 of token under `channelhub-rubika-webhook`
label, base64url). Both paths share the same secret — they identify the same
bot, just different event streams.

## 5. Data flow

### 5.1 Inbound text/file message

```
User types in Rubika app
  → Rubika POSTs /api/rubika/webhook/<secret>
  → web.ts validates secret, parses JSON, dispatches
  → RubikaFrontend.handleWebhook(body)
    ├─ guard: senderId in allowFrom (else log + drop)
    ├─ remember chat_id per sender
    ├─ if text starts with "/", dispatch to cmdXxx
    ├─ else if file present, downloadFile + save + ack
    └─ else routeToSession(activeSession, text, "rubika", senderId)
  → MessageRouter.routeToSession
  → SocketServer → shim → Claude Code
```

### 5.2 Inbound inline button click

```
User taps button
  → Rubika POSTs /api/rubika/inline-webhook/<secret>
  → handleInlineWebhook(body)
    ├─ guard: senderId in allowFrom
    ├─ parse aux_data.button_id  (e.g. "perm:allow:42")
    ├─ dispatch by prefix:
    │     "select:<name>"          → activeSessionByUser.set(senderId, name)
    │     "perm:allow|deny:<rid>"  → permissions.resolve(rid, behavior) then
    │                                 socketServer.sendToSession(path, response)
    │     "ap-send:<sessionName>"  → vetoController.cancel(path) then
    │                                 socketServer.sendToSession(path, draft)
    │     "ap-cancel:<sessionName>"→ vetoController.cancel(path)
    │     "drift:remind:<name>"    → socketServer.sendToSession(path,
    │                                 channel_message with rule reminder)
    │     "drift:ignore:<name>"    → no-op (clear prompt only)
    └─ optional: editMessageInlineKeypad to clear buttons after click
```

### 5.3 Outbound: deliverToUser

```
Claude calls reply(text, files?)
  → daemon.deliverToFrontends loop
  → RubikaFrontend.deliverToUser(name, text, files)
    ├─ for each allowFrom user with known chat_id:
    │   ├─ if files: uploadFile(each) → sendFile(chat_id, file_id, caption)
    │   └─ sendMessage(chat_id, "[name] text", inline_keypad?)
```

### 5.4 Outbound: permission prompt

```
Claude sends permission_request via MCP
  → permissionEngine queues request
  → calls deliverToFrontends with rendered prompt + button spec
  → deliverToUser sends sendMessage with inline_keypad
  → user taps Allow → see 5.2
```

## 6. Components

### 6.1 Commands

Every command parses with the same `text.split(/\s+/)` shape as Telegram. Same
usage hints, same error replies, same outputs.

| Category | Commands |
|---|---|
| Discovery | `/list`, `/status`, `/profiles`, `/profile`, `/facts` |
| Lifecycle | `/spawn`, `/kill`, `/remove`, `/rename` |
| Team | `/team` |
| Behavior | `/trust`, `/autopilot`, `/prefix`, `/rules`, `/fact`, `/channel`, `/verify` |
| Broadcast | `/all` |
| Greeting | `/start` (new — silent on Telegram, replies with help on Rubika) |

`/start` reply text:

> 👋 Connected to Claude Code Hub. Use /list to pick a session or send any message to talk to the active one.

### 6.2 Inline button mapping (Telegram ↔ Rubika)

| Telegram | Rubika |
|---|---|
| `inline_keyboard: [[{text, callback_data}]]` | `inline_keypad: { rows: [{ buttons: [{ id, type:'Simple', button_text }] }] }` |
| `callback_query.data` | `inline_message.aux_data.button_id` |

`callback_data` strings (`perm:allow:42`, `select:sap`, `ap-cancel:my-session`,
etc.) become Rubika `id` strings unchanged — the routing prefix scheme is
identical to Telegram. The complete set is:

| Prefix | Producer | Consumer |
|---|---|---|
| `select:<sessionName>` | `/list` | sets `activeSessionByUser` |
| `perm:allow:<rid>` | permission prompt | `permissions.resolve(rid, 'allow')` then `socketServer.sendToSession` |
| `perm:deny:<rid>` | permission prompt | `permissions.resolve(rid, 'deny')` then `socketServer.sendToSession` |
| `ap-send:<sessionName>` | autopilot veto prompt | `vetoController.cancel(path)` then `socketServer.sendToSession` with the draft |
| `ap-cancel:<sessionName>` | autopilot veto prompt | `vetoController.cancel(path)` (cancellation message only — no session send) |
| `drift:ignore:<sessionName>` | drift detector | clears the prompt's reply markup |
| `drift:remind:<sessionName>` | drift detector | sends a rule-reminder `channel_message` to the session |

Amended 2026-05-02: previous spec invented `perm:always`, `vp:*`, `team:add:*`,
and `autopilot:on/off:*` callbacks. Those are not present in `telegram.ts`.
Removing them keeps Rubika at true parity with the Telegram frontend.

### 6.3 Permission prompt rendering

When an `ask`-trust session asks for tool permission, Rubika receives:

```
🔒 <session> wants to use **<tool>**
<input_preview>

[ Allow ]   [ Deny ]
```

Button IDs: `perm:allow:<rid>`, `perm:deny:<rid>`. (No "Always Allow" — the
trust upgrade flow is handled by `/trust <session> auto`, exactly like
Telegram.)

### 6.4 Autopilot veto

Two buttons mirroring Telegram: `[ ✅ Send ] [ ❌ Cancel ]` with IDs
`ap-send:<sessionName>` and `ap-cancel:<sessionName>`. The user does not
edit drafts inline — to edit, they cancel and answer the session themselves
(matching Telegram's flow).

### 6.5 Files

**Inbound.** Rubika's `NewMessage` carries a `file` field (`{ file_id, type,
size, file_name }`) for photos and documents — no separate photo path. We
download via `getFile(file_id)` → write to
`<sessionPath>/<uploadDir>/<file_name>`. Reply with the saved relative path
(matching Telegram).

**Outbound.** `deliverToUser(name, text, files)` follows Rubika's two-step
upload (probed against the live API on 2026-05-02):

1. POST `requestSendFile` with `{ type: "File" }` (or `"Image"` / `"Voice"` /
   `"Video"` / `"Music"` / `"Gif"` per MIME) → returns `{ upload_url }`.
2. POST the file bytes to `upload_url` → returns `{ file_id }`.
3. POST `sendMessage` with `file_inline: { file_id, type, file_name, size, … }`
   to attach the file to a message.

Caption `[<session>] <text>` is attached to the first file only; subsequent
files have no caption. Helper functions `uploadFile(path) → file_id` and
`sendFile(chat_id, file_id, caption?, type)` wrap steps 1–2 and step 3
respectively.

**Note on inbound file envelope shape.** The exact field name carrying the
inbound `file_inline` on `NewMessage` (likely `file_inline` mirroring the
outbound shape, but possibly `file` per legacy docs) is verified during
implementation by sending a real photo through the live bot and inspecting
the `getUpdates` response. If the field name differs from `file_inline`, the
implementation switches to whatever is observed.

### 6.6 Allowlist + secret

Unchanged from MVP. `rubikaAllowFrom` enforced inside both webhook handlers.
HMAC secret in URL path is derived once at construction; same secret powers
both routes.

## 7. Error handling

### 7.1 Rubika API failures

`realSend` already throws on HTTP non-2xx and on app-level error envelopes
(`status: "INVALID_INPUT" | "INVALID_AUTH" | …`). Callers handle as follows:

| Call site | On failure |
|---|---|
| `start()` registration | log + continue (daemon must boot even if Rubika is unreachable) |
| `deliverToUser` | log per-user, continue loop — one user's broken chat does not block others |
| `sendFile` upload | log, fall back to text-only `sendMessage` with `[file too big to upload: name.ext]` note |
| Command handlers | catch → reply `⚠️ Command failed: <err>` to user, log full err to stderr |
| Inline button responses | catch → log only (no user reply) |

### 7.2 Webhook delivery failures

We saw on 2026-04-30 that Rubika silently stopped pushing despite a successful
`updateBotEndpoints` call. Mitigations in this PR:

- `start()` awaits both registrations and logs success/failure clearly.
- On every daemon boot, both endpoint types are re-registered (idempotent).
- A new `refresh-rubika` CLI subcommand (added in this PR; admin-only,
  not user-facing on Rubika) re-calls `updateBotEndpoints` for both types.
  Recovery lever for the silent-push outage we observed on 2026-04-30.

A polling fallback is **out of scope** for this PR and tracked as a follow-up.

### 7.3 Malformed inbound bodies

Both `handleWebhook` and `handleInlineWebhook` wrap parsing in try/catch and
return early on missing required fields. The HTTP layer in `web.ts` returns:

- `200 ok` — parsed envelope, even if dropped (allowlist reject, unknown
  command). Rubika should not retry these.
- `400` — unparseable JSON.
- `401` — wrong secret in path.

### 7.4 Per-command argument validation

Mirror Telegram exactly — short usage hint as the reply text. Examples:
`/spawn` with no args → `Usage: /spawn <name> <path> [--profile <name>] [team-size]`.

### 7.5 Permission timeout

The existing TTL in `permission-engine.ts` calls `deliverToUser` with
`🕐 Permission request expired`. Rubika sends this as a normal `sendMessage`
with no buttons. No new state needed.

### 7.6 File save errors

If `<sessionPath>/<uploadDir>` does not exist or write fails, reply
`⚠️ Could not save file: <err>` to the user. Mirrors Telegram.

### 7.7 Concurrency

In-flight `start()` calls guarded by `this.started`. Per-user `Map` writes are
single-threaded in Bun. No locks needed.

## 8. Testing

### 8.1 Unit tests

`tests/frontends/rubika.test.ts` grows from 15 → ~80 cases. Same `FakeSender`
+ `StubRouter` fixtures as today; add `StubPermissionEngine`, `StubAutopilot`,
`StubScreenManager`. No real network, no real tmux.

| Group | Cases |
|---|---|
| `deriveWebhookSecret` (already there) | 4 |
| `handleWebhook` text routing | 8 |
| `handleWebhook` file inbound | 6 |
| `handleInlineWebhook` callbacks | 12 |
| Per-command (18 commands × ≥2 cases each) | ~40 |
| `deliverToUser` outbound | 6 |
| `start()` | 4 |

Each new public method or callback prefix gets at least one happy-path and one
failure-path case.

### 8.2 Integration tests

`tests/frontends/rubika.integration.test.ts` (new) hits the real `WebFrontend`
HTTP server with `RubikaFrontend.attached`. Reuses the `tests/frontends/web.test.ts`
harness style.

```ts
test('POST /api/rubika/webhook/<secret> with NewMessage routes to session', ...)
test('POST /api/rubika/inline-webhook/<secret> with perm:allow:* hits engine', ...)
test('wrong secret → 401', ...)
test('right secret + malformed body → 400', ...)
test('non-allowed sender → 200 + no router call', ...)
```

### 8.3 Manual smoke test

Saved as a checklist in the PR description:

- [ ] `/start` from Rubika → greeting reply
- [ ] `/list` → buttons appear; tapping switches active session; subsequent
      plain text routes correctly
- [ ] Send a photo from Rubika → file appears in active session's `<uploadDir>`
- [ ] Trigger a permission prompt → 3 buttons appear; tapping `Always Allow`
      flips trust
- [ ] Toggle autopilot, force a `/btw` reply → veto prompt with Send/Edit/Cancel
- [ ] Restart daemon → both webhook endpoints re-register, queued messages
      drain

### 8.4 CI

The existing `bun test` job picks up the new files automatically. Expected
total: 337 + ~70 → ~407 tests.

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Rubika changes its envelope shape silently | Integration test pins the exact JSON we accept; CI fails on drift |
| `inline_keypad` rendering differences across Rubika versions | Manual smoke checklist per release |
| Webhook push silently stops (today's bug) | Documented `/refresh-rubika` recovery; polling fallback as follow-up PR |
| File downloads time out | Add `AbortController`-based 30s timeout to `realSend` (new in this PR); log + skip; reply `⚠️ Could not download file` |
| Telegram regression from any incidental refactor | None — this PR does not touch `telegram.ts` |
| Two-place command logic drifts | Accepted; revisit if drift causes a bug; refactor to shared core is a clean follow-up |

## 10. Follow-ups (not this PR)

- Polling fallback on `getUpdates` for resilience against silent push outages.
- Optional shared command-handler core to deduplicate Telegram + Rubika logic.
- Persistence of Rubika chat history in `hub.sqlite`, mirroring web.
- `chat_keypad` (persistent reply keyboard) for mobile ergonomics.
