import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RestartStatus } from "@ad/shared";
import type { App } from "../src/app.ts";
import { api, git, latestRun, newProject, newTask, runFinished, testApp, waitFor } from "./helpers.ts";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});
const status = async () => (await api<RestartStatus>(app!, "GET", "/api/server/restart")).body;
async function ready() {
  await vi.waitFor(async () => expect((await status()).phase).toBe("ready"), { timeout: 15_000, interval: 50 });
}

it.each(["claude", "codex"] as const)("%s saves all active work and handoffs, guards confirmation, and preserves resumable sessions", async (provider) => {
  const restart = vi.fn();
  const instance = await testApp(undefined, { restart });
  app = instance;
  const project = await newProject(app);
  const task = await newTask(app, project, { provider, message: "[slow] [write-workspace]" });
  const original = latestRun(app, task.id);
  await waitFor(() => app!.store.getTask(task.id)!.sessionStarted);
  await waitFor(() => {
    const workspace = app!.store.getWorkspace(task.id);
    return !!workspace && fs.existsSync(path.join(workspace.path, "agent-work.txt"));
  });
  const companion = await newTask(app, project, { provider, canEdit: false, message: "[slow]" });
  const companionRun = latestRun(app, companion.id);
  await waitFor(() => app!.store.getTask(companion.id)!.sessionStarted);
  const session = app.store.getTask(task.id)!.sessionId;
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  const requested = await api<RestartStatus>(app, "POST", "/api/server/restart/request");
  expect(requested.body.participants).toMatchObject([
    { taskId: task.id, state: "working" },
    { taskId: companion.id, state: "working" },
  ]);
  expect((await api(app, "POST", `/api/tasks/${task.id}/messages`, { text: "unsafe" })).status).toBe(409);
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  // Simulate a turn reaching its boundary without waiting through the slow fixture.
  app.runner.stop(original.id);
  await runFinished(app, original.id);
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  app.runner.stop(companionRun.id);
  await ready();
  const taskAfter = app.store.getTask(task.id)!;
  expect(taskAfter.handoff).toContain("GOAL");
  expect(taskAfter.sessionId).toBe(session);
  const w = app.store.getWorkspace(task.id)!;
  expect(w.error).toBeNull();
  expect(git(w.path, "status", "--porcelain")).toBe("");
  expect(app.store.listMessages(task.id).some((m) => m.text.includes("owner requested a server restart"))).toBe(true);
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(200);
  await waitFor(() => restart.mock.calls.length === 1);
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  await app.close();
  app = await testApp(instance.dataDir, { restart });
  expect((await status()).phase).toBe("idle");
  expect(app.store.getTask(task.id)!.sessionId).toBe(session);
  const resumed = app.runner.send(task.id, "Continue from saved work").run;
  await runFinished(app, resumed.id);
  expect(app.store.getTask(task.id)!.sessionId).toBe(session);
});

it("blocks checkpoint failures and external edits, permits retry and cancel", async () => {
  app = await testApp(undefined, { restart: vi.fn() });
  const project = await newProject(app);
  const task = await newTask(app, project, { message: "[slow]" });
  await waitFor(() => app!.store.getTask(task.id)!.sessionStarted);
  await api(app, "POST", "/api/server/restart/request");
  const save = vi.spyOn(app.runner, "saveRestartCheckpoint").mockRejectedValue(new Error("Disk full"));
  app.runner.stop(latestRun(app, task.id).id);
  await vi.waitFor(async () => expect((await status()).participants[0]?.error).toBe("Disk full"), { timeout: 15_000 });
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  save.mockRestore();
  await api(app, "POST", "/api/server/restart/request");
  await ready();
  fs.writeFileSync(path.join(app.store.getWorkspace(task.id)!.path, "external.txt"), "new change");
  expect((await api(app, "POST", "/api/server/restart/confirm")).status).toBe(409);
  expect((await status()).phase).toBe("preparing");
  expect((await api(app, "POST", "/api/server/restart/cancel")).status).toBe(200);
  expect(app.runner.restartHeld).toBe(false);
});

it("keeps the restart barrier after an unplanned shutdown and holds queued role work", async () => {
  const instance = await testApp(undefined, { restart: vi.fn() });
  app = instance;
  const project = await newProject(app);
  await api(app, "POST", `/api/projects/${project}/studio/template`);
  const role = app.store.findRoleByName(project, "QA Tester")!;
  const task = await newTask(app, project, { roleId: role.id, title: "Queued" });
  const queued = app.runner.send(task.id, "Check the game").run;
  await api(app, "POST", "/api/server/restart/request");
  await ready();
  expect(app.store.getRun(queued.id)?.status).toBe("queued");
  await app.close();
  app = await testApp(instance.dataDir, { restart: vi.fn() });
  expect(app.runner.restartHeld).toBe(true);
  expect(app.store.getRun(queued.id)?.status).toBe("queued");
  await api(app, "POST", "/api/server/restart/cancel");
  await waitFor(() => app!.store.getRun(queued.id)?.status !== "queued");
  await runFinished(app, queued.id);
});

it("does not offer restart without a supervising launcher", async () => {
  app = await testApp();
  expect((await status()).supported).toBe(false);
  expect((await api(app, "POST", "/api/server/restart/request")).status).toBe(409);
});
