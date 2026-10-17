# Task prerequisites

Role tasks have `dependencyIds` (existing role task IDs in the same project) and `requiredPaths` (repository-relative committed inputs). Configure them in the task page's Prerequisites panel or the create/update task API. Task reply blocks can request the same fields; pending handoffs preserve them until the owner accepts. Unknown IDs, duplicates, cycles and unsafe paths are rejected. Stop queued/running work before changing prerequisites; reopen or continue accepted work before editing its prerequisites.

`store.ts` validates the graph and checks approval. Closed/dropped work does not count without a valid owner approval; reopening invalidates it. An explicitly unfinished multi-step prerequisite does not release successors. Workspace prerequisites need approval of their current checkpoint. Deleted prerequisites remain blockers rather than silently disappearing.

`readiness.ts` checks the execution checkout: prerequisite merge commits (or approved checkpoint commits for local integration) must be ancestors of its HEAD, and required paths must exist in HEAD without uncommitted changes. This also detects stale persistent task worktrees. These checks do not merge, copy files, reset worktrees, or spend agent tokens.

`runner.ts` checks queued work before assigning agents and again before launching the process. Dependency/baseline wait reasons cannot be overridden by emergency priority or Run anyway. Reviews remain available to diagnose incomplete work. Automatic idle starts and the coordinator's fill-idle selection skip tasks with unapproved prerequisites. A baseline-blocked queued task remains visible with its wait reason and resumes on a later scheduling pass after repair. Such a queued task occupies its role's automatic backlog selection until resolved or stopped; other explicitly queued ready work can still run.

Existing tasks migrate with empty prerequisites. Dependencies written only in prompts or external plans are not inferred. Import them explicitly before enabling automation. See [Banner & Bounty recovery](BANNER_BOUNTY_RECOVERY.md) for the audited project.

## Managed baseline and delivery

The project page's **Delivery & baseline** panel (`delivery.ts`, `delivery-plan.ts`, routes in `delivery-routes.ts`) gives a project a dashboard-owned baseline commit, stored in state and pinned under `refs/agent-dashboard/previews/`. The live checkout's branch, index and files are never changed.

- **Snapshot.** The owner picks uncommitted files; the server builds a commit on HEAD with a temporary index and shows its diff. Approval stores it as the baseline. Symlinks, directories and `.git` paths are refused; a moved HEAD or later edits invalidate the preview (the commit is what was reviewed, not the current files).
- **Integrate.** For a task in `needs_review` (or already approved) with a clean, current checkpoint, the server prepares `merge-tree` of the baseline and that exact checkpoint. Approving the preview approves the task and advances the baseline. Conflicts are a 409 with both checkouts untouched.
- **Refresh.** Before a queued successor starts, its persistent worktree fast-forwards to a merge of its checkpoint and the new baseline, keeping WIP. A dirty or conflicting worktree stays blocked with the reason; nothing is reset, stashed or rebased. New tasks start from the baseline instead of HEAD.
- **Plan import.** `planning/milestone.json` (`tasks[].id/role/dependsOn/inputs/deliverables/report`) and `planning/dashboard-state.json` (`tasks: { milestoneId: taskId }`) are read from the baseline commit. Inputs gain `AGENTS.md` and every prerequisite's deliverables. Closed/approved tasks whose deliverables are in the baseline return to `needs_review` (approval is cleared), others and in-progress tasks to `backlog`. Approval is refused if any task or role changed since the preview. Import pauses delivery: queued work waits, start-next is off.
- **Enable.** Turns on auto-review and start-next (auto-continue stays 0) once at least one backlog task passes its dependency and baseline checks, or every planned task is approved.

The resulting loop: work → automatic review → owner approves the integration preview → baseline advances → eligible successors refresh and start. Plain task approval (without integrating) still satisfies the dependency graph, but successors then wait on `readiness.ts` until the outputs reach the baseline.
