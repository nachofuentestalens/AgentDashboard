# Project coordinator

The coordinator is a dashboard-wide tab (`/coordinator`). It watches each provider's subscription limits (Claude and ChatGPT/Codex), and it directs agent work so the owner always has usage left for their own small tasks.

It is deterministic, not an agent. A model deciding about tokens would spend tokens, and a rule set can be tested as a table, like the scheduler.

Dependency readiness is enforced by the runner, separately from usage policy. Fill-idle skips unapproved prerequisites; queued work also waits for committed inputs and integrated prerequisite commits. Neither automatic mode nor Run anyway bypasses those checks. See [Task prerequisites](DEPENDENCIES.md).

## Pieces

- `server/src/coordinator.ts`: the pure rules. Usage estimates (`estimateWindow`), levels (`windowLevel`, `providerLevel`), scheduler holds (`providerHolds`) and decisions (`decide`). Change rules here and in `server/test/coordinator.test.ts`.
- `server/src/coordination.ts`: the `Coordinator` service. It builds the snapshot from the store and the runner, applies decisions, stores readings and the policy as JSON under `coordinator.*` keys in the `settings` table (no migration), and registers `/api/coordinator*`.
- `runner.ts`: calls `beforeSchedule()` on every scheduling pass and passes the returned holds to `scheduler.ts`. It forwards `rate_limit` events and limit failures to `observe()`. A coordinator error is logged, and the queue then runs as if the coordinator were off.
- `web/src/pages/CoordinatorPage.tsx`: provider cards, decisions, paused tasks, policy and activity.
- `web/src/components/SessionUsage.tsx`: shared sidebar summary of Claude/Codex session remaining percentages on every route, with reset countdown and local time on hover or keyboard focus. Uses the coordinator query and live invalidations, refreshing every 30 seconds; weekly limits remain on the coordinator page.

## Usage data

Each provider has two windows: **session** (the rolling 5-hour limit) and **weekly**. In order of trust:

1. **Claude usage API.** `server/src/usage.ts` reads `https://api.anthropic.com/api/oauth/usage` (what Claude Code's `/usage` shows) with the CLI's own sign-in from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`): `five_hour` → session, `seven_day` → weekly, `utilization` already a percentage, `resets_at` ISO. It runs at startup, every 5 minutes, after each run (at most every 30 s) and from the card's Refresh button; the card shows the last read or why it failed. The token is never refreshed here (that would rotate the CLI's refresh token); an expired one waits for the next Claude run. Demo mode, e2e and tests do not read it (`AppOptions.usage`).
   **Codex usage API, then session files.** `codexUsage` first calls `https://chatgpt.com/backend-api/wham/usage` (what Codex `/status` reads) with the CLI's ChatGPT sign-in from `$CODEX_HOME/auth.json`, never refreshing it; `rate_limit.primary_window` / `secondary_window` are mapped by `limit_window_seconds`. Without it, rollouts only change when a Codex session runs, so a held Codex would keep stale numbers past a reset (including an early one by OpenAI). If the request fails (API-key sign-in, expired token, offline) it falls back to the session files: `codex exec --json` does not print its limits, but every Codex session (the dashboard's and the owner's own) writes `token_count` events with `rate_limits` (`primary` → session, `secondary` → weekly, `used_percent`, `resets_at` Unix seconds or older `resets_in_seconds`) to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. `readCodexUsage` takes the latest `limit_id: "codex"` entry from the newest rollouts, on the same schedule as the Claude API. A reading newer than that entry (an owner's) is kept.
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
- **Start** (`fillIdle`): with at least 25% session usage left above the reserve and nothing queued for that provider, it starts eligible backlog work. It does not wait for a reset timestamp or the last two hours of a window. Providers must be at "ok", including the weekly usage policy, except automatic project work at or above `conservePriority` may also use a conserving provider.
- **Automatic project assignment** (`startNextWhenIdle`): before checking provider slots, automatic starts and partial-step continuations choose across the registered providers with known usable compute and free slots. This is part of the project's automation setting, independent of coordinator mode and `fillIdle`; coordinator pause/hold decisions still obey their mode. Conserving destinations are eligible only when the task meets `conservePriority`, matching the scheduler hold; reserve, exhausted and unknown destinations are excluded. Without a suitable alternative the existing provider and normal scheduler checks apply. In coordinator auto mode, queued automatic work also uses this ranking without requiring `fillIdle`.
- **Capacity ranking**: available compute is the smaller known session/weekly percentage remaining above the owner's reserves. Ordinary work divides this by one plus running and queued load (including owner chats). Large work (resolved high/xhigh/max effort) prioritizes raw remaining capacity. Within ten percentage points of the best score, a limiting quota window resetting at least one hour earlier wins; missing reset times give no reset preference. Otherwise higher capacity wins, then lower load, then the existing provider. This is a quota-percentage heuristic, not an estimate of equivalent tokens across subscriptions. Effort is the existing task/role/project size signal; task prose is not classified by a new agent. Planned assignments count toward subsequent choices. Manual projects, forced runs, emergencies and reviews are not automatically reassigned.
- **Switch held work** (`switchProvider`): queued work held on one provider moves to the other one when the other is at "ok" (never to an unknown provider).

Assignment sets the task's provider, clears its provider-specific model, and preserves resolved effort (mapped to the destination's supported range) so subsequent passes retain the task's size signal. Each work run then uses the existing review-first model routing: the agent assesses complexity before tools or implementation and may switch to a validated model from that provider's discovered catalog with a compact handoff. This supports complex work on Astra and simpler work on Sol or another suitable model without hardcoding model prices or treating catalog order as a price ranking. Quota availability is known per provider, not independently for every model. Model switches remain capped at three per owner message.

