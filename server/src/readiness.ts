import type { Task } from "@ad/shared";
import { git } from "./git.ts";
import type { Store } from "./store.ts";

// Check the actual execution checkout, including persistent worktrees that may be stale.
// Approval alone cannot make another branch's files visible here.
export async function baselineBlocker(store: Store, task: Task, repoPath: string): Promise<string | null> {
  const dependency = store.dependencyBlocker(task);
  if (dependency) return dependency;
  for (const id of task.dependencyIds) {
    const workspace = store.getWorkspace(id);
    if (!workspace) continue;
    const commit = workspace.mergeCommit ?? workspace.approvedCommit;
    if (!commit || !(await git(repoPath, ["merge-base", "--is-ancestor", commit, "HEAD"])).ok)
      return `Baseline: integrate the approved changes from ${store.getTask(id)?.title ?? id} into this task's baseline before starting.`;
  }
  for (const file of task.requiredPaths) {
    if (!(await git(repoPath, ["cat-file", "-e", `HEAD:${file}`])).ok)
      return `Baseline: required input ${file} is missing from this checkout's commit. Commit/integrate the input before starting.`;
    const changes = await git(repoPath, ["status", "--porcelain", "--", file]);
    if (!changes.ok || changes.stdout)
      return `Baseline: required input ${file} has uncommitted changes in this checkout. Review and commit them before starting.`;
  }
  return null;
}
