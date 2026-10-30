import fs from "node:fs";
import path from "node:path";
import type { TaskWorkspace } from "@ad/shared";
import { COMMIT_ID, git } from "./git.ts";
import type { Store } from "./store.ts";
import { mergeCommit } from "./baseline.ts";
import type { CommitSummary } from "./commit-summary.ts";

const identity = ["-c", "user.name=AgentDashboard", "-c", "user.email=agentdashboard@localhost"];

async function checked(repo: string, args: string[], input?: string): Promise<string> {
  const result = await git(repo, args, input);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `Git ${args[0]} failed.`);
  return result.stdout;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = fs.realpathSync.native(path.resolve(p));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

// Only the server creates workspaces and checkpoints. No agent tokens are needed to save work.
export class Workspaces {
  constructor(
    private readonly store: Store,
    private readonly root: string,
    private readonly available = () => true,
  ) {}

  async verify(w: TaskWorkspace): Promise<void> {
    const top = await checked(w.path, ["rev-parse", "--show-toplevel"]);
    if (!samePath(top, w.path) || samePath(top, w.repoPath)) throw new Error("The task worktree no longer points at its isolated folder.");
    const common = await checked(w.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const expected = await checked(w.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!samePath(common, expected)) throw new Error("The task worktree belongs to a different repository.");
    const branch = await checked(w.path, ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== w.branch) throw new Error(`The task worktree must remain on ${w.branch}; found ${branch}.`);
  }

  async ensure(taskId: string, repoPath: string, notice: (text: string) => void = () => {}): Promise<TaskWorkspace> {
    const task = this.store.getTask(taskId)!;
    const baseline = this.store.projectBaseline(task.projectId);
    if (baseline && !samePath(baseline.repoPath, repoPath)) throw new Error("The approved baseline belongs to a different repository.");
    let workspace = this.store.getWorkspace(taskId);
    if (workspace && !samePath(workspace.repoPath, repoPath))
      throw new Error("This task belongs to its original repository. Create a new task for the new project path.");
    if (!workspace) {
      // Uncommitted edits are not attributed to the task: it starts from the last commit, and the
      // live checkout is never touched, so they are safe. Refusing here would stop the dashboard fixing itself.
      const dirty = await checked(repoPath, ["status", "--porcelain"]);
      if (dirty && !baseline)
        notice(
          "The project folder has uncommitted changes. This task starts from the last commit, so the agent will not see them; they stay untouched in the project folder.",
        );
      const head = await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
      let baseCommit: string;
      if (baseline) {
        await checked(repoPath, ["cat-file", "-e", `${baseline.commit}^{commit}`]);
        baseCommit = baseline.commit;
      } else if (head.ok && COMMIT_ID.test(head.stdout)) baseCommit = head.stdout;
      else {
        const branch = await checked(repoPath, ["symbolic-ref", "HEAD"]);
        const existing = await git(repoPath, ["show-ref", "--verify", branch]);
        if (existing.ok) throw new Error("Cannot resolve the project's current commit.");
        // An empty project gets an orphan baseline without changing its main branch or index.
        const tree = await checked(repoPath, ["hash-object", "-t", "tree", "-w", "--stdin"], "");
        baseCommit = await checked(repoPath, [...identity, "commit-tree", tree], "Empty task baseline\n");
      }
      const workPath = path.resolve(this.root, taskId);
      const relative = path.relative(path.resolve(repoPath), workPath);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("The dashboard data directory must be outside the project repository to isolate task worktrees.");
      }
      workspace = {
        taskId,
        repoPath,
        path: workPath,
        branch: `agent/task-${taskId}`,
        baseCommit,
        checkpointCommit: baseline ? baseCommit : null,
        checkpointAt: baseline ? new Date().toISOString() : null,
        error: null,
        publishedCommit: null,
        githubRepo: null,
        pullRequestUrl: null,
        publishError: null,
        mergeCommit: null,
        approvedCommit: null,
      };
      // Persist intent first so a restart can recover a worktree created before a crash.
      if (!this.available()) throw new Error("Dashboard is shutting down.");
      this.store.saveWorkspace(workspace);
    }
    if (!fs.existsSync(workspace.path)) {
      fs.mkdirSync(path.dirname(workspace.path), { recursive: true });
      const branchExists = await git(repoPath, ["show-ref", "--verify", `refs/heads/${workspace.branch}`]);
      await checked(
        repoPath,
        branchExists.ok
          ? ["worktree", "add", workspace.path, workspace.branch]
          : ["worktree", "add", "-b", workspace.branch, workspace.path, workspace.baseCommit],
      );
    }
    await this.verify(workspace);
    if (!this.available()) throw new Error("Dashboard is shutting down; the worktree is preserved.");
    this.store.updateTask(taskId, { baseCommit: workspace.baseCommit });
    return (await this.refresh(taskId)) ?? workspace;
  }

