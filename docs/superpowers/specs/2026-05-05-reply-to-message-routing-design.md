# Reply-to-Message Routing

**Date:** 2026-05-05
**Branch:** `feat/headless-chrome` (continuation)

## Problem

Today, plain text from Telegram and Rubika routes to the user's *active* session. To target a different session, the user has to either select it from `/list` first or type `/<session-name> message`. Both add friction on mobile, where switching contexts mid-thread is common — the user often wants to answer the most recent message from session B without losing their currently-active session A.

Replying to a chat message is a natural UX gesture for "this is for that thread." We have not exploited it.

## Goal

When the user replies to a bot-originated message in Telegram or Rubika, route the reply text to the session that *produced* the original message — even if that session is not the user's active session. Falls back to the active-session behavior when there is no reply context.

## Out of Scope

- Web frontend: the chat UI is already per-session, so the question doesn't arise.
- Replying to one's *own* prior message (no mapping exists) → falls back to active session.
- Persistence across daemon restarts: the map is in-memory; cold-start behavior is "no mappings yet, fall back to active." Acceptable because mappings naturally rebuild as new messages flow.

## Design

### Data structure

Each frontend keeps a per-chat ring buffer:

```
messageMap: Map<chatId, { messageId, sessionName }[]>
```

- Cap: 200 entries per chat (oldest evicted on insert).
- Cleared on `stop()` for hygiene; not persisted.

Why per-chat, not global: Rubika sends the same `chat_id` to a single user; mapping is naturally scoped. Avoids cross-user contamination.

### Outgoing capture

Hook `deliverToUser` in both frontends:

- **Rubika:** after each successful `sendMessage` / `sendFile`, parse the response for `message_update.message_id` (or `message_id` at top level — whichever Rubika returns). Store `chatId → { messageId, sessionName }`.
- **Telegram:** `bot.api.sendMessage` returns a `Message` object; capture `message.message_id` and store `userId → { messageId, sessionName }`.

Outgoing types we capture: per-session messages (`deliverToUser`), permission prompts, autopilot drafts, restart prompts, drift alerts, file deliveries. Goal: any bot message that "belongs" to a session should be replyable. System messages with no session (e.g. global `/list` output, `No active session.`) are NOT captured — replying to them falls back to active.

### Inbound lookup

In each frontend's inbound handler, BEFORE the active-session fallback:

1. Extract reply context:
   - **Rubika:** `update.new_message.reply_to_message_id` (string). Field name not yet confirmed in our types — defensive: also check `reply_to_message?.message_id`.
   - **Telegram:** `ctx.message.reply_to_message?.message_id`.
2. If present, look up `(chatId, replyToMessageId)` in `messageMap`.
3. If found, route to the mapped session (regardless of active session).
4. If the mapped session is no longer registered, reply with a short notice ("That session is gone — re-select with /list") and stop. Do NOT silently fall through to active.
5. If no reply context or no mapping (e.g. user replied to their own message), fall through to existing active-session logic.

### Targeted-message syntax interaction

Existing `/<session-name> text` syntax (parsed by `MessageRouter.parseTargetedMessage`) takes precedence over reply context — explicit prefix wins. Order: prefix check → reply check → active fallback.

### Error handling

- Outgoing capture failure (bad response shape, parse error) → log to stderr, do not throw. The message was already delivered; we just lose one mapping.
- Map full → silently evict oldest. No user-visible effect.
- Reply to bot message from a session that since died → reply with notice and stop (item 4 above).

### File structure

Two files touched:

- `src/frontends/rubika.ts`:
  - New private `captureMessageMapping(chatId, sessionName, response)` helper.
  - Modify `deliverToUser`, `deliverPermissionRequest`, `deliverAutopilotDraft`, `sendRestartPrompt`, `deliverDriftAlert` to capture.
  - Modify `handleWebhook` inbound text path to consult the map before falling back to active.
  - Add `reply_to_message_id` to the `RubikaUpdateBody.update.new_message` type.

- `src/frontends/telegram.ts`:
  - New private `captureMessageMapping(userId, sessionName, sentMessage)` helper.
  - Modify `deliverToUser` and the equivalents (permission, autopilot draft, drift) to capture the returned `Message`.
  - Modify the `bot.on('message:text')` handler to consult `ctx.message.reply_to_message?.message_id` first.

Both frontends share the same logic; could be factored into a helper module if a third frontend appears. For two callers, inline the small data structure rather than over-abstract.

## Tests

- `tests/frontends/rubika.test.ts`:
  - Reply with no map entry → falls back to active session.
  - Outgoing message captured → reply routes to mapped session, NOT active.
  - Mapped session no longer registered → user gets notice, no route.
  - Targeted prefix `/foo bar` while replying to a message → prefix wins.
  - Map at cap (200) → oldest evicted, newest available.

- `tests/frontends/telegram.test.ts`:
  - Same matrix as Rubika.

- No web tests (out of scope).

## Risks

1. **Rubika field name unverified.** Defensive parsing covers two plausible shapes (`reply_to_message_id` string, or nested `reply_to_message.message_id`). If the actual field is something else, the feature simply never triggers and the user falls back to active — no regressions. We can fix the field name in a 1-line follow-up after observing a real payload in the log (will add a one-time `process.stderr.write` of the raw inbound update body the first time we see ANY reply field in the next live run, behind a `RUBIKA_DEBUG_REPLIES` env var to keep noise off in normal operation).

2. **Outgoing message_id parsing.** Rubika's response shape for `sendMessage` is similarly under-documented in our codebase. Parser tries `data.message_update.message_id` and `data.message_id`. If both miss, log once at warn level. Same fallback story: feature degrades gracefully.

3. **Stale mapping after rename.** If a session is renamed mid-thread, replies to old messages route to the new name (we store name, look up via `registry.findByName`). Acceptable.

## Acceptance

- Reply to bot message in Rubika → routes to source session (verified by checking the session's transcript).
- Reply with no mapping in Rubika → routes to active session (existing behavior).
- Same two cases in Telegram.
- All existing tests pass.
- New tests cover the matrix above.
