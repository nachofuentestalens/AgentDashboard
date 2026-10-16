import fs from "node:fs";
import path from "node:path";
import type { TaskWorkspace } from "@ad/shared";
import { COMMIT_ID, git } from "./git.ts";
import type { Store } from "./store.ts";

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

  async ensure(taskId: string, repoPath: string): Promise<TaskWorkspace> {
    let workspace = this.store.getWorkspace(taskId);
    if (workspace && !samePath(workspace.repoPath, repoPath))
      throw new Error("This task belongs to its original repository. Create a new task for the new project path.");
    if (!workspace) {
      // Mixed edits in the live checkout cannot safely be attributed to this task.
      const dirty = await checked(repoPath, ["status", "--porcelain"]);
      if (dirty)
        throw new Error("Commit or shelve the existing changes in the project folder before starting an isolated task. No files were moved or discarded.");
      const head = await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
      let baseCommit: string;
      if (head.ok && COMMIT_ID.test(head.stdout)) baseCommit = head.stdout;
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
        checkpointCommit: null,
        checkpointAt: null,
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
    return workspace;
  }

  async checkpoint(taskId: string, reason: string): Promise<TaskWorkspace | null> {
    const w = this.store.getWorkspace(taskId);
    if (!w) return null;
    try {
      await this.verify(w);
      // Refuse unresolved merges, preserving both the conflict files and their index stages.
      if (await checked(w.path, ["ls-files", "--unmerged"])) throw new Error("Resolve the task's merge conflicts before checkpointing. Files are preserved.");
      await checked(w.path, ["add", "-A", "--", "."]);
      const diff = await git(w.path, ["diff", "--cached", "--quiet"]);
      if (!diff.ok) await checked(w.path, [...identity, "commit", "-F", "-"], `WIP: ${reason}\n\nTask: ${taskId}\n`);
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
