import fs from "node:fs";
import path from "node:path";
import type { WorkspaceCleanupPreview } from "@ad/shared";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { git } from "./git.ts";
import { checkedGit } from "./baseline.ts";

function contains(parent: string, child: string): boolean {
  const canonical = (p: string) => {
    const real = fs.realpathSync.native(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const relative = path.relative(canonical(parent), canonical(child));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// The runner holds its task/project locks during removal. Preview is advisory; never reuse its verdict.
export class WorkspaceCleanup {
  constructor(
    private readonly store: Store,
    private readonly workspaces: Workspaces,
  ) {}

  async preview(taskId: string, busy = false): Promise<WorkspaceCleanupPreview> {
    const task = this.store.getTask(taskId);
    const w = this.store.getWorkspace(taskId);
    const result: WorkspaceCleanupPreview = { taskId, path: w?.path ?? null, eligible: false, reasons: [], evidence: null };
    const block = (reason: string) => result.reasons.push(reason);
    if (!task || !w) {
      block("No recorded task worktree.");
      return result;
    }
    if (
      busy ||
      task.status === "running" ||
      task.status === "queued" ||
      this.store.listRuns(taskId).some((r) => r.status === "running" || r.status === "queued")
    )
      block("Task is active, queued, or has a workspace/delivery operation in progress.");
    if (task.roleId ? !["approved", "closed"].includes(task.stage ?? "") : task.status !== "done") block("Task is not completed.");
    if (task.nextStep || task.stepState === "partial") block("Task has unfinished work.");
    if (!fs.existsSync(w.path)) {
      block("Worktree folder is absent (already cleaned or missing). The branch and task records are retained.");
      return result;
    }
    try {
      const project = this.store.getProject(task.projectId)!;
      if (contains(w.path, project.repoPath) || contains(w.path, w.repoPath)) block("This is the live project checkout.");
      if (this.store.listProjects().some((p) => p.id !== task.projectId && fs.existsSync(p.repoPath) && contains(w.path, p.repoPath)))
        block("This worktree is used as another project's live checkout.");
      if (contains(w.path, process.cwd()) || contains(w.path, import.meta.dirname)) block("This worktree is executing cleanup.");
      await this.workspaces.verify(w);
      const entries = (await checkedGit(w.repoPath, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
      const entry = entries.find((record) => {
        const folder = record.split("\0")[0]?.slice("worktree ".length);
        return folder && fs.existsSync(folder) && contains(folder, w.path) && contains(w.path, folder);
      });
      if (!entry) block("Git does not register this worktree.");
      if (entry?.split("\0").some((field) => field === "locked" || field.startsWith("locked ")))
        block("Git worktree is locked; resolve the lock before cleanup.");
      if (await checkedGit(w.path, ["ls-files", "--unmerged"])) block("Worktree has unresolved conflicts.");
      if ((await checkedGit(w.path, ["ls-files", "-v", "-z"])).split("\0").some((file) => /^[a-zS] /.test(file)))
        block("Index flags hide tracked-file changes (assume-unchanged or skip-worktree); clear them before cleanup.");
      if (await checkedGit(w.path, ["status", "--porcelain", "--untracked-files=all", "--ignored", "--ignore-submodules=none"]))
        block("Worktree contains staged, modified, untracked, or ignored files; preserve or remove them before cleanup.");
      for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
        const statePath = await checkedGit(w.path, ["rev-parse", "--path-format=absolute", "--git-path", name]);
        if (fs.existsSync(statePath)) block(`Unfinished Git operation: ${name}.`);
      }
      const head = await checkedGit(w.path, ["rev-parse", "HEAD"]);
      if (head !== w.checkpointCommit || w.error) block("HEAD is not a successfully recorded checkpoint; commits are unverified.");
      const baseline = this.store.projectBaseline(task.projectId);
      if (
        baseline &&
        baseline.repoPath === w.repoPath &&
        w.approvedCommit === head &&
        (await git(w.path, ["merge-base", "--is-ancestor", head, baseline.commit])).ok
      ) {
        result.evidence = `Approved checkpoint ${head} is an ancestor of recorded baseline ${baseline.commit}.`;
      } else {
        const verified = this.store.getStateJson<{ checkpoint: string; merge: string }>(`verified-merge.${taskId}`);
        if (verified?.checkpoint === head && verified.merge === w.mergeCommit) {
          // Reconstruct the expected squash tree, including changes already on the target branch.
          const parent = await checkedGit(w.path, ["rev-parse", `${verified.merge}^`]);
          const expected = await checkedGit(w.path, ["merge-tree", "--write-tree", parent, head]);
          const actual = await checkedGit(w.path, ["rev-parse", `${verified.merge}^{tree}`]);
          if (expected === actual) result.evidence = `Verified checkpoint ${head} matches recorded squash delivery ${verified.merge}.`;
        }
      }
      if (!result.evidence)
        block(
          "No verified Git delivery for this exact checkpoint. Approval/status alone, an external merge, or missing merge objects cannot authorize cleanup.",
        );
    } catch (error) {
      block(`Git verification failed: ${(error as Error).message}`);
    }
    result.eligible = result.reasons.length === 0;
    return result;
  }

  async remove(taskId: string): Promise<WorkspaceCleanupPreview> {
    const preview = await this.preview(taskId);
    if (!preview.eligible) throw new Error(preview.reasons.join(" "));
    const w = this.store.getWorkspace(taskId)!;
    // Keep an explicit recovery ref as well as the task branch; never delete either.
    await checkedGit(w.repoPath, ["update-ref", `refs/agentdashboard/recovery/${taskId}/${w.checkpointCommit}`, w.checkpointCommit!]);
    const fresh = await this.preview(taskId);
    if (!fresh.eligible) throw new Error(fresh.reasons.join(" "));
    await checkedGit(w.repoPath, ["worktree", "remove", "--", w.path]);
    this.store.setStateJson(`workspace-cleanup.${taskId}`, { at: new Date().toISOString(), checkpoint: w.checkpointCommit, evidence: fresh.evidence });
    return fresh;
  }
}
