import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { Workspaces } from "../src/workspaces.ts";
import { api, git, gitRepo, newProject, newTask, runFinished, stepFinished, tempDir, testApp, waitFor } from "./helpers.ts";

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup() {
  const instance = await testApp();
  app = instance;
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "Original\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Baseline");
  const projectId = await newProject(instance, repo);
  return { instance, repo, projectId };
}

describe("isolated task workspaces", () => {
  it("reviews the task changes even when the primary checkout has unrelated edits", async () => {
    const { instance, repo, projectId } = await setup();
    await api(instance, "POST", `/api/projects/${projectId}/studio/template`);
    const role = instance.store.findRoleByName(projectId, "Gameplay Programmer")!;
    const task = await newTask(instance, projectId, { roleId: role.id, message: "[write-workspace] [input]" });
    await stepFinished(instance, task.id);
    fs.writeFileSync(path.join(repo, "owner-only.txt"), "Unrelated primary edits");
    await instance.runner.startReview(task.id);
    await stepFinished(instance, task.id);
    const review = instance.store.listRuns(task.id).at(-1)!;
    const input = instance.runner
      .readEvents(review.id)
      .flatMap((e) => (e.event.kind === "text" ? [e.event.text] : []))
      .join("\n");
    expect(input).toContain("Unfinished agent work");
    expect(input).not.toContain("owner-only.txt");
    expect(fs.existsSync(path.join(repo, "agent-work.txt"))).toBe(false);
  });
  it("saves modifications, deletions and new files without changing the primary tree or index; resumes after restart", async () => {
    const { instance, repo, projectId } = await setup();
    const task = await newTask(instance, projectId);
    const root = tempDir("ad-workspaces-");
    const manager = new Workspaces(instance.store, root);
    const original = git(repo, "rev-parse", "HEAD");
    const w = await manager.ensure(task.id, repo);
    fs.unlinkSync(path.join(w.path, "tracked.txt"));
    fs.writeFileSync(path.join(w.path, "new.txt"), "Incomplete\n");
    fs.writeFileSync(path.join(w.path, ".gitignore"), "ignored.txt\nignored2.txt\n");
    fs.writeFileSync(path.join(w.path, "ignored.txt"), "local secret");
    const saved = await manager.checkpoint(task.id, "Token allowance exhausted");
    expect(saved?.error).toBeNull();
    expect(git(w.path, "status", "--porcelain")).toBe("");
    expect(git(w.path, "diff", "--name-status", original)).toContain("D\ttracked.txt");
    expect(git(w.path, "ls-files")).not.toContain("ignored.txt");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(original);
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("Original\n");
    await instance.close();
    app = null;
    const reopened = await testApp(instance.dataDir);
    app = reopened;
    const resumed = await new Workspaces(reopened.store, root).ensure(task.id, repo);
    expect(resumed.path).toBe(w.path);
    expect(resumed.checkpointCommit).toBe(saved?.checkpointCommit);
  });

  it("refuses a dirty primary tree without moving or committing existing changes", async () => {
    const { instance, repo, projectId } = await setup();
    fs.writeFileSync(path.join(repo, "owner.txt"), "Owner changes");
    const task = await newTask(instance, projectId, { message: "[write-workspace]" });
    const run = await runFinished(instance, instance.store.listRuns(task.id)[0]!.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("existing changes");
    expect(instance.store.getWorkspace(task.id)).toBeNull();
    expect(fs.existsSync(path.join(repo, "agent-work.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "owner.txt"), "utf8")).toBe("Owner changes");
  });

  it("checkpoints a stopped agent and retries in the same worktree", async () => {
    const { instance, repo, projectId } = await setup();
    const task = await newTask(instance, projectId, { message: "[write-workspace] [slow]" });
    const runId = instance.store.listRuns(task.id)[0]!.id;
    await waitFor(() => {
      const w = instance.store.getWorkspace(task.id);
      return !!w && fs.existsSync(path.join(w.path, "agent-work.txt"));
    });
    expect((await api(instance, "POST", `/api/tasks/${task.id}/checkpoint`)).status).toBe(409);
    await api(instance, "POST", `/api/runs/${runId}/stop`);
    expect((await runFinished(instance, runId)).status).toBe("stopped");
    const w = instance.store.getWorkspace(task.id)!;
    expect(w.checkpointCommit).toBeTruthy();
    expect(git(w.path, "show", `${w.checkpointCommit}:agent-work.txt`)).toBe("Unfinished agent work");
    expect(fs.existsSync(path.join(repo, "agent-work.txt"))).toBe(false);
    const res = await api<{ run: { id: string } }>(instance, "POST", `/api/tasks/${task.id}/messages`, { text: "continue" });
    expect((await runFinished(instance, res.body.run.id)).status).toBe("succeeded");
    expect(instance.store.getWorkspace(task.id)?.path).toBe(w.path);
  });

  it("preserves files and reports checkpoint failure if the task branch was changed", async () => {
    const { instance, repo, projectId } = await setup();
    const task = await newTask(instance, projectId);
    const manager = new Workspaces(instance.store, tempDir("ad-workspaces-"));
    const w = await manager.ensure(task.id, repo);
    git(w.path, "switch", "-c", "unexpected");
    fs.writeFileSync(path.join(w.path, "unfinished.txt"), "Keep me");
    const saved = await manager.checkpoint(task.id, "Pause");
    expect(saved?.error).toContain("must remain on");
    expect(saved?.checkpointCommit).toBeNull();
    expect(fs.readFileSync(path.join(w.path, "unfinished.txt"), "utf8")).toBe("Keep me");
    expect((await api(instance, "POST", `/api/tasks/${task.id}/checkpoint`)).status).toBe(409);
  });
});
