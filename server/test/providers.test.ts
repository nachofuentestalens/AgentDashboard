import { afterEach, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import { buildCodexArgs } from "../src/codex.ts";
import { api, latestRun, newProject, newTask, reply, runFinished, stepFinished, testApp, waitFor } from "./helpers.ts";

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
  for (const resumeId of [null, "thread-123"]) expect(buildCodexArgs({ ...base, resumeId })).toContain('web_search="live"');
});

it.each(["claude", "codex"] as const)(
  "%s editable chats and roles use full access on first and resumed turns, but handoffs stay read-only",
  async (provider) => {
    app = await testApp();
    const projectId = await newProject(app);
    await api(app, "POST", `/api/projects/${projectId}/studio/template`);
    const roleId = app.store.findRoleByName(projectId, "QA Tester")!.id;
    for (const role of [null, roleId]) {
      const task = await newTask(app, projectId, { provider, roleId: role, canEdit: true, message: "Inspect [args]" });
      if (role) await stepFinished(app, task.id);
      else await runFinished(app, latestRun(app, task.id).id);
      const permission = provider === "claude" ? "bypassPermissions" : 'sandbox_mode=\\"danger-full-access\\"';
      expect(reply(app, task.id)).toContain(permission);
      const session = app.store.getTask(task.id)!.sessionId;
      const resumed = await api<{ run: { id: string } }>(app, "POST", `/api/tasks/${task.id}/messages`, { text: "Continue [args]" });
      await runFinished(app, resumed.body.run.id);
      if (role) await stepFinished(app, task.id);
      expect(reply(app, task.id)).toContain(permission);
      expect(app.store.getTask(task.id)!.sessionId).toBe(session);
      const handoff = await api<{ run: { id: string } }>(app, "POST", `/api/tasks/${task.id}/prepare-handoff`);
      expect(handoff.status).toBe(201);
      await waitFor(() => app!.store.getRun(handoff.body.run.id)?.status === "succeeded");
      const events = app.runner.readEvents(handoff.body.run.id);
      expect(events.some(({ event }) => event.kind === "text" && event.text.includes("read-only"))).toBe(true);
    }
  },
);
