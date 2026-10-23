# Telegram alerts

The server can message the owner on Telegram when agents stop making progress, so problems are
noticed away from the desk. It is off unless configured. Code: `server/src/notify.ts`.

## What is sent

Checked every minute, for every project whose automation is not paused:

- a provider out of quota (coordinator level `reserve` or `exhausted`), and a ✅ message when it can
  work again; `conserve` is normal pacing and is not reported, and moving between `reserve` and
  `exhausted` is the same wait;
- project health concerns from `server/src/health.ts`: a stalled queue (resent as the stall doubles:
  15, 30, 60 min…; not when every queued run waits on a coordinator quota hold, which the provider
  alert already explains), a task that keeps failing, a task idle in progress with nothing to move it;
- steward escalations (inbox alerts) and agents' questions waiting for the owner.

Each problem is sent once while it lasts; new problems found in one check go out as one message. A
problem that goes away is remembered for 15 minutes, so one that flaps (usage hovering at the
reserve) is not resent, and a ✅ recovery is only sent once it has stayed away that long. Inbox keys
for held and blocked runs ignore the numbers in wait reasons ("usage 96%", "resets in 37m"), so the
desktop alerts and the steward do not treat each minute's update as a new item.
What was sent is kept in `<data dir>/notified.json`, so a restart does not resend open problems. A
failed send is retried on the next check; `GET /api/notifications` shows the last error.

## Setup

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the bot token it gives.
2. Open the new bot and send it any message (bots cannot message someone first).
3. Find your chat id: open `https://api.telegram.org/bot<token>/getUpdates` and read
   `result[0].message.chat.id`.
4. Create `<data dir>/telegram.json` (on Windows `%LOCALAPPDATA%\AgentDashboard\telegram.json`):

   ```json
   { "botToken": "123456:ABC...", "chatId": "123456789" }
   ```

   or set `AGENT_DASHBOARD_TELEGRAM_BOT_TOKEN` and `AGENT_DASHBOARD_TELEGRAM_CHAT_ID`, which win over
   the file.

5. Restart the server, then `POST /api/notifications/test` to receive a test message.

The token only leaves the machine in requests to `api.telegram.org`; errors quote Telegram's reply,
never the request URL. Messages carry project and task titles, wait reasons and agents' questions.
Demo mode (`AGENT_DASHBOARD_FAKE_CLAUDE`) never sends.
