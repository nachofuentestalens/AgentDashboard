import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceCleanupPreview } from "@ad/shared";
import type { App } from "../src/app.ts";
import { Workspaces } from "../src/workspaces.ts";
import { WorkspaceCleanup } from "../src/workspace-cleanup.ts";
import { api, git, gitRepo, newProject, newTask, tempDir, testApp } from "./helpers.ts";

let app: App;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

async function setup() {
  app = await testApp();
  const repo = gitRepo();
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Base");
  const projectId = await newProject(app, repo);
  const task = await newTask(app, projectId);
  const manager = new Workspaces(app.store, tempDir("ad-cleanup-"));
  const initial = await manager.ensure(task.id, repo);
  fs.writeFileSync(path.join(initial.path, "file.txt"), "delivered\n");
  const w = (await manager.checkpoint(task.id, "test"))!;
  app.store.saveWorkspace({ ...w, approvedCommit: w.checkpointCommit });
  app.store.updateTask(task.id, { status: "done" });
  app.store.setProjectBaseline(projectId, { repoPath: repo, commit: w.checkpointCommit!, approvedAt: new Date().toISOString() });
  return { repo, task, projectId, manager, w, cleanup: new WorkspaceCleanup(app.store, manager), url: `/api/tasks/${task.id}/workspace-cleanup` };
}

it("previews and removes only a delivered worktree, preserving records, branch, recovery ref and reopen", async () => {
  const { repo, task, w, url, manager, projectId } = await setup();
  const before = app.store.getWorkspace(task.id);
  const history = app.store.listRuns(task.id);
  const liveHead = git(repo, "rev-parse", "HEAD");
  const preview = await api<WorkspaceCleanupPreview>(app, "GET", url);
  expect(preview.body.eligible).toBe(true);
  expect(preview.body.evidence).toContain("ancestor");
  expect(fs.existsSync(w.path)).toBe(true);
  const all = await api<WorkspaceCleanupPreview[]>(app, "GET", `/api/projects/${projectId}/workspace-cleanup`);
  expect(all.body.map((p) => p.taskId)).toContain(task.id);
  expect((await api(app, "POST", url)).status).toBe(200);
  expect(fs.existsSync(w.path)).toBe(false);
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(w.branch);
  expect(git(repo, "rev-parse", w.branch)).toBe(w.checkpointCommit);
  expect(git(repo, "rev-parse", `refs/agentdashboard/recovery/${task.id}/${w.checkpointCommit}`)).toBe(w.checkpointCommit);
  expect(app.store.getWorkspace(task.id)).toEqual(before);
  expect(app.store.listRuns(task.id)).toEqual(history);
  expect(app.store.getTask(task.id)).not.toBeNull();
  expect(git(repo, "rev-parse", "HEAD")).toBe(liveHead);
  expect((await api(app, "POST", url)).status).toBe(409);
  // The retained branch can recreate the exact checkout without altering task history.
  git(repo, "worktree", "add", w.path, w.branch);
  await manager.verify(w);
  expect(git(w.path, "rev-parse", "HEAD")).toBe(w.checkpointCommit);
});

it.each(["running", "queued", "idle", "failed"] as const)("refuses %s tasks even with delivered commits", async (status) => {
  const { task, url, w } = await setup();
  app.store.updateTask(task.id, { status });
  expect((await api<WorkspaceCleanupPreview>(app, "GET", url)).body.eligible).toBe(false);
  expect((await api(app, "POST", url)).status).toBe(409);
  expect(fs.existsSync(w.path)).toBe(true);
});

it.each([
  "tracked",
  "staged",
  "untracked",
  "ignored",
  "conflict",
  "operation",
  "uncheckpointed",
  "unmerged",
  "unapproved",
  "wrong-branch",
  "locked",
  "assume-unchanged",
  "skip-worktree",
  "other-live",
])("refuses %s worktrees", async (kind) => {
  const { repo, task, url, w } = await setup();
  if (kind === "tracked" || kind === "staged") {
    fs.writeFileSync(path.join(w.path, "file.txt"), "unsaved\n");
    if (kind === "staged") git(w.path, "add", ".");
  }
  if (kind === "untracked") fs.writeFileSync(path.join(w.path, "new.txt"), "unsaved");
  if (kind === "ignored") {
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\nsecret.txt\n");
    fs.writeFileSync(path.join(w.path, "secret.txt"), "preserve");
  }
  if (kind === "conflict") {
    git(repo, "checkout", "-b", "conflict");
    fs.writeFileSync(path.join(repo, "file.txt"), "conflicting\n");
    git(repo, "commit", "-qam", "Conflict");
    try {
      git(w.path, "merge", "conflict");
    } catch {
      /* Expected merge conflict. */
    }
  }
  if (kind === "operation") fs.writeFileSync(git(w.path, "rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD"), w.baseCommit);
  if (kind === "uncheckpointed") git(w.path, "commit", "--allow-empty", "-qm", "Unrecorded");
  if (kind === "unmerged") app.store.setProjectBaseline(task.projectId, { repoPath: repo, commit: w.baseCommit, approvedAt: new Date().toISOString() });
  if (kind === "unapproved") app.store.saveWorkspace({ ...w, approvedCommit: null });
  if (kind === "wrong-branch") git(w.path, "checkout", "-b", "unexpected");
  if (kind === "locked") git(repo, "worktree", "lock", w.path);
  if (kind === "assume-unchanged" || kind === "skip-worktree") {
    git(w.path, "update-index", `--${kind}`, "file.txt");
    fs.writeFileSync(path.join(w.path, "file.txt"), "hidden change");
  }
  if (kind === "other-live") await newProject(app, w.path);
  expect((await api<WorkspaceCleanupPreview>(app, "GET", url)).body.eligible).toBe(false);
  const result = await api(app, "POST", url);
  expect(result.status).toBe(409);
  expect(fs.existsSync(w.path)).toBe(true);
});

