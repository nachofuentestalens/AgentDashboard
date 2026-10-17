import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { App } from "../src/app.ts";
import { baselineBlocker } from "../src/readiness.ts";
import { Workspaces } from "../src/workspaces.ts";
import { api, git, gitRepo, newProject, newTask, stepFinished, testApp, waitFor } from "./helpers.ts";

let app: App;
afterEach(async () => {
  await app?.close();
});
async function setup() {
  app = await testApp();
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "baseline");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");
  const projectId = await newProject(app, repo);
  await api(app, "POST", `/api/projects/${projectId}/studio/template`);
  const roleId = app.store.findRoleByName(projectId, "QA Tester")!.id;
  return { repo, projectId, roleId };
}

describe("task prerequisites", () => {
  it("rejects cycles, duplicate, missing, cross-project and chat prerequisites without changing saved dependencies", async () => {
    const { projectId, roleId } = await setup();
    const a = await newTask(app, projectId, { roleId });
    const b = await newTask(app, projectId, { roleId, dependencyIds: [a.id] });
    const chat = await newTask(app, projectId);
    const other = await newTask(app, await newProject(app));
    for (const dependencyIds of [[b.id], [a.id], ["missing"], [chat.id], [other.id]]) {
      expect((await api(app, "PATCH", `/api/tasks/${a.id}`, { dependencyIds })).status).toBe(400);
    }
    expect((await api(app, "PATCH", `/api/tasks/${b.id}`, { dependencyIds: [a.id, a.id] })).status).toBe(400);
    expect(app.store.getTask(a.id)!.dependencyIds).toEqual([]);
    expect(app.store.getTask(b.id)!.dependencyIds).toEqual([a.id]);
    expect((await api(app, "PATCH", `/api/tasks/${b.id}`, { requiredPaths: ["../secret"] })).status).toBe(400);
  });

  it("holds an emergency even when forced, then automatically releases it only after owner approval", async () => {
    const { projectId, roleId } = await setup();
    const a = await newTask(app, projectId, { roleId });
    const b = await newTask(app, projectId, { roleId, dependencyIds: [a.id], emergency: true, message: "dependent" });
    const run = app.store.listRuns(b.id)[0]!;
    app.store.db.prepare("UPDATE runs SET forced = 1 WHERE id = ?").run(run.id);
    app.runner.tick();
    await waitFor(() => !!app.store.getRun(run.id)?.waitReason?.startsWith("Dependency:"));
    expect(app.store.getRun(run.id)!.status).toBe("queued");
    // Closing/dropping work is not acceptance.
    app.store.updateTask(a.id, { stage: "closed" });
    expect(app.store.dependencyBlocker(app.store.getTask(b.id)!)).toContain("owner approval");
    app.store.updateTask(a.id, { stage: "needs_review" });
    expect((await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "approve" })).status).toBe(200);
    await stepFinished(app, b.id);
  });

  it("skips blocked high-priority backlog work when auto-starting an idle role", async () => {
    const { projectId, roleId } = await setup();
    const a = await newTask(app, projectId, { roleId, priority: 1 });
    const b = await newTask(app, projectId, { roleId, priority: 10, dependencyIds: [a.id] });
    await api(app, "PATCH", `/api/projects/${projectId}`, { startNextWhenIdle: true });
    app.runner.tick();
    await stepFinished(app, a.id);
    expect(app.store.listRuns(b.id)).toEqual([]);
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "approve" });
    await stepFinished(app, b.id);
  });

  it("does not reuse an old approval after reopening and dropping a prerequisite", async () => {
    const { projectId, roleId } = await setup();
    const a = await newTask(app, projectId, { roleId });
    const b = await newTask(app, projectId, { roleId, dependencyIds: [a.id] });
    app.store.updateTask(a.id, { stage: "needs_review" });
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "approve" });
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "close" });
    expect(app.store.dependencyBlocker(b)).toBeNull();
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "reopen" });
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "close" });
    expect(app.store.dependencyBlocker(b)).toContain("owner approval");
  });

  it("holds untracked inputs before spending tokens and releases after they are committed", async () => {
    const { projectId, roleId, repo } = await setup();
    fs.writeFileSync(path.join(repo, "contract.md"), "contract");
    const task = await newTask(app, projectId, { roleId, requiredPaths: ["contract.md"], message: "read contract" });
    const run = app.store.listRuns(task.id)[0]!;
    await waitFor(() => !!app.store.getRun(run.id)?.waitReason?.startsWith("Baseline:"));
    expect(app.runner.activeCount()).toBe(0);
    git(repo, "add", "contract.md");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "contract");
    app.runner.tick();
    await stepFinished(app, task.id);
  });

  it("checks committed inputs in the existing worktree and approved prerequisite ancestry", async () => {
    const { projectId, roleId, repo } = await setup();
    const a = await newTask(app, projectId, { roleId });
    const b = await newTask(app, projectId, { roleId, dependencyIds: [a.id] });
    const workspaces = new Workspaces(app.store, path.join(repo, "..", `workspaces-${a.id}`));
    const workspace = await workspaces.ensure(a.id, repo);
    fs.writeFileSync(path.join(workspace.path, "contract.md"), "new contract");
    await workspaces.checkpoint(a.id, "contract");
    app.store.updateTask(a.id, { stage: "needs_review" });
    await api(app, "POST", `/api/tasks/${a.id}/actions`, { action: "approve" });
    expect(await baselineBlocker(app.store, b, repo)).toContain("integrate");
    expect(await baselineBlocker(app.store, b, workspace.path)).toBeNull();
    expect(await baselineBlocker(app.store, { ...b, dependencyIds: [], requiredPaths: ["contract.md"] }, repo)).toContain("missing");
  });
});
