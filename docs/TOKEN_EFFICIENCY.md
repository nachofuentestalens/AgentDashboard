# Token-efficiency audit — 2026-10-15

## Findings and changes

- The interrupted implementation changed model presets from an array to a provider map without updating the UI. Type checking failed in five UI files. Provider controls are now wired through settings, projects, roles, new prompts and existing chats.
- New projects defaulted to Opus; the studio template selected Opus and high/xhigh reasoning for several roles. New defaults now use Sonnet and medium (or low) effort. This reduces the default resource demand, but actual token savings depend on the task. Existing saved configurations are preserved.
- Role prompts injected up to 30,000 characters of design documents on a new session. This is now 8,000, with an explicit truncation notice and files available on demand.
- Every role follow-up repeated the entire team/document catalog. A per-task fingerprint now omits unchanged catalogs and refreshes changed ones. Catalog text is capped at 8,000 characters. The fingerprint is in memory, so a server restart resends the catalog once.
- Provider changes copied up to 20,000 characters of prior messages. Handoffs now carry at most 8,000 characters of recent message text plus a truncation notice. Full history remains in the dashboard. Normal follow-ups reuse the CLI session.
- Codex runs previously looked like $0 despite reporting no dollar cost. Individual run displays now say “Cost not reported”. Aggregated dollar figures still only represent reported amounts.
- Windows Stop used taskkill without handling errors or hangs. It now has a 3-second timeout and falls back to killing the direct agent process. If Windows blocks tree termination, descendants may survive; the fallback is not a guarantee that every child stops.

## What could explain the original development-session limit

The pasted commands show compilation and fake-agent tests, not real model calls. The fake Claude/Codex scripts generate events locally and use no inference tokens. The repository includes substantial new studio/scheduler/inbox/document work beyond a basic dashboard; generating and revising that code, rereading files, tool output, reasoning and a long conversation can all contribute to a development session's usage.

No Claude session usage log was supplied, so the exact cause or savings cannot be measured from this repository. The repository's CLAUDE.md is modest in size, with no obvious instruction loop. A one-time full validation is appropriate; repeatedly running broad suites after trivial changes is avoidable overhead. Shell pipes such as head/tail reduce output shown to the model, not the tokens already spent reasoning or implementing changes.

## Remaining limits

### Implemented execution controls

Task sessions can now be replaced using a reviewed handoff (up to 6,000 characters), without deleting the conversation. Handoff preparation is a read-only run using the current provider, and its usage is counted. Generated handoffs require goal, constraints, files, completed, verification and remaining fields. Automatic use is opt-in and requires a handoff from the latest successful run. It never chains runs automatically. Manual summaries remain available when the allowance is exhausted.

New tasks are unlimited by default (tasks migrated before this default keep the 1,000,000 reported tokens and 80 tool calls they received). Settings changes the allowances new tasks start with (empty means unlimited); existing tasks keep their own. Counts include delegated descendants and survive retries and session replacement. Old tool counts are imported once from saved run events at startup. Missing logs cannot be reconstructed; missing token reports remain unknown. Existing tasks already over an allowance need the owner to raise it before continuing.

Token checkpoints are evaluated after final provider usage arrives, not continuously. Tool checkpoints stop after observed active tools report completion; they may interrupt subsequent validation and cannot guarantee every subprocess is finished. Agents are instructed to leave room for checks and a handoff before reaching the checkpoint. Concurrent delegated work can overshoot. Neither mechanism is an exact billing cap.

Role document bodies are no longer injected. The agent gets catalog/reference paths and reads relevant files as needed. New studio templates ask before delegating; default studio concurrency is one. Existing user choices are preserved. Run displays separate all token categories; task controls expose aggregate usage and current session age.

- There is no universal hard token ceiling. A CLI can perform many model/tool turns within one dashboard run, and resumed conversations still have context costs.
- Auto departments may start delegated tasks. Use Ask autonomy when token conservation matters more than automatic delegation. Delegation depth is capped, but breadth can still create multiple runs.
- Dollar budgets are estimates for queued studio tasks, not enforced billing limits; plain chats bypass the scheduler and active runs are not cut off at the budget.
- Codex token usage is available, but dollar costs are not. Do not use the dollar budget as a cap on ChatGPT subscription usage.
- Model availability and accepted reasoning levels depend on the installed CLI/account/model. The existing preset list is not an availability guarantee. Codex can use the default configured in its CLI; project settings accept custom model IDs.
- Switching providers transfers recent messages, not tool traces or the original provider's hidden state. Start a focused new task with a short requirements summary when earlier context is essential.

## Validation

Automated tests use fake agents. Coverage includes switching both ways, new/resumed sessions, bounded handoffs, bounded document injection, CLI argument construction and browser provider controls. No paid model calls are needed for these checks. A live authenticated Claude/Codex run is not part of this audit.