it("refuses live and executing checkouts", async () => {
  const { repo, task, w, cleanup } = await setup();
  vi.spyOn(process, "cwd").mockReturnValue(w.path);
  expect((await cleanup.preview(task.id)).reasons.join(" ")).toContain("executing cleanup");
  vi.restoreAllMocks();
  vi.spyOn(app.store, "getWorkspace").mockReturnValue({ ...w, path: repo, branch: "main" });
  expect((await cleanup.preview(task.id)).reasons.join(" ")).toContain("live project checkout");
});

it("rechecks changes after preview and immediately before Git removal", async () => {
  const { task, w, cleanup } = await setup();
  const original = cleanup.preview.bind(cleanup);
  let calls = 0;
  vi.spyOn(cleanup, "preview").mockImplementation(async (id) => {
    const result = await original(id);
    if (++calls === 1) fs.writeFileSync(path.join(w.path, "late.txt"), "late change");
    return result;
  });
  await expect(cleanup.remove(task.id)).rejects.toThrow("untracked");
  expect(calls).toBe(2);
  expect(fs.existsSync(w.path)).toBe(true);
});

it("holds the runner lock against sends and concurrent cleanup", async () => {
  const { task, url, w } = await setup();
  const original = WorkspaceCleanup.prototype.preview;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(WorkspaceCleanup.prototype, "preview").mockImplementation(async function (this: WorkspaceCleanup, id, busy) {
    entered();
    await gate;
    return original.call(this, id, busy);
  });
  const removal = api(app, "POST", url);
  await ready;
  expect(app.runner.isTaskRunning(task.id)).toBe(true);
  expect((await api(app, "POST", url)).status).toBe(409);
  expect(() => app.runner.send(task.id, "Do more work")).toThrow();
  release();
  expect((await removal).status).toBe(200);
  expect(fs.existsSync(w.path)).toBe(false);
});

it("requires recorded checks plus locally verifiable squash delivery", async () => {
  const { repo, task, w, cleanup } = await setup();
  app.store.setProjectBaseline(task.projectId, { repoPath: repo, commit: w.baseCommit, approvedAt: new Date().toISOString() });
  git(repo, "merge", "--squash", w.branch);
  git(repo, "commit", "-qm", "Squash delivery");
  const merge = git(repo, "rev-parse", "HEAD");
  app.store.saveWorkspace({ ...w, mergeCommit: merge });
  expect((await cleanup.preview(task.id)).eligible).toBe(false);
  app.store.setStateJson(`verified-merge.${task.id}`, { checkpoint: w.checkpointCommit, merge });
  expect((await cleanup.preview(task.id)).eligible).toBe(true);
  app.store.setStateJson(`verified-merge.${task.id}`, { checkpoint: w.baseCommit, merge });
  expect((await cleanup.preview(task.id)).eligible).toBe(false);
  const missing = "f".repeat(40);
  app.store.saveWorkspace({ ...w, mergeCommit: missing });
  app.store.setStateJson(`verified-merge.${task.id}`, { checkpoint: w.checkpointCommit, merge: missing });
  expect((await cleanup.preview(task.id)).eligible).toBe(false);
  fs.writeFileSync(path.join(repo, "file.txt"), "Different delivery\n");
  git(repo, "commit", "-qam", "Different delivery");
  const different = git(repo, "rev-parse", "HEAD");
  app.store.saveWorkspace({ ...w, mergeCommit: different });
  app.store.setStateJson(`verified-merge.${task.id}`, { checkpoint: w.checkpointCommit, merge: different });
  expect((await cleanup.preview(task.id)).eligible).toBe(false);
});
