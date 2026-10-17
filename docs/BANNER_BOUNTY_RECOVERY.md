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
6. From then on: agents work, the reviewer runs automatically, and each finished task appears in the panel with **Preview integration**. Approving that preview approves the task and advances the baseline. Before a successor's next run, its persistent worktree fast-forwards onto the new baseline keeping WIP (M1-04/M1-05/M1-06 included); a conflict leaves it queued with the reason and both checkouts untouched for the owner to resolve. M1-06 waits for M1-02, M1-04 and M1-05; M1-07 for M1-01 and M1-05; the graph governs the rest.

Not done by the dashboard: M1-05's existing scaffolding is not certified; review it when it reaches `needs_review`. The legacy helper's status/receipt logic is not authoritative for native stages; stop using its completion path. The game folder's own `main` branch does not move; commit or merge the baseline there yourself when you want it (`refs/agent-dashboard/previews/` holds every approved commit).
