import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_CONFIG, type Task } from "@ad/shared";
import type { App } from "../src/app.ts";
import fs from "node:fs";
import path from "node:path";
import { api, git, gitRepo, newProject, newTask, stepFinished, testApp, waitFor } from "./helpers.ts";

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

// A repository with one commit, so tasks record where their work began.
async function roleProject() {
  app = await testApp();
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# Game\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "Start");
  const projectId = await newProject(app, repo);
  await api(app, "POST", `/api/projects/${projectId}/studio/template`);
  const qa = app.store.findRoleByName(projectId, "QA Tester")!;
  return { app, projectId, qa };
}

const act = (app: App, taskId: string, body: Record<string, unknown>) => api<Task & { error?: string }>(app, "POST", `/api/tasks/${taskId}/actions`, body);

describe("task stages", () => {
  it("moves a role task from backlog through review to closed", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id });
    expect(task.stage).toBe("backlog");

    expect((await act(app, task.id, { action: "start", text: "check the build" })).status).toBe(200);
    expect((await stepFinished(app, task.id)).stage).toBe("needs_review");

    const changes = await act(app, task.id, { action: "request_changes", text: "Also check the menus." });
    expect(changes.body.stage).toBe("changes_requested");
    expect(app.store.listTaskReviews(task.id)).toMatchObject([{ reviewer: "owner", verdict: "changes", findings: ["Also check the menus."] }]);

    await act(app, task.id, { action: "fix" });
    await stepFinished(app, task.id);
    const sent = app.store.listMessages(task.id).filter((m) => m.role === "user");
    expect(sent.at(-1)!.text).toContain("- Also check the menus.");

    expect((await act(app, task.id, { action: "close" })).body.stage).toBe("closed");
    expect((await api(app, "POST", `/api/tasks/${task.id}/messages`, { text: "more" })).status).toBe(409);
    expect((await act(app, task.id, { action: "reopen" })).body.stage).toBe("backlog");
  });

  it("refuses moves the stage does not allow, and actions on chats", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id });
    const refused = await act(app, task.id, { action: "approve" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/needs_review/);
    expect((await act(app, task.id, { action: "dance" })).status).toBe(400);

    const chat = await newTask(app, projectId, {});
    expect(chat.stage).toBeNull();
    expect((await act(app, chat.id, { action: "close" })).status).toBe(400);
    expect((await api<Task>(app, "PATCH", `/api/tasks/${chat.id}`, { done: true })).body.status).toBe("done");
  });

  it("asks before approving a task whose delegated work is still open", async () => {
    const { app, projectId, qa } = await roleProject();
    await api(app, "PATCH", `/api/departments/${qa.departmentId}`, { autonomy: "auto" });
    const parent = await newTask(app, projectId, { roleId: qa.id, message: "Found issue [task:Gameplay Programmer:8]" });
    await stepFinished(app, parent.id);
    const child = app.store.listTasks(projectId).find((t) => t.parentTaskId === parent.id);
    if (!child) return expect.fail("no delegated task was created");
    // Finished but not reviewed is still open.
    await stepFinished(app, child.id);

    const held = await act(app, parent.id, { action: "approve" });
    expect(held.status).toBe(409);
    expect(held.body.error).toContain(child.title);
    expect((await act(app, parent.id, { action: "approve", force: true })).body.stage).toBe("approved");
  });

  it("reads the agent's step block: done waits for review, partial keeps working", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id, message: "add dash [step-done]" });
    expect(await stepFinished(app, task.id)).toMatchObject({ stepState: "done", stepSummary: "Fake step done.", nextStep: "Tune the dash cooldown." });

    await act(app, task.id, { action: "continue" });
    await stepFinished(app, task.id);
    const sent = app.store.listMessages(task.id).filter((m) => m.role === "user");
    expect(sent.at(-1)!.text).toBe("Continue with: Tune the dash cooldown.");
    // No block this time: the step still counts as done, and the stale summary goes.
    expect(app.store.getTask(task.id)).toMatchObject({ stepState: null, stepSummary: null, nextStep: null });

    await act(app, task.id, { action: "continue", text: "more [step-partial]" });
    await waitFor(() => app.store.getRun(app.store.listRuns(task.id).at(-1)!.id)?.status === "succeeded");
    await waitFor(() => app.store.getTask(task.id)!.status === "idle");
    expect(app.store.getTask(task.id)).toMatchObject({ stage: "in_progress", stepState: "partial" });

    const chat = await newTask(app, projectId, { message: "hi [step-complete]" });
    await waitFor(() => app.store.getTask(chat.id)!.status === "idle" && app.store.listRuns(chat.id).length > 0);
    expect(app.store.getTask(chat.id)).toMatchObject({ stage: null, stepState: null });
  });

  it("reviews a step read-only in a fresh session, and Fix sends the findings back", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id, message: "check the build [step-done] [review-changes] [args]" });
    const authored = await stepFinished(app, task.id);
    expect(authored.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    expect((await act(app, task.id, { action: "review" })).body.stage).toBe("in_review");
    await waitFor(() => app.store.getTask(task.id)!.stage === "changes_requested");
    const run = app.store.listRuns(task.id).at(-1)!;
    expect(run).toMatchObject({ purpose: "review", roleId: qa.id, status: "succeeded" });
    expect(run.sessionId).not.toBe(authored.sessionId);
    expect(app.store.getTask(task.id)!.sessionId).toBe(authored.sessionId);
    const text = app.runner
      .readEvents(run.id)
      .flatMap((e) => (e.event.kind === "text" ? [e.event.text] : []))
      .join("\n");
    const args = JSON.parse(text.match(/Arguments: (\[.*\])/)![1]!) as string[];
    expect(args).toContain("--session-id");
    expect(args).toContain("--disallowedTools");
    expect(args).not.toContain("acceptEdits");
    expect(app.store.listTaskReviews(task.id)).toMatchObject([
      { reviewer: qa.id, verdict: "changes", findings: ["src/dash.ts:42 cooldown never resets after death"] },
    ]);

    await act(app, task.id, { action: "fix" });
    await stepFinished(app, task.id);
    const sent = app.store.listMessages(task.id).filter((m) => m.role === "user");
    expect(sent.at(-1)!.text).toContain("- src/dash.ts:42 cooldown never resets after death");
    // The fix resumed the author's session, not the reviewer's.
    expect(app.store.listRuns(task.id).at(-1)!.sessionId).toBe(authored.sessionId);
  });

  it("picks the reviewer: one-off choice, then the task's, then the role's default, then the role itself", async () => {
    const { app, projectId, qa } = await roleProject();
    const designer = app.store.findRoleByName(projectId, "Systems Designer")!;
    const director = app.store.findRoleByName(projectId, "Game Director")!;
    const task = await newTask(app, projectId, { roleId: qa.id, message: "check [review-pass]" });
    const reviewWith = async (roleId?: string) => {
      await stepFinished(app, task.id);
      expect((await act(app, task.id, roleId ? { action: "review", roleId } : { action: "review" })).status).toBe(200);
      await waitFor(() => app.store.getTask(task.id)!.stage === "needs_review" && app.store.getTask(task.id)!.status === "idle");
      return app.store.listRuns(task.id).at(-1)!.roleId;
    };

    expect(await reviewWith()).toBe(qa.id);
    expect((await api(app, "PATCH", `/api/roles/${qa.id}`, { reviewerRoleId: designer.id })).status).toBe(200);
    expect(await reviewWith()).toBe(designer.id);
    expect((await api(app, "PATCH", `/api/tasks/${task.id}`, { reviewerRoleId: director.id })).status).toBe(200);
    expect(await reviewWith()).toBe(director.id);
    expect(await reviewWith(qa.id)).toBe(qa.id);
    expect(app.store.listTaskReviews(task.id).map((r) => r.verdict)).toEqual(["pass", "pass", "pass", "pass"]);

    const other = await newProject(app);
    await api(app, "POST", `/api/projects/${other}/studio/template`);
    const outsider = app.store.findRoleByName(other, "QA Tester")!;
    expect((await act(app, task.id, { action: "review", roleId: outsider.id })).status).toBe(400);
    expect((await api(app, "PATCH", `/api/tasks/${task.id}`, { reviewerRoleId: outsider.id })).status).toBe(400);
    expect((await api(app, "PATCH", `/api/roles/${qa.id}`, { reviewerRoleId: outsider.id })).status).toBe(400);
  });

  it("hands the step back unreviewed when the review gives no verdict, and refuses reviews outside needs_review", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id });
    expect((await act(app, task.id, { action: "review" })).status).toBe(409);

    await act(app, task.id, { action: "start", text: "check" });
    await stepFinished(app, task.id);
    await act(app, task.id, { action: "review" });
    await waitFor(() => app.store.listRuns(task.id).at(-1)!.status === "succeeded");
    const done = await stepFinished(app, task.id);
    expect(done.stage).toBe("needs_review");
    expect(app.store.listTaskReviews(task.id)).toEqual([]);
    const notices = app.runner.readEvents(app.store.listRuns(task.id).at(-1)!.id).flatMap((e) => (e.event.kind === "notice" ? [e.event.text] : []));
    expect(notices.join("\n")).toContain("without a valid review block");
  });

  it("keeps the agent's plan as steps and ticks them off as steps finish", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id, message: "add dash [plan] [step-done]" });
    await stepFinished(app, task.id);
    expect(app.store.listTaskSteps(task.id).map((s) => [s.title, s.state])).toEqual([
      ["Add the dash ability", "done"],
      ["Tune the dash cooldown", "active"],
      ["Write the tests", "pending"],
    ]);
    expect(app.store.listTaskSteps(task.id)[0]).toMatchObject({ summary: "Fake step done.", runId: app.store.listRuns(task.id)[0]!.id });

    await act(app, task.id, { action: "continue" });
    await waitFor(() => app.store.listRuns(task.id).length === 2);
    await stepFinished(app, task.id);
    expect(app.store.listTasks(projectId).find((t) => t.id === task.id)!.steps).toEqual({ done: 2, total: 3 });
  });

  it("reviews automatically and continues after a pass, up to the project's limit", async () => {
    const { app, projectId, qa } = await roleProject();
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoReview: true, autoContinueSteps: 1 });
    const task = await newTask(app, projectId, { roleId: qa.id, message: "work [step-done] [review-pass]" });
    // work → review (pass) → work (continued), then it stops: the second step gave no next step, and
    // it changed no files, so the passed review still covers it.
    await waitFor(() => app.store.listRuns(task.id).length === 3, 15_000);
    const done = await stepFinished(app, task.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(app.store.listRuns(task.id).map((r) => r.purpose)).toEqual(["work", "review", "work"]);
    expect(done.autoContinues).toBe(1);
    expect(app.store.listMessages(task.id).filter((m) => m.role === "user")[2]!.text).toBe("Continue with: Tune the dash cooldown.");

    // The owner acting resets the count.
    await act(app, task.id, { action: "continue", text: "one more" });
    await waitFor(() => app.store.listRuns(task.id).length >= 4);
    expect(app.store.getTask(task.id)!.autoContinues).toBe(0);
    await stepFinished(app, task.id);
    expect(app.store.listTaskReviews(task.id)).toHaveLength(1);
  });

  it("approves a passed task and starts the next one without the owner (hands-off delivery)", async () => {
    const { app, projectId, qa } = await roleProject();
    const first = await newTask(app, projectId, { roleId: qa.id, title: "First check", priority: 9, message: "work [review-pass]" });
    const second = await newTask(app, projectId, { roleId: qa.id, title: "Second check" });
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoReview: true, startNextWhenIdle: true, autoApprove: true });
    // Work, review and baseline integration run back to back; Windows CI has taken over 15 s here.
    await waitFor(() => app.store.getTask(first.id)!.stage === "approved", 40_000);
    expect(app.store.listRuns(first.id).map((r) => r.purpose)).toEqual(["work", "review"]);
    expect(app.store.listTaskReviews(first.id).map((r) => [r.reviewer === "owner" ? "owner" : "agent", r.verdict])).toEqual([
      ["agent", "pass"],
      ["owner", "approved"],
    ]);
    await waitFor(() => app.store.listRuns(second.id).length > 0, 40_000);
  });

  it("sends review findings back a bounded number of times under hands-off delivery", async () => {
    const { app, projectId, qa } = await roleProject();
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoReview: true, autoApprove: true });
    const task = await newTask(app, projectId, { roleId: qa.id, message: "work [review-changes]" });
    // The fake reviewer always asks for changes: three automatic fixes, then the owner decides.
    await waitFor(() => app.store.listTaskReviews(task.id).length === 4 && app.store.getTask(task.id)!.status === "idle", 30_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(app.store.listRuns(task.id).map((r) => r.purpose)).toEqual(["work", "review", "work", "review", "work", "review", "work", "review"]);
    expect(app.store.getTask(task.id)!.stage).toBe("changes_requested");
    expect(app.store.listMessages(task.id).filter((m) => m.role === "user")[2]!.text).toMatch(/^Address these review findings:/);
  });

  it("starts the top backlog task of an idle role when the project opts in", async () => {
    const { app, projectId, qa } = await roleProject();
    const first = await newTask(app, projectId, { roleId: qa.id, title: "Urgent check", priority: 9 });
    const second = await newTask(app, projectId, { roleId: qa.id, title: "Later check" });
    await new Promise((r) => setTimeout(r, 100));
    expect(app.store.listRuns(first.id)).toEqual([]);

    await api(app, "PATCH", `/api/projects/${projectId}`, { startNextWhenIdle: true });
    await stepFinished(app, first.id);
    await stepFinished(app, second.id);
    const [a, b] = [app.store.listRuns(first.id)[0]!, app.store.listRuns(second.id)[0]!];
    // One at a time for the role, in priority order.
    expect(b.startedAt >= a.endedAt!).toBe(true);
    expect(app.store.listMessages(first.id)[0]!.text).toBe("Start on this task: Urgent check");
  });

  it("resumes a step its agent left partial when the project opts in, within the continuation limit", async () => {
    const { app, projectId, qa } = await roleProject();
    await api(app, "PATCH", `/api/projects/${projectId}`, { autoContinueSteps: 1 });
    const task = await newTask(app, projectId, { roleId: qa.id, message: "work [step-partial]" });
    await waitFor(() => app.store.getTask(task.id)!.stepState === "partial" && app.store.getTask(task.id)!.status === "idle");
    expect(app.store.listRuns(task.id)).toHaveLength(1);

    await api(app, "PATCH", `/api/projects/${projectId}`, { startNextWhenIdle: true });
    await stepFinished(app, task.id);
    expect(app.store.listRuns(task.id)).toHaveLength(2);
    expect(app.store.listMessages(task.id).filter((m) => m.role === "user")[1]!.text).toMatch(/^Continue the unfinished step/);
    expect(app.store.getTask(task.id)).toMatchObject({ stage: "needs_review", autoContinues: 1 });
  });

  it("maps the legacy done flag to approve and close", async () => {
    const { app, projectId, qa } = await roleProject();
    const task = await newTask(app, projectId, { roleId: qa.id, message: "check" });
    await stepFinished(app, task.id);
    const closed = (await api<Task>(app, "PATCH", `/api/tasks/${task.id}`, { done: true })).body;
    expect(closed).toMatchObject({ status: "idle", stage: "closed" });
    expect(app.store.listTaskReviews(task.id).map((r) => r.verdict)).toEqual(["approved"]);
    expect((await api<Task>(app, "PATCH", `/api/tasks/${task.id}`, { done: false })).body.stage).toBe("backlog");
  });

  it("routes start-next work to available Codex and runs its complexity model review", async () => {
    const { app, projectId, qa } = await roleProject();
    for (const provider of ["claude", "codex"]) {
      await api(app, "POST", "/api/coordinator/readings", {
        provider,
        window: "session",
        usedPercent: provider === "claude" ? 50 : 1,
        resetsAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      });
    }
    await api(app, "PUT", "/api/coordinator/config", { ...DEFAULT_COORDINATOR_CONFIG, mode: "auto", fillIdle: true });
    // Change the project directly so the next scheduling pass observes both task and policy together.
    app.store.updateProject(projectId, { startNextWhenIdle: true });
    const task = await newTask(app, projectId, { roleId: qa.id, title: "Small check [switch-model]" });
    app.runner.tick();
    await waitFor(() => app.store.listRuns(task.id).length === 2 && app.store.listRuns(task.id).at(-1)?.status === "succeeded");
    const runs = app.store.listRuns(task.id);
    expect(runs.map((r) => r.provider)).toEqual(["codex", "codex"]);
    expect(runs[1]).toMatchObject({ model: "demo-model-2", effort: "low" });
    expect(app.store.getTask(task.id)!.stage).toBe("needs_review");
  });
});
