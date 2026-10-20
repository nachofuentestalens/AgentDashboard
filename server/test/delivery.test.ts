import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app.ts";
import type { BaselinePreview, DeliveryPlanPreview, Inbox, ProjectBaseline } from "@ad/shared";
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
    const checkpoint = await workspaces.checkpoint(first.id, "first output", { title: "Write contract", taskTitle: "Define the gameplay contract" });
    await approveTask(first.id);
    const preview = await api<BaselinePreview>(app, "POST", `${endpoint}/integrate`, { taskId: first.id });
    expect(preview.status).toBe(200);
    expect(preview.body.sourceCommit).toBe(checkpoint!.checkpointCommit);
    expect((await api(app, "POST", `${endpoint}/approve`, { previewId: preview.body.id })).status).toBe(200);
    // A fast-forward preserves the checkpoint and its run-specific subject.
    expect(git(repo, "show", "-s", "--format=%s", app.store.projectBaseline(projectId)!.commit)).toBe("Write contract");
    app.runner.send(next.id, "Read the approved contract");
    await stepFinished(app, next.id);
    expect(fs.readFileSync(path.join(nw.path, "saved-wip.txt"), "utf8")).toBe("preserve me");
    expect(fs.readFileSync(path.join(nw.path, "contract.md"), "utf8")).toBe("approved output");
    expect(git(nw.path, "branch", "--show-current")).toBe(nw.branch);
    expect(git(repo, "rev-parse", "HEAD")).toBe(liveHead);
    expect(fs.existsSync(path.join(repo, "contract.md"))).toBe(false);
  });

  it("integrates a task whose agent review passed and releases its successor under hands-off delivery", async () => {
    const { repo, projectId, programmer, qa, snapshot } = await setup();
    await snapshot();
    const liveHead = git(repo, "rev-parse", "HEAD");
    const first = await newTask(app, projectId, { roleId: programmer, message: "build it [write-workspace] [review-pass]" });
    await stepFinished(app, first.id);
    const next = await newTask(app, projectId, { roleId: qa, dependencyIds: [first.id] });
    await api(app, "PATCH", `/api/projects/${projectId}`, { startNextWhenIdle: true, autoApprove: true });
    // The review was asked for by hand here; its pass is what hands-off delivery acts on.
    await api(app, "POST", `/api/tasks/${first.id}/actions`, { action: "review" });
    await waitFor(() => app.store.getTask(first.id)!.stage === "approved", 15_000);
    expect(git(repo, "show", `${app.store.projectBaseline(projectId)!.commit}:agent-work.txt`)).toBe("Unfinished agent work");
    expect(git(repo, "rev-parse", "HEAD")).toBe(liveHead);
    await waitFor(() => app.store.listRuns(next.id).length > 0, 15_000);
  });

  it("waits for delegated work without caching an approval failure, then delivers the unchanged parent", async () => {
    const { projectId, programmer, qa, snapshot } = await setup();
    await snapshot();
    const parent = await newTask(app, projectId, { roleId: programmer, message: "build it [write-workspace] [review-pass]" });
    await stepFinished(app, parent.id);
    const child = app.store.createTask({ projectId, roleId: qa, parentTaskId: parent.id, title: "Required work", canEdit: false, model: null, effort: null });
    await api(app, "POST", `/api/tasks/${parent.id}/actions`, { action: "review" });
    await stepFinished(app, parent.id);
    const deliver = vi.fn(app.runner.deliver!);
    app.runner.deliver = deliver;
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoApprove: true });
    // Drive complete scheduling passes rather than relying on a sleep to establish non-delivery.
    await app.runner["deliverReviewed"]();
    await app.runner["deliverReviewed"]();
    expect(deliver).not.toHaveBeenCalled();
    expect(app.store.getTask(parent.id)!.stage).toBe("needs_review");
    await api(app, "POST", `/api/tasks/${child.id}/actions`, { action: "close" });
    await waitFor(() => app.store.getTask(parent.id)!.stage === "approved", 15_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("retries failed delivery after the baseline changes, but suppresses unchanged failures", async () => {
    const { projectId, programmer, repo, snapshot } = await setup();
    await snapshot();
    const task = await newTask(app, projectId, { roleId: programmer, message: "build it [write-workspace] [review-pass]" });
    await stepFinished(app, task.id);
    await api(app, "POST", `/api/tasks/${task.id}/actions`, { action: "review" });
    await stepFinished(app, task.id);
    const deliver = vi.fn(app.runner.deliver!).mockRejectedValueOnce(new Error("Baseline conflict"));
    app.runner.deliver = deliver;
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoApprove: true });
    await waitFor(() => deliver.mock.calls.length === 1);
    await app.runner["deliverReviewed"]();
    expect(deliver).toHaveBeenCalledTimes(1);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Baseline repair");
    app.store.setProjectBaseline(projectId, { repoPath: repo, commit: git(repo, "rev-parse", "HEAD"), approvedAt: new Date().toISOString() });
    app.runner.tick();
    await waitFor(() => app.store.getTask(task.id)!.stage === "approved", 15_000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("shows a baseline-blocked successor in the inbox and integrates its plainly approved prerequisite under hands-off delivery", async () => {
    const { repo, projectId, programmer, qa, workspaces, snapshot, approveTask } = await setup();
    await snapshot();
    const first = await newTask(app, projectId, { roleId: programmer });
    const fw = await workspaces.ensure(first.id, repo);
    fs.writeFileSync(path.join(fw.path, "contract.md"), "approved output");
    await workspaces.checkpoint(first.id, "first output");
    // Approved without integrating: the dependency graph is satisfied but the baseline lacks the output.
    await approveTask(first.id);
    const next = await newTask(app, projectId, { roleId: qa, dependencyIds: [first.id], requiredPaths: ["contract.md"] });
    app.runner.send(next.id, "Read the approved contract");
    await waitFor(() => (app.store.listRuns(next.id).at(-1)?.waitReason ?? "").startsWith("Baseline: integrate"));
    const inbox = await api<Inbox>(app, "GET", "/api/inbox");
    expect(inbox.body.blocked.map((b) => b.task.id)).toEqual([next.id]);
    expect(inbox.body.held).toEqual([]);

    await api(app, "PATCH", `/api/projects/${projectId}`, { autoApprove: true });
    app.runner.tick();
    await stepFinished(app, next.id);
    expect(git(repo, "show", `${app.store.projectBaseline(projectId)!.commit}:contract.md`)).toBe("approved output");
    expect((await api<Inbox>(app, "GET", "/api/inbox")).body.blocked).toEqual([]);
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

  it("imports the committed milestone plan, returns legacy closures to review and pauses until enabled", async () => {
    const { repo, projectId, programmer, qa, endpoint, snapshot } = await setup();
    const spec = await newTask(app, projectId, { roleId: programmer, title: "Spec" });
    const check = await newTask(app, projectId, { roleId: qa, title: "Check" });
    const unbuilt = await newTask(app, projectId, { roleId: programmer, title: "Unbuilt" });
    app.store.updateTask(spec.id, { stage: "closed" });
    app.store.updateTask(unbuilt.id, { stage: "closed" });
    const milestone = {
      projectId,
      tasks: [
        { id: "T-1", role: "Gameplay Programmer", dependsOn: [], inputs: [], deliverables: ["spec.md"], report: "reports/t1.md" },
        { id: "T-2", role: "QA Tester", dependsOn: ["T-1"], inputs: ["README.md"], deliverables: ["qa.md"], report: "reports/t2.md" },
        { id: "T-3", role: "Gameplay Programmer", dependsOn: [], inputs: [], deliverables: ["missing.md"], report: "reports/t3.md" },
      ],
    };
    fs.mkdirSync(path.join(repo, "planning"));
    fs.writeFileSync(path.join(repo, "planning", "milestone.json"), JSON.stringify(milestone));
    fs.writeFileSync(
      path.join(repo, "planning", "dashboard-state.json"),
      JSON.stringify({ projectId, tasks: { "T-1": spec.id, "T-2": check.id, "T-3": unbuilt.id } }),
    );
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "rules");
    fs.writeFileSync(path.join(repo, "spec.md"), "spec");
    await snapshot(["AGENTS.md", "planning/dashboard-state.json", "planning/milestone.json", "spec.md"]);

    const preview = await api<DeliveryPlanPreview>(app, "POST", `${endpoint}/plan`);
    expect(preview.status).toBe(200);
    const byId = new Map(preview.body.entries.map((e) => [e.milestoneId, e]));
    expect(byId.get("T-1")).toMatchObject({ fromStage: "closed", toStage: "needs_review", missingOutputs: [] });
    expect(byId.get("T-2")).toMatchObject({ toStage: "backlog", dependencyIds: [spec.id], requiredPaths: ["AGENTS.md", "README.md", "spec.md"] });
    expect(byId.get("T-3")).toMatchObject({ toStage: "backlog", missingOutputs: ["missing.md"] });

    // Any task edit after preview makes the reviewed import stale.
    app.store.updateTask(check.id, { priority: 5 });
    expect((await api(app, "POST", `${endpoint}/plan/approve`, { previewId: preview.body.id })).status).toBe(409);
    const fresh = await api<DeliveryPlanPreview>(app, "POST", `${endpoint}/plan`);
    expect((await api(app, "POST", `${endpoint}/plan/approve`, { previewId: fresh.body.id })).status).toBe(200);

    expect(app.store.getTask(spec.id)).toMatchObject({ stage: "needs_review" });
    expect(app.store.taskApproved(app.store.getTask(spec.id)!)).toBe(false);
    expect(app.store.getTask(check.id)).toMatchObject({ stage: "backlog", dependencyIds: [spec.id] });
    expect(app.store.deliveryPaused(projectId)).toBe(true);
    expect(app.store.getProject(projectId)!.startNextWhenIdle).toBe(false);

    // A queued successor waits while paused, even though nothing else blocks it yet.
    app.runner.send(unbuilt.id, "Build it");
    await waitFor(() => app.store.listRuns(unbuilt.id).at(-1)?.waitReason?.includes("paused") === true);
    expect(app.runner.activeCount()).toBe(0);
    expect((await api(app, "POST", `/api/runs/${app.store.listRuns(unbuilt.id).at(-1)!.id}/stop`)).status).toBe(202);

    expect(app.store.dependencyBlocker(app.store.getTask(check.id)!)).toContain("owner approval");
    expect((await api(app, "POST", `/api/tasks/${spec.id}/actions`, { action: "approve" })).status).toBe(200);
    expect(app.store.dependencyBlocker(app.store.getTask(check.id)!)).toBeNull();
    expect((await api(app, "POST", `${endpoint}/enable`)).status).toBe(200);
    expect(app.store.deliveryPaused(projectId)).toBe(false);
    expect(app.store.getProject(projectId)).toMatchObject({ autoReview: true, startNextWhenIdle: true, autoContinueSteps: 0 });
  });
});
