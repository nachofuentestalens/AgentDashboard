import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runner } from "../src/runner.ts";
import type { App } from "../src/app.ts";
import { Github, githubRepository, publishBaseline } from "../src/github.ts";
import { git as realGit } from "../src/git.ts";
import { Workspaces } from "../src/workspaces.ts";
import { api, git, gitRepo, newProject, newTask, tempDir, testApp } from "./helpers.ts";

let app: App | null = null;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app?.close();
  app = null;
});

async function fixture() {
  const instance = await testApp();
  app = instance;
  const repo = gitRepo();
  const projectId = await newProject(instance, repo);
  const task = await newTask(instance, projectId);
  const workspaces = new Workspaces(instance.store, tempDir("ad-github-workspaces-"));
  const w = await workspaces.ensure(task.id, repo);
  fs.writeFileSync(path.join(w.path, "work.txt"), "Unfinished work");
  const saved = (await workspaces.checkpoint(task.id, "End of agent run", { title: "Save workspace output", taskTitle: "Preserve isolated task work" }))!;
  const calls: { endpoint: string; method: string; body: any }[] = [];
  const pushes: string[][] = [];
  const state = {
    pushFails: false,
    apiFails: false,
    check: "success",
    remote: "https://github.com/owner/game.git",
    existing: false,
    merged: false,
    mergeCommit: "abc1234" as string | null,
    closed: false,
    sha: saved.checkpointCommit!,
  };
  const pull = () => ({
    number: 12,
    node_id: "PR_node",
    html_url: "https://github.com/owner/game/pull/12",
    state: state.closed ? "closed" : "open",
    draft: true,
    merged: state.merged,
    merge_commit_sha: state.merged ? state.mergeCommit : null,
    head: { sha: state.sha, ref: w.branch, repo: { full_name: "owner/game" } },
    base: { ref: "main", repo: { full_name: "owner/game" } },
  });
  const github = new Github(
    instance.store,
    workspaces,
    () => true,
    async (_path, _repo, endpoint, method = "GET", body) => {
      calls.push({ endpoint, method, body });
      if (state.apiFails) throw new Error("GitHub unavailable");
      if (endpoint === "/repos/owner/game") return { default_branch: "main" };
      if (endpoint.includes("/check-runs")) return { total_count: 1, check_runs: [{ status: "completed", conclusion: state.check }] };
      if (endpoint.includes("/status?")) return { total_count: 0, state: "pending" };
      if (endpoint.endsWith("/merge")) return { merged: true, sha: "abc1234" };
      if (endpoint.includes("/pulls?")) return state.existing ? [pull()] : [];
      if (endpoint.endsWith("/pulls") && method === "POST") {
        state.existing = true;
        return pull();
      }
      if (endpoint.endsWith("/pulls/12")) return pull();
      if (endpoint === "/graphql") return { data: {} };
      throw new Error(`Unexpected test request: ${method} ${endpoint}`);
    },
    async (cwd, args, stdin) => {
      if (args[0] === "remote") return { ok: true, stdout: state.remote, stderr: "" };
      if (args[0] === "push") {
        pushes.push(args);
        return { ok: !state.pushFails, stdout: "", stderr: "" };
      }
      return realGit(cwd, args, stdin);
    },
  );
  return { instance, repo, task, w, saved, state, calls, pushes, github };
}

