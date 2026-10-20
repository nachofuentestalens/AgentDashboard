import type { Run, Task } from "@ad/shared";
import { git } from "./git.ts";
import type { Store } from "./store.ts";

// Waiting for prerequisites reserves no execution capacity. Recheck saved dependencies rather
// than the last wait reason, which may be stale after an approval. Reviews remain independent.
export function dependencyBlockedQueue(store: Store, run: Run): boolean {
  if (run.status !== "queued" || run.purpose !== "work") return false;
  const task = store.getTask(run.taskId);
  return !!task && !!store.dependencyBlocker(task);
}

// Check the actual execution checkout, including persistent worktrees that may be stale.
// Approval alone cannot make another branch's files visible here.
export async function baselineBlocker(store: Store, task: Task, repoPath: string, revision = "HEAD"): Promise<string | null> {
  const dependency = store.dependencyBlocker(task);
  if (dependency) return dependency;
  for (const id of task.dependencyIds) {
    const workspace = store.getWorkspace(id);
    if (!workspace) continue;
    const commits = [workspace.approvedCommit, workspace.mergeCommit].filter((c): c is string => !!c);
    let present = false;
    for (const commit of commits)
      if ((await git(repoPath, ["merge-base", "--is-ancestor", commit, revision])).ok) {
        present = true;
        break;
      }
    if (!present) return `Baseline: integrate the approved changes from ${store.getTask(id)?.title ?? id} into this task's baseline before starting.`;
  }
  for (const file of task.requiredPaths) {
    if (!(await git(repoPath, ["cat-file", "-e", `${revision}:${file}`])).ok)
      return `Baseline: required input ${file} is missing from this checkout's commit. Commit/integrate the input before starting.`;
    if (revision !== "HEAD") continue;
    const changes = await git(repoPath, ["--literal-pathspecs", "status", "--porcelain", "--", file]);
    if (!changes.ok || changes.stdout)
      return `Baseline: required input ${file} has uncommitted changes in this checkout. Review and commit them before starting.`;
  }
  return null;
}
