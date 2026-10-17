# Banner & Bounty recovery audit â€” 2026-10-17

The dependency plan exists, but the dashboard did not enforce it. `D:/Personal/B&B/planning/milestone.json` defines 16 tasks and 25 dependency edges. Its helper explicitly warns that direct dashboard messages bypass dependency checks. The native scheduler and coordinator only considered priority, staffing, budgets and capacity.

The committed baseline is also incomplete. At audit time project HEAD was `6204f71` (a decision-log commit). Git reported `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `design/game/`, `design/qa/`, `design/studio/`, `planning/` and `scripts/` as untracked. Consequently the isolated tasks cannot see the plan, contracts or combat/content specifications despite those files appearing in the main folder. File existence there is not evidence of inclusion in a task baseline.

M1-01 and M1-02 are marked closed with legacy `status=done`. Reports exist locally, but native owner acceptance must be reconciled; the helper records a review receipt only for M1-01. This audit did not certify the gameplay specifications. M1-04 and M1-06 explicitly stopped because their inputs were absent. M1-05 has a separate checkpoint; its implementation has not been reviewed in this audit.

| Task  | Persistent worktree suffix             | Base       | Checkpoint |
| ----- | -------------------------------------- | ---------- | ---------- |
| M1-04 | `d1bf98bc-6c22-42a0-97f3-ca703d374882` | `f485c754` | `f485c754` |
| M1-05 | `a786bb07-0994-41e0-b185-5e87b55ee4c3` | `af1bdaba` | `9acc8e80` |
| M1-06 | `ab16ab28-0f07-4192-990a-3f8224ed117a` | `9cb07b5a` | `8065a94d` |

These worktrees live under the dashboard data directory. None has an approved checkpoint. Preserve their WIP; simply committing the main folder will not refresh existing worktrees.

All three native project automation controls were off: auto-review, auto-continue and start-next-when-idle. No live settings, task records, files or branches were changed by this audit. All deliverables are in the assigned AgentDashboard worktree.

## Recovery sequence (owner, in the Delivery & baseline panel)

Each step is a preview the owner reviews before anything changes; see [Managed baseline and delivery](DEPENDENCIES.md#managed-baseline-and-delivery). The game folder's branch, index and files stay as they are.

1. Deploy this dashboard build. Keep coordinator fill-idle off and stop any queued Banner & Bounty work: plan import refuses queued, running or in-review tasks.
2. **Baseline snapshot.** Tick the files the agents need: `AGENTS.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `planning/milestone.json`, `planning/dashboard-state.json`, the `design/` contracts/specs and `scripts/`, plus the M1-01/M1-02 deliverables you consider done. Leave out secrets, generated output and unrelated work. Read the diff, then approve. Previews over 500 KB are refused; split the selection if needed (the first snapshot is the only one; later files arrive through task integration).
3. **Milestone import.** Preview it. Expected: M1-01/M1-02 `closed → needs_review` if their deliverables are in the snapshot (otherwise `→ backlog`, with the missing outputs listed); M1-04/M1-05/M1-06 → `backlog` with their worktrees and WIP untouched; the rest stay in `backlog`. All 25 edges, `AGENTS.md`, listed inputs and prerequisite deliverables become task prerequisites. Approving pauses delivery. [banner-bounty-prerequisites.json](banner-bounty-prerequisites.json) remains a manual PATCH fallback with the same mapping.
4. **Review recovered work.** Read M1-01/M1-02 evidence on their task pages and approve them (legacy closure and helper receipts are not approval). These tasks have no worktree, so approval alone releases successors once their outputs are in the baseline.
5. **Enable reviewed delivery automation.** It checks that some backlog task (M1-03, M1-04, M1-05 after step 4) has its prerequisites approved and its inputs in the baseline, then turns on auto-review and start-next with auto-continue at 0.
6. Optional: turn on **Hands-off delivery** in Project settings → Task automation. A passed agent review then approves and integrates the task by itself and the next backlog task starts; review findings go back to the author up to 3 times. Do not ask a task in `needs_review` "is it submitted?": that message is a new step. Look at the stage instead.
7. Without hands-off delivery: agents work, the reviewer runs automatically, and each finished task appears in the panel with **Preview integration**. Approving that preview approves the task and advances the baseline. Before a successor's next run, its persistent worktree fast-forwards onto the new baseline keeping WIP (M1-04/M1-05/M1-06 included); a conflict leaves it queued with the reason and both checkouts untouched for the owner to resolve. M1-06 waits for M1-02, M1-04 and M1-05; M1-07 for M1-01 and M1-05; the graph governs the rest.

## Live status: 2026-10-17 evening

Steps 1 to 6 are applied. The baseline is `0ffc4e28`, the plan is imported, and M1-01 through M1-04 are approved (M1-03 and M1-04 are integrated). Auto-review, start-next and hands-off delivery are on. Every role now has a reviewer from another discipline. Before that, each role reviewed its own work. The mapping is CTO ↔ Game Director; programmers, Tools Engineer and QA → CTO; Systems and Narrative designers → Game Director; Economy Designer → Systems Designer. M1-05's pass came from its own role, so it was sent for a fresh CTO review before hands-off delivery could integrate it. M1-09 is in `changes_requested`, with findings on the arena draw state and unverified inputs. Its token allowance was raised to 2M (1.35M had been used) and the findings were sent back to its author. M1-05 passed the CTO review and was approved; M1-06 is now running. Tasks default to a 1M token allowance, so long tasks may stop at that checkpoint.

