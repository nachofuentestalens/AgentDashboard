# Task prerequisites

Role tasks have `dependencyIds` (existing role task IDs in the same project) and `requiredPaths` (repository-relative committed inputs). Configure them in the task page's Prerequisites panel or the create/update task API. Task reply blocks can request the same fields; pending handoffs preserve them until the owner accepts. Unknown IDs, duplicates, cycles and unsafe paths are rejected. Stop queued/running work before changing prerequisites; reopen or continue accepted work before editing its prerequisites.

`store.ts` validates the graph and checks approval. Closed/dropped work does not count without a valid owner approval; reopening invalidates it. An explicitly unfinished multi-step prerequisite does not release successors. Workspace prerequisites need approval of their current checkpoint. Deleted prerequisites remain blockers rather than silently disappearing.

`readiness.ts` checks the execution checkout: prerequisite merge commits (or approved checkpoint commits for local integration) must be ancestors of its HEAD, and required paths must exist in HEAD without uncommitted changes. This also detects stale persistent task worktrees. These checks do not merge, copy files, reset worktrees, or spend agent tokens.

`runner.ts` checks queued work before assigning agents and again before launching the process. Dependency/baseline wait reasons cannot be overridden by emergency priority or Run anyway. Reviews remain available to diagnose incomplete work. Automatic idle starts and the coordinator's fill-idle selection skip tasks with unapproved prerequisites. A baseline-blocked queued task remains visible with its wait reason and resumes on a later scheduling pass after repair. Such a queued task occupies its role's automatic backlog selection until resolved or stopped; other explicitly queued ready work can still run.

Enable project `startNextWhenIdle` and `autoReview` only after the baseline and dependency graph are ready. Agents can work and review automatically; the owner still approves. Approval does not integrate changes. For GitHub tasks, merge and update the stable checkout using the existing documented owner workflow. Local integration and reconciliation of old worktrees remain manual. There is no automatic baseline repair or dependency branch merging in this phase.

Existing tasks migrate with empty prerequisites. Dependencies written only in prompts or external plans are not inferred. Import them explicitly before enabling automation. See [Banner & Bounty recovery](BANNER_BOUNTY_RECOVERY.md) for the audited project.
