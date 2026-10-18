import { afterEach, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { parseModelReview, validateModelReview } from "../src/model-routing.ts";
import { api, latestRun, newProject, newTask, runFinished, testApp, waitFor } from "./helpers.ts";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it.each(["claude", "codex"] as const)("%s reviews first and switches with a fresh context and unchanged allowance", async (provider) => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project, { provider, message: "Make a small edit [switch-model]" });
  await waitFor(() => app!.store.listRuns(task.id).length === 2 && latestRun(app!, task.id).status === "succeeded");
  const runs = app.store.listRuns(task.id);
  expect(runs[1]!.model).toBe(provider === "claude" ? "claude-haiku-4-5-20251001" : "demo-model-2");
  expect(runs[1]!.effort).toBe("low");
  expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId);
  expect(runs[1]!.messageId).toBe(runs[0]!.messageId);
  expect(app.store.getTask(task.id)!.tokenBudget).toBeNull();
  expect(app.runner.usageSummary(task.id).runs).toBe(2);
  const firstText = app.runner.readEvents(runs[0]!.id).find((e) => e.event.kind === "text");
  expect(firstText?.event).toMatchObject({ kind: "text", text: expect.stringContaining("model-review") });
  expect(app.store.runPrompt(runs[1]!.id)).toContain("Original owner request");
  expect(app.runner.readEvents(runs[0]!.id).some((e) => e.event.kind === "notice" && e.event.text.includes("Switching to"))).toBe(true);
});

it("announces only the reply that no automatic switch carries on from", async () => {
  app = await testApp();
  const ready: string[] = [];
  app.bus.subscribe((push) => {
    if (push.type === "reply_ready") ready.push(push.run.id);
  });
  const task = await newTask(app, await newProject(app), { message: "Make a small edit [switch-model]" });
  await waitFor(() => app!.store.listRuns(task.id).length === 2 && ready.length === 1);
  expect(ready).toEqual([latestRun(app, task.id).id]);
});

it("rejects unavailable models and leaves the task's settings unchanged", async () => {
  app = await testApp();
  const task = await newTask(app, await newProject(app), { message: "Edit [switch-invalid]" });
  await runFinished(app, latestRun(app, task.id).id);
  expect(app.store.listRuns(task.id)).toHaveLength(1);
  expect(app.store.getTask(task.id)!.model).toBeNull();
  expect(app.runner.readEvents(latestRun(app, task.id).id).some((e) => e.event.kind === "notice" && e.event.text.includes("not in this provider"))).toBe(true);
});

it("limits repeated automatic changes to three per owner message", async () => {
  app = await testApp();
  const task = await newTask(app, await newProject(app), { message: "Edit [switch-loop]" });
  // Four agent runs in a row: allow for slow CI runners.
  await waitFor(() => app!.store.listRuns(task.id).length === 4 && latestRun(app!, task.id).status === "succeeded", 40_000);
  expect(app.store.listRuns(task.id)).toHaveLength(4);
  expect(app.runner.readEvents(latestRun(app, task.id).id).some((e) => e.event.kind === "notice" && e.event.text.includes("switch limit reached"))).toBe(true);
});

it("does not automatically switch after the cumulative token checkpoint is reached", async () => {
  app = await testApp();
  const task = await newTask(app, await newProject(app));
  await api(app, "PATCH", `/api/tasks/${task.id}`, { tokenBudget: 1000 });
  const sent = app.runner.send(task.id, "Edit [switch-model]");
  await runFinished(app, sent.run.id);
  expect(app.store.listRuns(task.id)).toHaveLength(1);
  expect(app.store.getTask(task.id)!.model).toBeNull();
});

it("validates the complete review and provider effort before applying it", () => {
  expect(parseModelReview('```model-review\n{"model":"x"}\n```')).toBeNull();
  expect(
    validateModelReview({ complexity: "simple", model: null, effort: "max", reason: "test", action: "switch", nextStep: "implement" }, "codex", [], {
      provider: "codex",
      model: null,
      effort: "low",
    }),
  ).toContain("not supported");
});
