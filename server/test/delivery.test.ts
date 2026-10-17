import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import type { BaselinePreview, ProjectBaseline } from "@ad/shared";
import { Workspaces } from "../src/workspaces.ts";
import { api, git, gitRepo, newProject, newTask, stepFinished, testApp, waitFor } from "./helpers.ts";

let app: App;
afterEach(async () => {
  await app?.close();
});
async function setup() {
  const built = await testApp();
  app = built;
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "baseline\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  const projectId = await newProject(app, repo);
  await api(app, "POST", `/api/projects/${projectId}/studio/template`);
  const qa = app.store.findRoleByName(projectId, "QA Tester")!.id;
  const programmer = app.store.findRoleByName(projectId, "Gameplay Programmer")!.id;
  const workspaces = new Workspaces(app.store, path.join(built.dataDir, "worktrees"));
  const endpoint = `/api/projects/${projectId}/delivery`;
  const snapshot = async (paths: string[] = []) => {
    const preview = await api<BaselinePreview>(app, "POST", `${endpoint}/snapshot`, { paths });
    expect(preview.status).toBe(200);
    const accepted = await api<ProjectBaseline>(app, "POST", `${endpoint}/approve`, { previewId: preview.body.id });
    expect(accepted.status).toBe(200);
    return accepted.body;
  };
  const approveTask = async (taskId: string) => {
    app.store.updateTask(taskId, { stage: "needs_review" });
    expect((await api(app, "POST", `/api/tasks/${taskId}/actions`, { action: "approve" })).status).toBe(200);
  };
  return { repo, projectId, qa, programmer, workspaces, endpoint, snapshot, approveTask };
}

describe("managed project delivery", () => {
  it("reviews an immutable snapshot without changing the live branch, index or untracked files", async () => {
    const { repo, endpoint, projectId } = await setup();
    fs.writeFileSync(path.join(repo, "contract.md"), "reviewed contract\n");
    fs.writeFileSync(path.join(repo, "README.md"), "staged change\n");
    git(repo, "add", "README.md");
    const before = { head: git(repo, "rev-parse", "HEAD"), index: git(repo, "write-tree"), status: git(repo, "status", "--porcelain") };
    const prepared = await api<BaselinePreview>(app, "POST", `${endpoint}/snapshot`, { paths: ["contract.md"] });
    expect(prepared.status).toBe(200);
    expect(prepared.body.diff).toContain("reviewed contract");
    expect(app.store.projectBaseline(projectId)).toBeNull();
    fs.writeFileSync(path.join(repo, "contract.md"), "later unreviewed edit\n");
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: prepared.body.id })).status).toBe(200);
    expect(git(repo, "show", `${app.store.projectBaseline(projectId)!.commit}:contract.md`)).toBe("reviewed contract");
    expect(git(repo, "show", `${app.store.projectBaseline(projectId)!.commit}:README.md`)).toBe("baseline");
    expect({ head: git(repo, "rev-parse", "HEAD"), index: git(repo, "write-tree"), status: git(repo, "status", "--porcelain") }).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "contract.md"), "utf8")).toContain("later unreviewed");
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: prepared.body.id })).status).toBe(409);
  });

  it("starts a read-only role from the approved snapshot and its approval can satisfy a dependency", async () => {
    const { repo, projectId, qa, snapshot } = await setup();
    fs.writeFileSync(path.join(repo, "contract.md"), "contract");
    const baseline = await snapshot(["contract.md"]);
    const task = await newTask(app, projectId, { roleId: qa, requiredPaths: ["contract.md"], message: "Review contract" });
    await stepFinished(app, task.id);
    const w = app.store.getWorkspace(task.id)!;
    expect(w.baseCommit).toBe(baseline.commit);
    expect(fs.readFileSync(path.join(w.path, "contract.md"), "utf8")).toBe("contract");
    await api(app, "POST", `/api/tasks/${task.id}/actions`, { action: "approve" });
    const next = await newTask(app, projectId, { roleId: qa, dependencyIds: [task.id] });
    expect(app.store.dependencyBlocker(next)).toBeNull();
  });

  it("integrates an exact approved checkpoint and refreshes a successor without losing its WIP", async () => {
    const { repo, projectId, programmer, qa, workspaces, endpoint, snapshot, approveTask } = await setup();
    await snapshot();
    const liveHead = git(repo, "rev-parse", "HEAD");
    const first = await newTask(app, projectId, { roleId: programmer });
    const next = await newTask(app, projectId, { roleId: qa, dependencyIds: [first.id], requiredPaths: ["contract.md"] });
    const nw = await workspaces.ensure(next.id, repo);
    fs.writeFileSync(path.join(nw.path, "saved-wip.txt"), "preserve me");
    await workspaces.checkpoint(next.id, "saved WIP");
    const fw = await workspaces.ensure(first.id, repo);
    fs.writeFileSync(path.join(fw.path, "contract.md"), "approved output");
    const checkpoint = await workspaces.checkpoint(first.id, "first output");
    await approveTask(first.id);
    const preview = await api<BaselinePreview>(app, "POST", `${endpoint}/integrate`, { taskId: first.id });
    expect(preview.status).toBe(200);
    expect(preview.body.sourceCommit).toBe(checkpoint!.checkpointCommit);
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: preview.body.id })).status).toBe(200);
    app.runner.send(next.id, "Read the approved contract");
    await stepFinished(app, next.id);
    expect(fs.readFileSync(path.join(nw.path, "saved-wip.txt"), "utf8")).toBe("preserve me");
    expect(fs.readFileSync(path.join(nw.path, "contract.md"), "utf8")).toBe("approved output");
    expect(git(nw.path, "branch", "--show-current")).toBe(nw.branch);
    expect(git(repo, "rev-parse", "HEAD")).toBe(liveHead);
    expect(fs.existsSync(path.join(repo, "contract.md"))).toBe(false);
  });

  it("refuses stale approval and leaves conflicting worktrees untouched", async () => {
    const { repo, projectId, programmer, workspaces, endpoint, snapshot, approveTask } = await setup();
    await snapshot();
    const first = await newTask(app, projectId, { roleId: programmer });
    const second = await newTask(app, projectId, { roleId: programmer });
    const a = await workspaces.ensure(first.id, repo);
    const b = await workspaces.ensure(second.id, repo);
    for (const [w, text] of [
      [a, "first"],
      [b, "second"],
    ] as const) {
      fs.writeFileSync(path.join(w.path, "README.md"), text);
      await workspaces.checkpoint(w.taskId, text);
      await approveTask(w.taskId);
    }
    const p = await api<BaselinePreview>(app, "POST", `${endpoint}/integrate`, { taskId: first.id });
    expect(p.status).toBe(200);
    fs.writeFileSync(path.join(a.path, "extra.md"), "unreviewed");
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: p.body.id })).status).toBe(409);
    fs.unlinkSync(path.join(a.path, "extra.md"));
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: p.body.id })).status).toBe(200);
    const conflict = await api<{ error: string }>(app, "POST", `${endpoint}/integrate`, { taskId: second.id });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toContain("conflicting");
    expect(git(b.path, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(b.path, "README.md"), "utf8")).toBe("second");
    app.store.updateTask(second.id, { stage: "backlog" });
    app.runner.send(second.id, "Continue after baseline refresh");
    await waitFor(() => app.store.listRuns(second.id).at(-1)?.waitReason?.includes("conflicting") === true);
    expect(app.runner.activeCount()).toBe(0);
    expect(git(b.path, "status", "--porcelain")).toBe("");
  });
});