  async refresh(taskId: string): Promise<TaskWorkspace | null> {
    const task = this.store.getTask(taskId)!;
    const w = this.store.getWorkspace(taskId);
    const baseline = this.store.projectBaseline(task.projectId);
    if (!w || !baseline || w.baseCommit === baseline.commit) return w;
    if (!samePath(w.repoPath, baseline.repoPath)) throw new Error("The task and approved baseline belong to different repositories.");
    await this.verify(w);
    if (task.stage === "approved" || task.stage === "closed" || w.mergeCommit) throw new Error("Start a new task for changes after approval or integration.");
    let head = await checked(w.path, ["rev-parse", "HEAD"]);
    if (head !== (w.checkpointCommit ?? w.baseCommit))
      throw new Error("The task branch changed outside the dashboard. Save a fresh checkpoint before refreshing its baseline.");
    // Refresh runs only while no agent works here, and the owner cannot checkpoint a queued task, so
    // late writes (e.g. a process the last run left behind) are saved here instead of blocking it forever.
    if (await checked(w.path, ["status", "--porcelain"])) {
      const saved = await this.checkpoint(taskId, "Before baseline refresh");
      if (saved?.error) throw new Error(saved.error);
      head = saved!.checkpointCommit!;
      Object.assign(w, saved);
    }
    const commit = await mergeCommit(w.path, head, baseline.commit, `Receive approved project baseline\n\nTask: ${taskId}\n`);
    // Only fast-forward to the prepared merge. No reset, stash, rebase or conflict files.
    if (commit !== head) await checked(w.path, ["-c", "core.hooksPath=", "merge", "--ff-only", "--no-edit", commit]);
    const updated = { ...w, baseCommit: baseline.commit, checkpointCommit: commit, checkpointAt: new Date().toISOString(), approvedCommit: null, error: null };
    this.store.saveWorkspace(updated);
    this.store.updateTask(taskId, { baseCommit: baseline.commit, sessionStarted: false, sessionId: null, sessionProvider: null });
    return updated;
  }

  async checkpoint(taskId: string, reason: string, summary: CommitSummary | null = null): Promise<TaskWorkspace | null> {
    const w = this.store.getWorkspace(taskId);
    if (!w) return null;
    try {
      await this.verify(w);
      // Refuse unresolved merges, preserving both the conflict files and their index stages.
      if (await checked(w.path, ["ls-files", "--unmerged"])) throw new Error("Resolve the task's merge conflicts before checkpointing. Files are preserved.");
      await checked(w.path, ["add", "-A", "--", "."]);
      const diff = await git(w.path, ["diff", "--cached", "--quiet"]);
      if (!diff.ok) {
        const files = (await checked(w.path, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
        const fallback = `Update ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` and ${files.length - 2} more files` : ""}`
          .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
          .slice(0, 120);
        await checked(
          w.path,
          [...identity, "commit", "-F", "-"],
          `${summary?.title ?? fallback}\n\nCheckpoint: ${reason}\nTask: ${taskId}\n${summary ? `Task-summary: ${summary.taskTitle}\n` : ""}`,
        );
      }
      w.checkpointCommit = await checked(w.path, ["rev-parse", "HEAD"]);
      w.checkpointAt = new Date().toISOString();
      w.error = null;
    } catch (error) {
      w.error = `Checkpoint failed; task files remain at ${w.path}. ${(error as Error).message}`;
    }
    if (this.available()) this.store.saveWorkspace(w);
    return w;
  }
}
