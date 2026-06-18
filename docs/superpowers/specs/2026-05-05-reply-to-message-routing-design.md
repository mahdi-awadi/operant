# Reply-to-Message Routing

**Date:** 2026-05-05
**Branch:** `feat/headless-chrome` (continuation)

## Problem

Today, plain text from Telegram routes to the user's *active* session. To target a different session, the user has to either select it from `/list` first or type `/<session-name> message`. Both add friction on mobile, where switching contexts mid-thread is common — the user often wants to answer the most recent message from session B without losing their currently-active session A.

Replying to a chat message is a natural UX gesture for "this is for that thread." We have not exploited it.

## Goal

When the user replies to a bot-originated message in Telegram, route the reply text to the session that *produced* the original message — even if that session is not the user's active session. Falls back to the active-session behavior when there is no reply context.

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

Why per-chat, not global: mappings are naturally scoped to the chat. Avoids cross-user contamination.

### Outgoing capture

Hook `deliverToUser` in the Telegram frontend:

- **Telegram:** `bot.api.sendMessage` returns a `Message` object; capture `message.message_id` and store `userId → { messageId, sessionName }`.

Outgoing types we capture: per-session messages (`deliverToUser`), permission prompts, autopilot drafts, restart prompts, drift alerts, file deliveries. Goal: any bot message that "belongs" to a session should be replyable. System messages with no session (e.g. global `/list` output, `No active session.`) are NOT captured — replying to them falls back to active.

### Inbound lookup

In each frontend's inbound handler, BEFORE the active-session fallback:

1. Extract reply context:
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

One file touched:

- `src/frontends/telegram.ts`:
  - New private `captureMessageMapping(userId, sessionName, sentMessage)` helper.
  - Modify `deliverToUser` and the equivalents (permission, autopilot draft, drift) to capture the returned `Message`.
  - Modify the `bot.on('message:text')` handler to consult `ctx.message.reply_to_message?.message_id` first.

Inline the small data structure rather than over-abstract.

## Tests

- `tests/frontends/telegram.test.ts`:
  - Reply with no map entry → falls back to active session.
  - Outgoing message captured → reply routes to mapped session, NOT active.
  - Mapped session no longer registered → user gets notice, no route.
  - Targeted prefix `/foo bar` while replying to a message → prefix wins.
  - Map at cap (200) → oldest evicted, newest available.

- No web tests (out of scope).

## Risks

1. **Stale mapping after rename.** If a session is renamed mid-thread, replies to old messages route to the new name (we store name, look up via `registry.findByName`). Acceptable.

## Acceptance

- Same two cases in Telegram.
- All existing tests pass.
- New tests cover the matrix above.
