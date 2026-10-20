import { afterEach, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { api, latestRun, newProject, newTask, runFinished, testApp, waitFor } from "./helpers.ts";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it("persists model holds, queues chats, and leaves other models available", async () => {
  const started = await testApp();
  app = started;
  const project = await newProject(app);
  const hold = { provider: "claude", model: "claude-sonnet-5", paused: true };
  expect((await api(app, "PUT", "/api/model-holds", hold)).status).toBe(200);
  const task = await newTask(app, project, { message: "held" });
  const run = latestRun(app, task.id);
  expect(run.status).toBe("queued");
  expect(run.waitReason).toContain("Model paused");
  app.runner.force(run.id);
  const other = await newTask(app, project, { model: "claude-opus-5-5", message: "available" });
  expect((await runFinished(app, latestRun(app, other.id).id)).status).toBe("succeeded");
  expect(app.store.getRun(run.id)?.status).toBe("queued");
  await app.close();
  app = await testApp(started.dataDir);
  expect((await api(app, "GET", "/api/model-holds")).body).toEqual([{ provider: "claude", model: "claude-sonnet-5" }]);
  await api(app, "PUT", "/api/model-holds", { ...hold, paused: false });
  await waitFor(() => app!.store.getRun(run.id)?.status === "succeeded");
});

it("stops an active model and resumes its latest attempt even when resumed during shutdown", async () => {
  app = await testApp();
  const task = await newTask(app, await newProject(app), { message: "[hang]" });
  const original = latestRun(app, task.id);
  expect(original.status).toBe("running");
  await api(app, "PUT", "/api/model-holds", { provider: original.provider, model: original.model, paused: true });
  await api(app, "PUT", "/api/model-holds", { provider: original.provider, model: original.model, paused: false });
  await waitFor(() => latestRun(app!, task.id).id !== original.id);
  expect(app.store.getRun(original.id)).toMatchObject({ status: "stopped", error: "Model paused by you." });
  expect(latestRun(app, task.id).model).toBe(original.model);
});

it("holds staffed role work even when forced and validates requests", async () => {
  app = await testApp();
  const project = await newProject(app);
  await api(app, "POST", `/api/projects/${project}/studio/template`);
  const role = app.store.findRoleByName(project, "CTO")!;
  app.runner.setModelHold("claude", role.model!, true);
  const task = await newTask(app, project, { roleId: role.id, message: "held role" });
  const run = latestRun(app, task.id);
  app.runner.force(run.id);
  await waitFor(() => !!app!.store.getRun(run.id)?.waitReason?.includes("Model paused"));
  expect(app.store.getRun(run.id)?.status).toBe("queued");
  expect((await api(app, "PUT", "/api/model-holds", { provider: "invalid", model: "x", paused: true })).status).toBe(400);
  app.runner.setModelHold("claude", role.model!, false);
  await waitFor(() => app!.store.getRun(run.id)?.status === "succeeded");
});
