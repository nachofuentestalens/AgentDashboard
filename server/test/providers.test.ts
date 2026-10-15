import { afterEach, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { buildCodexArgs } from "../src/codex.ts";
import { api, latestRun, newProject, newTask, reply, runFinished, testApp } from "./helpers.ts";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it("switches providers in both directions, bounds handoff, and resumes only the current provider", async () => {
  app = await testApp();
  const project = await newProject(app);
  const task = await newTask(app, project, { message: "Original requirement " + "x".repeat(10000) });
  await runFinished(app, latestRun(app, task.id).id);
  const claudeSession = app.store.getTask(task.id)!.sessionId;
  await api(app, "PATCH", `/api/tasks/${task.id}`, { provider: "codex", model: null });
  const send = async (text: string) => {
    const { body } = await api<{ run: { id: string } }>(app!, "POST", `/api/tasks/${task.id}/messages`, { text });
    return runFinished(app!, body.run.id);
  };
  expect((await send("Switch now [history]")).provider).toBe("codex");
  expect(reply(app, task.id)).toContain("Older conversation omitted");
  const codexSession = app.store.getTask(task.id)!.sessionId;
  expect(codexSession).not.toBe(claudeSession);
  expect(app.store.getTask(task.id)!.sessionProvider).toBe("codex");
  await send("Continue [history]");
  expect(app.store.getTask(task.id)!.sessionId).toBe(codexSession);
  expect(reply(app, task.id)).toContain("History: none");
  await api(app, "PATCH", `/api/tasks/${task.id}`, { provider: "claude", model: null });
  expect((await send("Back to Claude [history]")).provider).toBe("claude");
  expect(app.store.getTask(task.id)!.sessionId).not.toBe(codexSession);
  expect(reply(app, task.id)).toContain("conversation-so-far");
});

it("builds Codex new/resume commands with stdin and enforced sandbox", () => {
  const base = { model: null, effort: "low" as const, sandbox: "read-only" as const, writableRoots: [] };
  expect(buildCodexArgs({ ...base, resumeId: null }).slice(0, 2)).toEqual(["exec", "--json"]);
  const resumed = buildCodexArgs({ ...base, resumeId: "thread-123" });
  expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "thread-123"]);
  expect(resumed).toContain('sandbox_mode="read-only"');
  expect(resumed).toContain('approval_policy="never"');
  expect(resumed.at(-1)).toBe("-");
});
