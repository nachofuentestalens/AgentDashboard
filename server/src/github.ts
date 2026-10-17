import type { TaskWorkspace } from "@ad/shared";
import { git } from "./git.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";

type Request = (repoPath: string, repository: string, endpoint: string, method?: string, body?: unknown) => Promise<any>;
type Pull = {
  number: number;
  node_id: string;
  html_url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
};

export function githubRepository(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return match?.[1] ?? null;
}

// Tokens remain in memory, never in SQLite, command arguments, responses or logs.
const request: Request = async (repoPath, repository, endpoint, method = "GET", body) => {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const credential = await git(repoPath, ["credential", "fill"], `protocol=https\nhost=github.com\npath=${repository}.git\n\n`);
    if (credential.ok)
      token = credential.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("password="))
        ?.slice(9);
  }
  if (!token)
    throw new Error(
      "GitHub API authentication is unavailable. Sign in with Git Credential Manager or set GH_TOKEN for the dashboard server, then retry Publish. Local work is saved.",
    );
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Do not echo server bodies that might contain remote URLs or credential details.
  if (!response.ok)
    throw new Error(`GitHub ${method} failed (HTTP ${response.status}). Check repository access, token permissions and branch rules, then retry.`);
  const data = (await response.json()) as any;
  if (data.errors) throw new Error("GitHub refused the operation. Check repository permissions and pull request state.");
  return data;
};

export class Github {
  constructor(
    private readonly store: Store,
    private readonly workspaces: Workspaces,
    private readonly available = () => true,
    private readonly api: Request = request,
    private readonly runGit = git,
  ) {}

  private save(w: TaskWorkspace) {
    if (this.available()) this.store.saveWorkspace(w);
  }

  private async repository(w: TaskWorkspace): Promise<string | null> {
    const remote = await this.runGit(w.path, ["remote", "get-url", "--push", "--all", "origin"]);
    if (!remote.ok) return null;
    const urls = remote.stdout.split(/\r?\n/);
    const repository = urls.length === 1 ? githubRepository(urls[0]!) : null;
    if (!repository) throw new Error("Automatic publication requires a single github.com origin push URL.");
    if (w.githubRepo && w.githubRepo.toLowerCase() !== repository.toLowerCase())
      throw new Error("The GitHub remote changed. This task stays attached to its original repository.");
    w.githubRepo = repository;
    this.save(w);
    return repository;
  }

  private async requireSnapshot(w: TaskWorkspace) {
    await this.workspaces.verify(w);
    const head = await this.runGit(w.path, ["rev-parse", "HEAD"]);
    const dirty = await this.runGit(w.path, ["status", "--porcelain"]);
    if (!w.checkpointCommit || !head.ok || head.stdout !== w.checkpointCommit || !dirty.ok || dirty.stdout) {
      throw new Error("Save a fresh checkpoint before publishing or merging.");
    }
  }

  async publish(taskId: string): Promise<TaskWorkspace | null> {
    const w = this.store.getWorkspace(taskId);
    if (!w || w.error || w.mergeCommit) return w;
    try {
      await this.requireSnapshot(w);
      const repository = await this.repository(w);
      if (!repository) return w;
      if (w.pullRequestUrl) {
        const number = w.pullRequestUrl.split("/").at(-1)!;
        if (!/^\d+$/.test(number)) throw new Error("Invalid saved pull request URL.");
        const previous = (await this.api(w.path, repository, `/repos/${repository}/pulls/${number}`)) as Pull;
        if (previous.merged) {
          w.mergeCommit = previous.merge_commit_sha;
          throw new Error("This pull request was already merged. Local work is preserved; create a follow-up task for additional changes.");
        }
        if (previous.state !== "open") throw new Error("This task's pull request is closed. Reopen it on GitHub before publishing more work.");
      }
      // No work has happened yet; avoid creating empty remote branches/PRs.
      if (w.checkpointCommit === w.baseCommit) return w;
      const pushed = await this.runGit(w.path, ["push", "origin", `${w.checkpointCommit}:refs/heads/${w.branch}`]);
      if (!pushed.ok)
        throw new Error(
          "GitHub branch push failed. Check Git authentication, connectivity, or divergent remote changes. No force push was attempted; the local checkpoint is safe.",
        );
      w.publishedCommit = w.checkpointCommit;
      this.save(w);
      const prefix = `/repos/${repository}`;
      const repo = await this.api(w.path, repository, prefix);
      if (!this.available()) return w;
      const task = this.store.getTask(taskId);
      const body =
        `Task: ${task?.title ?? taskId}\n\nCheckpoint: ${w.checkpointCommit}\n\n${task?.handoff ?? task?.stepSummary ?? "Work in progress. Review the task transcript before merging."}\n\nCreated by AgentDashboard. Local checkpoints may contain incomplete work.`.slice(
          0,
          60_000,
        );
      const pulls = (await this.api(
        w.path,
        repository,
        `${prefix}/pulls?state=open&head=${encodeURIComponent(repository.split("/")[0] + ":" + w.branch)}&base=${encodeURIComponent(repo.default_branch)}`,
      )) as Pull[];
      const pull =
        pulls[0] ??
        ((await this.api(w.path, repository, `${prefix}/pulls`, "POST", {
          title: (task?.title ?? `Task ${taskId}`).slice(0, 200),
          body,
          head: w.branch,
          base: repo.default_branch,
          draft: true,
        })) as Pull);
      this.validatePull(w, repository, pull);
      if (pulls.length && !pull.draft)
        await this.api(w.path, repository, "/graphql", "POST", {
          query: "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }",
          variables: { id: pull.node_id },
        });
      if (pulls.length) await this.api(w.path, repository, `${prefix}/pulls/${pull.number}`, "PATCH", { body });
      w.pullRequestUrl = `https://github.com/${repository}/pull/${pull.number}`;
      w.publishError = null;
    } catch (error) {
      w.publishError = (error as Error).message;
    }
    this.save(w);
    return w;
  }

