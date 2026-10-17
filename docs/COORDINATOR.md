# Project coordinator

The coordinator is a dashboard-wide tab (`/coordinator`). It watches each provider's subscription limits (Claude and ChatGPT/Codex), and it directs agent work so the owner always has usage left for their own small tasks.

It is deterministic, not an agent. A model deciding about tokens would spend tokens, and a rule set can be tested as a table, like the scheduler.

## Pieces

- `server/src/coordinator.ts`: the pure rules. Usage estimates (`estimateWindow`), levels (`windowLevel`, `providerLevel`), scheduler holds (`providerHolds`) and decisions (`decide`). Change rules here and in `server/test/coordinator.test.ts`.
- `server/src/coordination.ts`: the `Coordinator` service. It builds the snapshot from the store and the runner, applies decisions, stores readings and the policy as JSON under `coordinator.*` keys in the `settings` table (no migration), and registers `/api/coordinator*`.
- `runner.ts`: calls `beforeSchedule()` on every scheduling pass and passes the returned holds to `scheduler.ts`. It forwards `rate_limit` events and limit failures to `observe()`. A coordinator error is logged, and the queue then runs as if the coordinator were off.
- `web/src/pages/CoordinatorPage.tsx`: provider cards, decisions, paused tasks, policy and activity.

## Usage data

Each provider has two windows: **session** (the rolling 5-hour limit) and **weekly**. In order of trust:

1. **Claude usage API.** `server/src/usage.ts` reads `https://api.anthropic.com/api/oauth/usage` (what Claude Code's `/usage` shows) with the CLI's own sign-in from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`): `five_hour` → session, `seven_day` → weekly, `utilization` already a percentage, `resets_at` ISO. It runs at startup, every 5 minutes, after each run (at most every 30 s) and from the card's Refresh button; the card shows the last read or why it failed. The token is never refreshed here (that would rotate the CLI's refresh token); an expired one waits for the next Claude run. Demo mode, e2e and tests do not read it (`AppOptions.usage`).
   **Codex session files.** `codex exec --json` does not print its limits, but every Codex session (the dashboard's and the owner's own) writes `token_count` events with `rate_limits` (`primary` → session, `secondary` → weekly, `used_percent`, `resets_at` Unix seconds or older `resets_in_seconds`) to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. `readCodexUsage` takes the latest `limit_id: "codex"` entry from the newest rollouts, on the same schedule as the Claude API. A reading newer than that entry (an owner's) is kept.
2. **CLI reports.** Claude Code's `rate_limit_event` (`five_hour` / `seven_day*`, utilization, `resetsAt`) and Codex's `rate_limits.primary/secondary` (if a version prints them) are parsed into `rate_limit` events. The field names vary between CLI versions, so every field is optional. In practice Claude Code reports only `five_hour` and its `resetsAt` until usage nears the limit; such a report for a window that already has a percentage (reset within 10 minutes) is ignored rather than replacing it.
3. **Owner readings.** On a provider card, enter the used % and reset time from the provider's usage page (Claude `/usage`, ChatGPT Codex usage). This counts use outside the dashboard, which no other source sees. Without a reset time, the reading lasts a full window from when you enter it (the plan's weekly reset for the week).
4. **Limit failures.** A run that fails with "usage limit", "rate limit" and similar text marks that window as spent for a full window.
5. **Token caps (optional).** Each provider's plan can set reported-token caps per window. Tokens the dashboard spent since the last reading are then added to it, or estimated from zero when there is no reading. The caps are owner guesses: providers do not publish them, and they weight cache tokens differently.

After a reading's reset time passes, the window counts as reset: 0%, plus the dashboard's tokens since the reset if a cap is set. A weekly window keeps the provider's cadence; otherwise the plan's weekly reset day and hour apply.

## Levels

With `R` = reserve and `M` = conserve band:

| Level     | When                                                                    | Effect (auto mode)                             |
| --------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| unknown   | no reading and no cap                                                   | nothing is held (the coordinator cannot know)  |
| ok        | below `100 − R − M` and on the weekly pace                              | work starts normally                           |
| conserve  | within `M` of the reserve, or the week is ahead of an even pace + burst | queued work below the "min priority" waits     |
| reserve   | at or above `100 − R`                                                   | queued work waits; running role work is paused |
| exhausted | 100%, or the provider rejected a request                                | same as reserve                                |

A provider's level is the worse of its two windows. In a session's last 30 minutes, conserving stops because what is left resets unused anyway. The reserve still applies.

Weekly pace: by a given point in the week, usage should be at most `(100 − R) × elapsed + burst`, so a busy Monday cannot use up Friday's share.

## Decisions

- **Pause**: a running role run on a provider in reserve or exhausted. Emergencies and "run anyway" runs are excluded. The run stops through the normal stop path (a checkpoint for writers) with the reason as its error.
- **Resume**: a task the coordinator paused, when its provider allows its priority again. It retries the paused run. If the owner has since sent a message or started another run, the task is no longer tracked as paused.
- **Start** (`fillIdle`): within 2 hours of a session reset, with at least 25% left above the reserve and nothing queued for that provider, it starts the top backlog task of a staffed role on that provider.
- **Switch** (`switchProvider`): queued work held on one provider moves to the other one when the other is at "ok" (never to an unknown provider). This sets the task's provider and clears its model and effort, so the role's or project's choice applies.

Plain chats are the owner's own use. The coordinator never holds or pauses them.

Modes: **off** only shows usage. **advise** lists decisions; the owner clicks Apply, and the server applies only a decision the rules still make. **auto** applies them; an automatic decision is not repeated for 5 minutes. Holds are reported as the queued run's wait reason, starting with `Coordinator:`, and "Run anyway" overrides them like a budget hold.

The activity log is in memory, holds the last 50 entries, and is cleared on restart.
