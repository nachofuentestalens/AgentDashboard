# Isolated task workspaces

Writing runs use a persistent Git worktree and branch per task. The project checkout remains the stable working folder; read-only tasks without a workspace still inspect it. Reviews and handoff runs for a task with a workspace inspect that workspace. Worktrees are stored under the dashboard data directory, outside the project. Dependencies and ignored configuration are not copied: install dependencies in the task folder as needed.

`server/src/workspaces.ts` creates and verifies worktrees and saves checkpoints. `server/src/github.ts` publishes checkpoint branches and manages draft PRs and owner-triggered squash merges. `task_workspaces` (migrations 7–8) records the repository, folder, branch, base/checkpoint/published/approved/merged commits, PR link and separate local/publication errors. SQL lives in `store.ts`. The runner registers an active run before asynchronous preparation and keeps it active until checkpointing and publication finish, preventing overlapping sends/deletion. Workspace setup failures never fall back to the project checkout. Moving an existing session to a worktree starts a fresh provider session with recent conversation context.

## Initial baseline

Tasks can declare required committed paths and prerequisite task IDs. Their queue waits until the execution checkout contains those paths and the approved prerequisite commits. Persistent worktrees are checked too; they are never silently rebased or reset. See [Task prerequisites](DEPENDENCIES.md).

A new writing task starts from the project's last commit. Existing staged, unstaged and untracked files in the project checkout are left untouched and are not copied into the task or attributed to it; the run posts a notice when there are any. Commit them first if the agent needs to see them. Ignored files are excluded. An empty Git repository gets an empty orphan task baseline without moving its primary branch or index. Existing task worktrees resume even if the primary checkout later becomes dirty. Changing a project's repository does not redirect an existing task's worktree.

## Checkpoint and resume

After a writing agent exits (success, failure, manual stop or allowance stop), the server stages the task worktree's changes and creates a WIP commit. No model call is needed. New files and deletions are included; ignored files are excluded. Unresolved conflicts and an unexpected branch stop checkpointing and produce a visible error; files remain available. A failed checkpoint prevents automatic successful-step continuation. A checkpoint does not certify that the code builds.

The task page shows the path, branch, last checkpoint and errors. **Pause & checkpoint** uses the runner stop path; **Save checkpoint** calls `POST /api/tasks/:id/checkpoint` while idle. Normal sends resume the same worktree. Existing token allowances still apply. The checkpoint does not fabricate a semantic handoff: the transcript and any agent-provided handoff remain available.

A crash or server shutdown can leave uncommitted files in the persistent worktree. Restart preserves those files; use Save checkpoint before resuming if desired. Shutdown does not wait for Git or promise a final commit. Deleted tasks/projects currently retain their physical branches/worktrees for manual recovery; automatic cleanup is intentionally absent. Worktree separation is filesystem isolation for normal operation, not a security boundary against an agent explicitly accessing another checkout.

## GitHub publication and merge

After a successful local checkpoint, the server automatically pushes its exact commit to `agent/task-<id>` if `origin` has a single github.com push URL, then creates or updates a draft PR against the repository's default branch. No force push is used. A missing remote leaves a local-only checkpoint; unsupported or changed remotes are reported. The first GitHub repository is pinned to the task. A previously ready PR returns to draft when published again. A closed/merged PR does not silently become a new PR.

Git must already be able to push noninteractively. API credentials come from `GH_TOKEN`/`GITHUB_TOKEN` in the server environment, or Git's HTTPS credential helper for github.com. Credentials stay in memory and are never persisted to the database or included in process arguments. A token supplied through the environment authenticates API calls; Git push still needs its own configured authentication. Git Credential Manager can provide both. Tokens need repository contents/pull request write access and checks/status read access. Private repositories need corresponding repository access. Interactive credential prompts are disabled.

The UI distinguishes local checkpoints, backed-up commits, PR links and publication errors. **Publish / retry GitHub** retries publication without changing the checkpoint. Push failure does not remove local files or commits; a successful push followed by an API failure still records the remotely backed-up commit. Empty unchanged tasks do not create PRs.

**Merge on GitHub** is an explicit owner action. Role tasks also require approval tied to the exact checkpoint. The server verifies the worktree is clean, the PR's head matches that checkpoint, and the target is the repository default branch. It requires successful checks/statuses (no missing, pending, skipped or failed checks), marks the PR ready and requests a squash merge pinned to that SHA. GitHub branch protections still apply. Configure required CI checks on the repository to enforce them atomically at merge time; the dashboard's check reads alone cannot prevent checks changing concurrently. More than 100 checks/statuses requires manual review/merge on GitHub.

Approval and Close do not deploy or merge by themselves. A merge leaves the running checkout unchanged. When ready to deploy, stop the dashboard, update its clean stable branch with `git pull --ff-only`, install/build as required, and restart. Each squash merge records a single commit that can be undone with `git revert <merge-commit>` and pushed through normal review. Create a new task for follow-up changes to a merged task. No worktree/branch is automatically deleted.

An existing dirty installation can still start isolated writing tasks (so the dashboard can fix itself), but they branch from the last commit. Commit changes the agent should build on; nothing is discarded or stashed automatically.

Tests in `server/test/workspaces.test.ts` cover primary checkout preservation, added/deleted/ignored files, stopped runs, restart reuse, dirty checkouts starting from the last commit, review isolation and wrong-branch recovery. `server/test/github.test.ts` uses a simulated GitHub API to cover exact-commit pushes, publication retry/failure, remote pinning, merge checks and externally merged PRs without network side effects. The chat e2e covers workspace status and Pause & checkpoint.
