import { afterEach, expect, it } from "vitest";
import type { Run, TaskDetail } from "@ad/shared";
import type { App } from "../src/app.ts";
import { extractHandoff } from "../src/efficiency.ts";
import { api, latestRun, newProject, newTask, reply, runFinished, testApp } from "./helpers.ts";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function send(taskId: string, text: string) {
  const result = await api<{ run: Run }>(app!, "POST", `/api/tasks/${taskId}/messages`, { text });
  expect(result.status).toBe(201);
  return runFinished(app!, result.body.run.id);
}

it("new tasks take their allowances from Settings", async () => {
  app = await testApp();
  const project = await newProject(app);
  const before = await newTask(app, project, { title: "Before" });
  expect([before.tokenBudget, before.toolBudget]).toEqual([null, null]);
  const patched = await api(app, "PATCH", "/api/settings", { defaultTokenBudget: 250_000, defaultToolBudget: null });
  expect(patched.body).toMatchObject({ defaultTokenBudget: 250_000, defaultToolBudget: null });
  const after = await newTask(app, project, { title: "After" });
  expect([after.tokenBudget, after.toolBudget]).toEqual([250_000, null]);
  expect(app.store.getTask(before.id)!.tokenBudget).toBeNull();
});

it.each(["claude", "codex"] as const)("%s compaction preserves history and usage but starts a fresh session", async (provider) => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project, { provider, message: "OLD_PRIVATE_EXPLORATION [tool]" });
  await runFinished(app, latestRun(app, task.id).id);
  const previous = app.store.getTask(task.id)!.sessionId;
  const usage = app.runner.usageSummary(task.id);
  const prepared = await api<{ run: Run }>(app, "POST", `/api/tasks/${task.id}/prepare-handoff`);
  expect(prepared.status).toBe(201);
  const preparedRun = await runFinished(app, prepared.body.run.id);
  expect(preparedRun.purpose).toBe("handoff");
  const events = app.runner.readEvents(preparedRun.id);
  expect(events.some((e) => e.event.kind === "text" && e.event.text.includes("read-only"))).toBe(true);
  expect(app.store.getTask(task.id)!.sessionId).toBe(previous);
  expect(app.store.getTask(task.id)!.handoff).toContain("GOAL");
  const result = await api(app, "POST", `/api/tasks/${task.id}/compact`, { summary: "Only preserve requirement: add compact handoffs." });
  expect(result.status).toBe(200);
  expect(app.runner.usageSummary(task.id).tokens).toBeGreaterThan(usage.tokens);
  await send(task.id, "Implement next phase [input]");
  expect(app.store.getTask(task.id)!.sessionId).not.toBe(previous);
  expect(reply(app, task.id)).toContain("Only preserve requirement");
  expect(reply(app, task.id)).not.toContain("OLD_PRIVATE_EXPLORATION");
  expect(app.store.listMessages(task.id).some((m) => m.text.includes("OLD_PRIVATE_EXPLORATION"))).toBe(true);
  const current = app.store.getTask(task.id)!.sessionId;
  await send(task.id, "Follow up");
  expect(app.store.getTask(task.id)!.sessionId).toBe(current);
});

it("tool checkpoints persist through compaction, retries, and delegated task accounting", async () => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { toolBudget: 1 });
  const stopped = await send(task.id, "Check files [tool] [slow]");
  expect(stopped.status).toBe("stopped");
  expect(stopped.toolCalls).toBe(1);
  expect(stopped.error).toContain("Usage checkpoint reached");
  await api(app, "POST", `/api/tasks/${task.id}/compact`, { summary: "Tool completed; verify before continuing." });
  expect((await api(app, "POST", `/api/tasks/${task.id}/messages`, { text: "continue" })).status).toBe(409);
  expect((await api(app, "POST", `/api/runs/${stopped.id}/retry`)).status).toBe(409);
  const child = app.store.createTask({ projectId: project, title: "Delegated", parentTaskId: task.id, canEdit: true, model: null, effort: null });
  expect((await api(app, "POST", `/api/tasks/${child.id}/messages`, { text: "continue" })).status).toBe(409);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { toolBudget: 3 });
  expect(app.runner.remainingAllowance(child).tools).toBe(2);
  await send(child.id, "Inspect [tool]");
  const detail = (await api<TaskDetail>(app, "GET", `/api/tasks/${task.id}`)).body;
  expect(detail.usageSummary?.toolCalls).toBe(2);
});