describe("GitHub checkpoint publication", () => {
  it("accepts GitHub remotes but rejects embedded credentials, other hosts and multiple URLs", () => {
    expect(githubRepository("https://github.com/owner/game.git")).toBe("owner/game");
    expect(githubRepository("git@github.com:owner/game.git")).toBe("owner/game");
    expect(githubRepository("https://token@github.com/owner/game.git")).toBeNull();
    expect(githubRepository("https://example.com/owner/game.git")).toBeNull();
    expect(githubRepository("https://github.com/owner/game.git\nhttps://github.com/other/game.git")).toBeNull();
  });

  it("pushes the saved SHA without force and creates then reuses a draft PR", async () => {
    const f = await fixture();
    const first = await f.github.publish(f.task.id);
    expect(first?.publishError).toBeNull();
    expect(first?.publishedCommit).toBe(f.saved.checkpointCommit);
    expect(first?.pullRequestUrl).toBe("https://github.com/owner/game/pull/12");
    expect(f.pushes[0]).toEqual(["push", "origin", `${f.saved.checkpointCommit}:refs/heads/${f.w.branch}`]);
    expect(f.calls.find((c) => c.method === "POST" && c.endpoint.endsWith("/pulls"))?.body).toMatchObject({
      draft: true,
      base: "main",
      head: f.w.branch,
      title: "Preserve isolated task work",
    });
    await f.github.publish(f.task.id);
    expect(f.calls.filter((c) => c.method === "POST" && c.endpoint.endsWith("/pulls"))).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "PATCH")?.body.title).toBe("Preserve isolated task work");
    expect(git(f.w.path, "status", "--porcelain")).toBe("");
  });

  it("retains local checkpoint and distinguishes failed push from a backed-up branch whose PR failed", async () => {
    const f = await fixture();
    f.state.pushFails = true;
    let result = await f.github.publish(f.task.id);
    expect(result?.checkpointCommit).toBe(f.saved.checkpointCommit);
    expect(result?.publishedCommit).toBeNull();
    expect(result?.publishError).toContain("push failed");
    expect(f.calls).toHaveLength(0);
    f.state.pushFails = false;
    f.state.apiFails = true;
    result = await f.github.publish(f.task.id);
    expect(result?.publishedCommit).toBe(f.saved.checkpointCommit);
    expect(result?.publishError).toBe("GitHub unavailable");
    f.state.apiFails = false;
    expect((await f.github.publish(f.task.id))?.publishError).toBeNull();
  });

  it("refuses redirected remotes and unsaved local edits", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    f.state.remote = "https://github.com/other/game.git";
    expect((await f.github.publish(f.task.id))?.publishError).toContain("remote changed");
    expect(f.pushes).toHaveLength(1);
    f.state.remote = "https://github.com/owner/game.git";
    fs.writeFileSync(path.join(f.w.path, "more.txt"), "not saved");
    expect((await f.github.publish(f.task.id))?.publishError).toContain("fresh checkpoint");
    expect(f.pushes).toHaveLength(1);
  });

  it("blocks failed checks and a changed PR head, then squash-merges exactly the validated checkpoint", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    f.state.check = "failure";
    await expect(f.github.merge(f.task.id)).rejects.toThrow("successful GitHub checks");
    expect(f.calls.some((c) => c.endpoint.endsWith("/merge"))).toBe(false);
    expect(f.instance.store.getStateJson(`verified-merge.${f.task.id}`)).toBeNull();
    f.state.check = "success";
    f.state.sha = "f".repeat(40);
    await expect(f.github.merge(f.task.id)).rejects.toThrow("no longer matches");
    f.state.sha = f.saved.checkpointCommit!;
    const merged = await f.github.merge(f.task.id);
    expect(merged.mergeCommit).toBe("abc1234");
    expect(f.instance.store.getStateJson(`verified-merge.${f.task.id}`)).toEqual({ checkpoint: f.saved.checkpointCommit, merge: "abc1234" });
    expect(f.calls.find((c) => c.endpoint.endsWith("/merge"))?.body).toEqual({
      sha: f.saved.checkpointCommit,
      merge_method: "squash",
      commit_title: "Preserve isolated task work",
    });
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect((await api(f.instance, "POST", `/api/tasks/${f.task.id}/messages`, { text: "more" })).status).toBe(409);
  });

  it("does not push more work into an externally merged pull request", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    f.state.merged = true;
    const result = await f.github.publish(f.task.id);
    expect(result?.mergeCommit).toBe("abc1234");
    expect(result?.publishError).toContain("already merged");
    expect(f.instance.store.getStateJson(`verified-merge.${f.task.id}`)).toBeNull();
    expect(f.pushes).toHaveLength(1);
  });

  it("observes an external merge without touching dirty local work or requiring the current checkpoint head", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    fs.writeFileSync(path.join(f.w.path, "work.txt"), "local edits");
    fs.writeFileSync(path.join(f.w.path, "untracked.txt"), "keep me");
    const before = f.instance.store.getWorkspace(f.task.id)!;
    f.instance.store.saveWorkspace({ ...before, error: "local checkpoint error", publishError: "old publication failure" });
    const status = git(f.w.path, "status", "--porcelain");
    f.state.sha = "f".repeat(40);
    f.state.merged = true;
    f.state.closed = true;
    f.calls.length = 0;
    expect(await f.github.syncMerge(f.task.id)).toBe(true);
    expect(f.instance.store.getWorkspace(f.task.id)).toEqual({ ...before, error: "local checkpoint error", publishError: null, mergeCommit: "abc1234" });
    expect(f.calls).toEqual([{ endpoint: "/repos/owner/game/pulls/12", method: "GET", body: undefined }]);
    expect(git(f.w.path, "status", "--porcelain")).toBe(status);
    expect(fs.readFileSync(path.join(f.w.path, "work.txt"), "utf8")).toBe("local edits");
    expect(fs.readFileSync(path.join(f.w.path, "untracked.txt"), "utf8")).toBe("keep me");
    expect(f.pushes).toHaveLength(1);
    expect(f.instance.store.workspacesAwaitingMerge()).toHaveLength(0);
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("keeps state for open, closed-unmerged, failed and incomplete API responses, then retries", async () => {
    const f = await fixture();
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    expect(f.calls).toHaveLength(0);
    await f.github.publish(f.task.id);
    const before = { ...f.instance.store.getWorkspace(f.task.id)!, publishError: "keep existing error" };
    f.instance.store.saveWorkspace(before);
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    f.state.closed = true;
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    f.state.apiFails = true;
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    f.state.apiFails = false;
    f.state.merged = true;
    f.state.mergeCommit = null;
    expect(await f.github.syncMerge(f.task.id)).toBe(false);
    expect(f.instance.store.getWorkspace(f.task.id)).toEqual(before);
    f.state.mergeCommit = "abc1234";
    expect(await f.github.syncMerge(f.task.id)).toBe(true);
  });

  it("does not overwrite newer workspace metadata or save an in-flight response after shutdown", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    let available = true;
    let respond!: (value: unknown) => void;
    const github = new Github(
      f.instance.store,
      {} as Workspaces,
      () => available,
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = github.syncMerge(f.task.id);
    const current = { ...f.instance.store.getWorkspace(f.task.id)!, checkpointCommit: "e".repeat(40), error: "new error" };
    f.instance.store.saveWorkspace(current);
    respond({ merged: true, merge_commit_sha: "abc1234" });
    expect(await pending).toBe(true);
    expect(f.instance.store.getWorkspace(f.task.id)).toEqual({ ...current, mergeCommit: "abc1234" });
    f.instance.store.saveWorkspace(current);
    const stopped = github.syncMerge(f.task.id);
    available = false;
    respond({ merged: true, merge_commit_sha: "abc1234" });
    expect(await stopped).toBe(false);
    expect(f.instance.store.getWorkspace(f.task.id)).toEqual(current);
  });

  it("polls on the runner timer and emits a task refresh once, then stops on close", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    f.state.merged = true;
    const sync = f.github.syncMerge.bind(f.github);
    const spy = vi.spyOn(Github.prototype, "syncMerge").mockImplementation(sync);
    const events: string[] = [];
    const off = f.instance.bus.subscribe((event) => events.push(event.type));
    vi.useFakeTimers();
    const runner = new Runner(f.instance.store, f.instance.bus, f.instance.dataDir);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.instance.store.getWorkspace(f.task.id)?.mergeCommit).toBe("abc1234");
      expect(events.filter((type) => type === "task_updated")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      runner.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      runner.close();
      off();
    }
  });

  it("skips busy tasks and prevents overlapping polls while allowing other PRs after API failures", async () => {
    const f = await fixture();
    await f.github.publish(f.task.id);
    const other = await newTask(f.instance, f.task.projectId);
    f.instance.store.saveWorkspace({ ...f.instance.store.getWorkspace(f.task.id)!, taskId: other.id });
    const busy = vi.spyOn(f.instance.runner, "isTaskRunning").mockImplementation((id) => id === f.task.id);
    const read = f.github.syncMerge.bind(f.github);
    let respond!: (value: boolean) => void;
    const sync = vi.spyOn(Github.prototype, "syncMerge").mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = f.instance.runner.syncGithubMerges();
    await f.instance.runner.syncGithubMerges();
    expect(sync.mock.calls).toEqual([[other.id]]);
    respond(false);
    await pending;
    busy.mockRestore();
    sync.mockImplementation(read);
    f.state.apiFails = true;
    await f.instance.runner.syncGithubMerges();
    expect(f.calls.slice(-2).map((c) => c.endpoint)).toEqual(["/repos/owner/game/pulls/12", "/repos/owner/game/pulls/12"]);
    expect(f.instance.runner.isTaskRunning(other.id)).toBe(false);
  });
});