  private validatePull(w: TaskWorkspace, repository: string, pull: Pull) {
    if (
      pull.head.ref !== w.branch ||
      pull.head.sha !== w.checkpointCommit ||
      pull.head.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
      pull.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new Error("The pull request no longer matches this task's checkpoint and repository. Refresh publication before merging.");
    }
  }

  async merge(taskId: string): Promise<TaskWorkspace> {
    const w = this.store.getWorkspace(taskId);
    if (!w?.pullRequestUrl || !w.githubRepo) throw new Error("Publish this task's draft pull request first.");
    try {
      await this.requireSnapshot(w);
      const repository = await this.repository(w);
      if (!repository) throw new Error("The GitHub remote is missing.");
      const number = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(w.pullRequestUrl)?.[1];
      if (!number) throw new Error("Invalid saved pull request URL.");
      const prefix = `/repos/${repository}`;
      const pull = (await this.api(w.path, repository, `${prefix}/pulls/${number}`)) as Pull;
      this.validatePull(w, repository, pull);
      if (pull.merged) {
        w.mergeCommit = pull.merge_commit_sha;
        w.publishError = null;
        this.save(w);
        return w;
      }
      if (pull.state !== "open") throw new Error("This pull request is closed.");
      const [checks, statuses, repo] = await Promise.all([
        this.api(w.path, repository, `${prefix}/commits/${w.checkpointCommit}/check-runs?per_page=100`),
        this.api(w.path, repository, `${prefix}/commits/${w.checkpointCommit}/status?per_page=100`),
        this.api(w.path, repository, prefix),
      ]);
      if (pull.base.ref !== repo.default_branch) throw new Error("The pull request must target the repository's default branch.");
      if (checks.total_count > 100 || statuses.total_count > 100) throw new Error("Too many checks for automatic verification; review and merge on GitHub.");
      if (
        checks.total_count + statuses.total_count === 0 ||
        checks.check_runs.some((c: any) => c.status !== "completed" || c.conclusion !== "success") ||
        (statuses.total_count > 0 && statuses.state !== "success")
      ) {
        throw new Error("Merge blocked: the current checkpoint needs successful GitHub checks. Pending, missing or failed checks cannot be bypassed here.");
      }
      if (pull.draft)
        await this.api(w.path, repository, "/graphql", "POST", {
          query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
          variables: { id: pull.node_id },
        });
      const merged = await this.api(w.path, repository, `${prefix}/pulls/${number}/merge`, "PUT", { sha: w.checkpointCommit, merge_method: "squash" });
      if (!merged.merged) throw new Error("GitHub did not merge the pull request. Resolve conflicts or branch requirements on GitHub.");
      w.mergeCommit = merged.sha;
      w.publishError = null;
    } catch (error) {
      w.publishError = (error as Error).message;
      this.save(w);
      throw error;
    }
    this.save(w);
    return w;
  }
}