it("token checkpoints include cache and cannot be bypassed by a provider switch", async () => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { tokenBudget: 1000 });
  await send(task.id, "Small task");
  expect(app.runner.usageSummary(task.id).tokens).toBe(1365);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { provider: "codex" });
  expect((await api(app, "POST", `/api/tasks/${task.id}/messages`, { text: "switch" })).status).toBe(409);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { tokenBudget: 5000 });
  await send(task.id, "continue");
});

it("automatic compaction only consumes a fresh valid phase handoff", async () => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project);
  await api(app, "PATCH", `/api/tasks/${task.id}`, { autoCompact: true });
  await send(task.id, "Investigate [handoff]");
  const first = app.store.getTask(task.id)!.sessionId;
  expect(app.store.listRuns(task.id)).toHaveLength(1);
  await send(task.id, "Implement [input]");
  const second = app.store.getTask(task.id)!.sessionId;
  expect(second).not.toBe(first);
  expect(reply(app, task.id)).toContain("Investigation complete");
  await send(task.id, "Continue implementing");
  expect(app.store.getTask(task.id)!.sessionId).toBe(second);
});

it("rejects missing fields, oversized and ambiguous generated handoffs", () => {
  expect(extractHandoff('```context-handoff\n{"goal":"partial"}\n```')).toBeNull();
  expect(extractHandoff("```context-handoff\n" + "x".repeat(6001) + "\n```")).toBeNull();
  expect(extractHandoff("No summary")).toBeNull();
});

it("accepts list fields, CRLF line endings and a json label on generated handoffs", () => {
  const body = { goal: "g", constraints: "c", files: ["a.ts", "b.ts"], completed: "x".repeat(2500), verification: "v", remaining: ["r"] };
  const parsed = extractHandoff("Done.\r\n\r\n```context-handoff json\r\n" + JSON.stringify(body, null, 2).replace(/\n/g, "\r\n") + "\r\n```\r\n");
  expect(parsed).toContain("FILES\n- a.ts\n- b.ts");
  expect(parsed).toContain("REMAINING\n- r");
  expect(extractHandoff(JSON.stringify(body, null, 2))).toBe(parsed);
});

it("queues delegation requests in the inbox when the parent exhausts its allowance", async () => {
  app = await testApp();
  const project = await newProject(app);
  await api(app, "POST", `/api/projects/${project}/studio/template`);
  const qa = app.store.findRoleByName(project, "QA Tester")!;
  await api(app, "PATCH", `/api/departments/${qa.departmentId}`, { autonomy: "auto" });
  const task = await newTask(app, project, { roleId: qa.id });
  await api(app, "PATCH", `/api/tasks/${task.id}`, { tokenBudget: 1000 });
  app.runner.send(task.id, "Found issue [task:Gameplay Programmer:8]");
  const { stepFinished } = await import("./helpers.ts");
  await stepFinished(app, task.id);
  const inbox = await api<{ handoffs: { reason: string }[] }>(app, "GET", "/api/inbox");
  expect(inbox.body.handoffs[0]?.reason).toContain("Usage checkpoint reached");
  expect(app.store.listTasks(project)).toHaveLength(1);
});

it("cannot replace an active session or change its limits", async () => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project, { message: "Work [slow]" });
  expect((await api(app, "POST", `/api/tasks/${task.id}/compact`, { summary: "Premature" })).status).toBe(409);
  expect((await api(app, "PATCH", `/api/tasks/${task.id}`, { toolBudget: 1 })).status).toBe(409);
  expect((await api(app, "POST", `/api/tasks/${task.id}/prepare-handoff`)).status).toBe(409);
  app.runner.stop(latestRun(app, task.id).id);
  await runFinished(app, latestRun(app, task.id).id);
});