describe("GitHub baseline publication", () => {
  const commit = (repo: string, file: string, text: string, message: string) => {
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, "add", file);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
    return git(repo, "rev-parse", "HEAD");
  };
  // A local bare repository stands in for GitHub; only the origin URL check sees a github.com address.
  function remotes() {
    const remote = tempDir("ad-github-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const repo = gitRepo();
    git(repo, "remote", "add", "origin", remote);
    const start = commit(repo, "README.md", "start\n", "start");
    git(repo, "push", "-q", "origin", "main");
    const runGit: typeof realGit = (cwd, args, stdin, env) =>
      args[0] === "remote" ? Promise.resolve({ ok: true, stdout: "https://github.com/owner/game.git", stderr: "" }) : realGit(cwd, args, stdin, env);
    const other = tempDir("ad-github-clone-");
    git(other, "clone", "-q", remote, ".");
    return { remote, repo, start, runGit, other };
  }

  it("fast-forwards the default branch to the baseline without touching the live branch", async () => {
    const { remote, repo, start, runGit } = remotes();
    git(repo, "checkout", "-q", "-b", "baseline");
    const baseline = commit(repo, "a.txt", "task output\n", "task");
    git(repo, "checkout", "-q", "main");
    expect(await publishBaseline(repo, baseline, runGit)).toBe(baseline);
    expect(git(remote, "rev-parse", "main")).toBe(baseline);
    expect(git(repo, "rev-parse", "main")).toBe(start);
  });

  it("merges commits made on GitHub into the baseline and refuses conflicts", async () => {
    const { remote, repo, runGit, other } = remotes();
    const owner = commit(other, "decisions.md", "owner decision\n", "decision");
    git(other, "push", "-q", "origin", "main");
    const baseline = commit(repo, "a.txt", "task output\n", "task");
    const merged = (await publishBaseline(repo, baseline, runGit))!;
    expect(git(repo, "rev-list", "--parents", "-n", "1", merged).split(" ").slice(1)).toEqual([baseline, owner]);
    expect(git(remote, "rev-parse", "main")).toBe(merged);

    git(other, "pull", "-q", "--ff-only");
    commit(other, "a.txt", "edited on GitHub\n", "edit");
    git(other, "push", "-q", "origin", "main");
    const before = git(remote, "rev-parse", "main");
    const conflicting = commit(repo, "a.txt", "edited by a task\n", "task edit");
    await expect(publishBaseline(repo, conflicting, runGit)).rejects.toThrow("conflict");
    expect(git(remote, "rev-parse", "main")).toBe(before);
  });

  it("skips projects without a GitHub origin", async () => {
    const repo = gitRepo();
    expect(await publishBaseline(repo, "0".repeat(40))).toBeNull();
  });
});