The legacy helper's status/receipt logic is not authoritative for native stages; stop using its completion path. The game folder's own `main` branch does not move; commit or merge the baseline there yourself when you want it (`refs/agent-dashboard/previews/` holds every approved commit).

## Follow-up audit: 2026-10-17, approximately 19:03 UTC

Read-only checks against the running dashboard at `http://127.0.0.1:5190` found no queued or running Banner & Bounty tasks. M1-01 through M1-05 are approved; M1-06/M1-07 are idle in progress; M1-09 is idle awaiting review; the remaining eight milestone tasks are in backlog. Delivery is not paused, the plan is imported, and the managed baseline is `d648e86b25a9996e37e13d7bd856806dd3f74b84`.

Auto-review, start-next and hands-off approval are already enabled. Automatic continuation of reviewed intermediate steps is set to zero. These settings do not bypass task usage checkpoints or restart previously stopped work.

| Task  | Current blocker                                                                                                                                              | Recovery action                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| M1-06 | Stopped at 80 cumulative tool calls, including its previous attempt. WIP checkpoint `5b380305`.                                                              | Raise or clear task allowances, then retry latest stopped run `33945f93-8bc9-4afb-ba15-89804299fab9`.                     |
| M1-07 | Stopped at 80 tool calls. WIP checkpoint `068cd9c6`.                                                                                                         | Raise or clear task allowances, then retry latest stopped run `04ad9cf7-26f0-4cc6-8f8d-7a9bbaca0c74`.                     |
| M1-09 | Corrections completed, but automatic review failed at 2,285,913 tokens against a 2M cap. Both allowances are now null; clearing them did not restart review. | Request a new review through the task actions endpoint. Do not retry its successful author run or approve without review. |

Unfinished backlog tasks still have the default 1M-token/80-tool allowances, so they can stop in the same way. For owner-authorized unattended milestone delivery, clear both allowances on unfinished milestone role tasks only (`PATCH /api/tasks/:id`, body `{"tokenBudget":null,"toolBudget":null}`). Do not change plain chats, accepted tasks, or global defaults. Re-read live task/run state before applying recovery; these IDs describe this audit, not an unconditional replay script.

Retry uses `POST /api/runs/:id/retry` with `{}`. Review uses `POST /api/tasks/5551eb95-466e-4218-b4f6-85d4f2775430/actions` with `{"action":"review"}`. Dependencies and current-checkpoint review/integration checks remain in force. Review fixes stop after three rounds; conflicts, agent questions and failures can still require intervention. If intermediate reviewed steps should continue automatically, configure the project's `autoContinueSteps` explicitly (supported range 0–20).

The coordinator is currently in **advise** mode, not automatic mode. Claude session use was 89%, above its configured 20% reserve, with reset at approximately **2026-10-18 01:40 Asia/Dubai**. This is an advisory recommendation, not proof that the scheduler is holding work. Automatic provider pause/resume would require a dashboard-wide coordinator mode change, affecting other projects as well; preserve the reserve percentages and make that wider scope explicit.

No live settings, tasks, branches or game files were modified in this follow-up audit. The task's worktree-only constraint requires separate authorization before live recovery. Verify queued/running status and any wait reasons after recovery; merely enabling automation flags does not establish that work has resumed.

## Authorized recovery: 2026-10-17, approximately 19:13 UTC

The owner authorized live recovery and requested full-access dashboard chats with no task allowances. Through the live API, cleared token/tool allowances on 27 capped idle tasks across both projects and set both defaults to unlimited. Only the active AgentDashboard recovery chat could not be updated: the current API rejects usage-control edits during a run. Migration 11 in this worktree clears remaining legacy allowances when deployed; it does not reset usage history.

Banner & Bounty now has auto-review, hands-off approval/integration, start-next, and up to 20 reviewed step continuations enabled. M1-06 and M1-07 were retried; M1-09 was queued for a new review. All three were verified queued with no task allowances and a coordinator wait reason for Claude's session reserve. They are not currently executing. Existing checkpoints and task dependencies were preserved.

The coordinator was changed from advise to auto, keeping its 20% session reserve, 15% weekly reserve and existing provider choices. Pause/resume is enabled. This is dashboard-wide. Claude's recorded reset is around 01:40 Dubai time on October 18; queued work becomes eligible when refreshed usage permits it, subject to capacity and dependencies. No manual restart is needed for this usage hold. Review failures after three repair rounds, merge conflicts, explicit questions or unrelated process failures can still need intervention.

Editable owner chats will launch with full provider permissions after this worktree's code is deployed. Studio department boundaries and read-only reviews remain enforced. This task did not deploy code, change the live checkout, or move any branches.
