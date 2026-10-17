# Banner & Bounty recovery audit — 2026-10-17

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

## Recovery sequence for a separately authorized live operation

1. Deploy the dashboard safeguards through the owner's normal review/release flow. Keep project auto-start off and coordinator fill-idle disabled during repair. Recheck active work and current records; this audit is a snapshot.
2. Review the game folder's untracked files and M1-01/M1-02 evidence, then create an explicit baseline commit containing the intended planning/specification files. Do not bulk-stage secrets, generated output or unrelated work. Record the exact baseline SHA and verify the manifest inputs exist in its tree.
3. Inspect and checkpoint M1-04/M1-05/M1-06 WIP. Reconcile each persistent branch with that baseline, preserving task changes and resolving conflicts explicitly. Do not reset or delete these worktrees. Verify their assigned branches and input paths afterward. Review M1-05's work independently before treating scaffolding as accepted.
4. Import the reviewed PATCH requests in [banner-bounty-prerequisites.json](banner-bounty-prerequisites.json). It maps all 16 existing task IDs to the registry's 25 edges and requires AGENTS.md, listed inputs and prerequisite deliverables. It creates no duplicate tasks and executes nothing itself. Closed/approved tasks must be reopened/continued before changing prerequisites, then their evidence reviewed and approved again. Do not treat legacy closure or a helper receipt as current native approval automatically.
5. Return paused M1-04/M1-06 to backlog when their WIP is reconciled. Preserve M1-05's actual progress and review its outputs. Reconcile the helper's status/receipt behavior with native task stages before using it again; its old completion logic is not authoritative for the new scheduler.
6. With M1-01 and M1-02 genuinely approved and their outputs committed and present, M1-03 and M1-04 are eligible; M1-05 is eligible subject to its existing WIP review. M1-06 must wait for M1-02, M1-04 and M1-05. M1-07 waits for M1-01 and M1-05. Let the graph govern later work rather than priority alone.
7. Enable auto-review and start-next-when-idle, initially leaving auto-continue at zero. The resulting loop is work → automatic review → owner approval → integrate approved outputs → eligible successor. Baseline integration still needs an owner operation; this phase does not implement a one-click local integration/refresh process.

The next product phase is an explicit owner-approved integration operation that prepares a concrete diff, preserves WIP, handles conflicts and refreshes successor baselines before releasing work. Until that exists, claiming an approval-only delivery pipeline would be misleading.
