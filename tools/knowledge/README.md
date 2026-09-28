# Telegram knowledge service

Separate process and SQLite archive. It never polls the main bot: the support
service forwards /ask, /digest and /kbchats through its durable inbox. Only the
connected account's numeric ID in a private chat can run bot queries. Workspace
access requires the master admin token or a configured TELEGRAM_ADMIN_IDS member;
ordinary operators, including operators granted settings permissions, are denied.
The existing bot must already be configured in private transport mode.

## Deployment

Copy .env.example to .env and set independent random service and encryption keys
(32 random bytes in hexadecimal). Keep .env outside Git and include the encryption
key in your secured backup. Losing it makes the saved Telegram session unreadable.
Set the same KNOWLEDGE_SERVICE_TOKEN and KNOWLEDGE_SERVICE_URL in the root .env.
Run `docker compose up -d --build` here, then rebuild support-chat. The service
listens only on 127.0.0.1:7900, behind the existing authenticated HTTPS panel.
Reserve this listener from any FRP port allocation. No new public DNS is needed.
Back up knowledge-data together with the encryption key; SQLite backup must use
its backup API or stop this service first, not copy a live database alone.

## Initial setup

Workspace → База знаний → Подключение contains the instructions for creating
an app at https://my.telegram.org, entering API ID/hash, requesting a login code,
and completing 2FA. Codes and 2FA passwords stay in memory only. Session, API hash
and OpenAI key are encrypted with AES-GCM. Telegram Premium is not required.

Load the chat list, explicitly select chats, enable synchronization. Only text
and captions are saved; no media files are downloaded. History imports in batches
and resumes from a persisted cursor. Telegram rate limits pause the whole account.
The Telegram service chat (777000) and bot dialogs are excluded. Only history
accessible to the account can be imported. Live edits/deletions are tracked;
old edits or deletions made while disconnected may remain in the local archive.
Deselecting a chat stops ingestion and excludes it from answers. Purging removes
its local messages and the derived answer journal, never Telegram messages.
SQLite may retain free pages for reuse after purging.

The disk cap pauses ingestion without deleting older messages. Below 512 MB free
space imports pause regardless of the configured cap. The status describes pauses.

## Queries and costs

- `/ask question`: retrieve up to 60 keyword-ranked messages from selected chats.
- `/digest`: all cached messages in the 24 hours before the request.
- `/digest -100123456789`: same, from one selected chat.
- `/kbchats`: selected chat IDs and import status, no OpenAI call.

Panel queries are also available. The model receives only retrieved material or
bounded digest batches, then combines batch summaries. Sources link to original
messages when Telegram supports links. Private source links still require chat
membership. This is keyword retrieval, not semantic embedding search.

The default model is gpt-5.5, configurable alongside reasoning, output length,
style and emoji. Enter an OpenAI API key in Settings (or OPENAI_API_KEY in .env).
This deployment needs direct OpenAI API connectivity. It does not share the voice
module's VPN process. Requests use Responses API with store:false. This does not
promise zero provider-side retention. Daily request and digest batch caps limit
usage; one digest may use several paid model calls. Oversized digests fail clearly
instead of silently discarding messages. Incomplete imports are disclosed.

Archive messages are untrusted input, never executable instructions. Answers can
be inaccurate: verify source messages. Jobs/results are kept locally for 30 days.
Interrupted running/delivery jobs are marked failed on restart to avoid duplicate
Telegram responses; pending requests resume. Failed jobs can be repeated manually.

## Validation

`npm test` at repository root covers encrypted storage, FTS isolation and edits,
owner-only commands, replay handling, digest batching, source links, HTTP auth,
atomic configuration and global flood waits. Browser audit uses isolated fixtures
with mock Telegram/OpenAI, so it cannot confirm a real login before user setup.