Provider assignment does not bypass scheduler slots, role staffing, budgets, dependency readiness, or managed-baseline integration. For example, a task waiting for approved contract changes to reach its baseline still waits even when Codex has room.

Queued work waiting for prerequisite approval or checkpoint readiness does not reserve provider capacity, role staffing, or department writer slots during automatic starts. The coordinator excludes those runs from its queued load, provider assignment and fill-idle decisions, so it can find ready work instead. The runs remain visible in the compute queue with their dependency wait reasons; current dependency state is checked again each pass, including after approval. Reviews and running work still count normally. Subscription usage readings are unchanged.

Plain chats are the owner's own use. The coordinator never holds or pauses them.

Modes: **off** only shows usage. **advise** lists decisions; the owner clicks Apply, and the server applies only a decision the rules still make. **auto** applies them; an automatic decision is not repeated for 5 minutes. Holds are reported as the queued run's wait reason, starting with `Coordinator:`, and "Run anyway" overrides them like a budget hold.

The activity log is in memory, holds the last 50 entries, and is cleared on restart.

## Manual model holds

The shared sidebar has **Model controls** under each provider. Select a model and click **Pause model** to stop its running dashboard work through the normal checkpoint path and hold future launches, including chats, reviews, retries and model-switch continuations. Other models remain available. These holds apply in every coordinator mode and cannot be bypassed with Run anyway or emergency priority.

**Resume model** releases queued work and retries the latest stopped attempt for each task paused by that control. Newer owner activity supersedes an old paused attempt. Existing budget, staffing and workflow checks still apply. A run still checkpointing finishes stopping before its retry starts.

Holds and paused run IDs persist in the settings table as `models.holds` and `models.pausedRuns`. The runner enforces holds at scheduling and launch; `/api/model-holds` exposes GET and validated PUT. The sidebar polls shared hold state every five seconds. Holds match provider and configured model ID exactly; CLI default is a separate selection because its actual model is resolved outside the dashboard. External personal CLI use is unaffected.
