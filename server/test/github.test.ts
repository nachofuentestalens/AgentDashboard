import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { Github, githubRepository } from "../src/github.ts";
import { git as realGit } from "../src/git.ts";
import { Workspaces } from "../src/workspaces.ts";
import { api, git, gitRepo, newProject, newTask, tempDir, testApp } from "./helpers.ts";

let app: App | null = null;
afterEach(async () => {
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
  const saved = (await workspaces.checkpoint(task.id, "Pause"))!;
  const calls: { endpoint: string; method: string; body: any }[] = [];
  const pushes: string[][] = [];
  const state = {
    pushFails: false,
    apiFails: false,
    check: "success",
    remote: "https://github.com/owner/game.git",
    existing: false,
    merged: false,
    sha: saved.checkpointCommit!,
  };
  const pull = () => ({
    number: 12,
    node_id: "PR_node",
    html_url: "https://github.com/owner/game/pull/12",
    state: "open",
    draft: true,
    merged: state.merged,
    merge_commit_sha: state.merged ? "abc1234" : null,
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
    expect(f.calls.find((c) => c.method === "POST" && c.endpoint.endsWith("/pulls"))?.body).toMatchObject({ draft: true, base: "main", head: f.w.branch });
    await f.github.publish(f.task.id);
    expect(f.calls.filter((c) => c.method === "POST" && c.endpoint.endsWith("/pulls"))).toHaveLength(1);
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
    f.state.check = "success";
    f.state.sha = "f".repeat(40);
    await expect(f.github.merge(f.task.id)).rejects.toThrow("no longer matches");
    f.state.sha = f.saved.checkpointCommit!;
    const merged = await f.github.merge(f.task.id);
    expect(merged.mergeCommit).toBe("abc1234");
    expect(f.calls.find((c) => c.endpoint.endsWith("/merge"))?.body).toEqual({ sha: f.saved.checkpointCommit, merge_method: "squash" });
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
    expect(f.pushes).toHaveLength(1);
  });
});
