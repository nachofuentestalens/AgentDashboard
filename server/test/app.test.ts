import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Run, StampedEvent, TaskDetail } from "@ad/shared";
import type { App } from "../src/app.ts";
import { api, gitRepo, newProject, newTask, runFinished, tempDir, testApp, waitFor } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const start = async (dataDir?: string) => {
  const app = await testApp(dataDir);
  apps.push(app);
  return app;
};

describe("request guard", () => {
  it("refuses foreign hosts and origins, and non-JSON writes", async () => {
    const app = await start();
    const host = await app.fastify.inject({ method: "GET", url: "/api/projects", headers: { host: "evil.example:5190" } });
    expect(host.statusCode).toBe(403);
    const origin = await app.fastify.inject({ method: "GET", url: "/api/projects", headers: { host: "127.0.0.1:5190", origin: "https://evil.example" } });
    expect(origin.statusCode).toBe(403);
    const form = await app.fastify.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "localhost:5190", "content-type": "text/plain" },
      payload: '{"name":"x","repoPath":"/tmp"}',
    });
    expect(form.statusCode).toBe(415);
    const ok = await app.fastify.inject({ method: "GET", url: "/api/projects", headers: { host: "localhost:5173", origin: "http://localhost:5173" } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("projects", () => {
  it("requires the top folder of a git repository and can create one", async () => {
    const app = await start();
    const plain = tempDir("ad-plain-");
    const refused = await api<{ error: string; canInit: boolean }>(app, "POST", "/api/projects", { name: "P", repoPath: plain });
    expect(refused.status).toBe(422);
    expect(refused.body.canInit).toBe(true);

    const repo = gitRepo();
    fs.mkdirSync(path.join(repo, "sub"));
    const inside = await api<{ error: string }>(app, "POST", "/api/projects", { name: "P", repoPath: path.join(repo, "sub") });
    expect(inside.status).toBe(422);
    expect(inside.body.error).toMatch(/inside the repository/);

    const created = await api<Project>(app, "POST", "/api/projects", { name: "P", repoPath: path.join(plain, "new-game"), initGit: true });
    expect(created.status).toBe(201);
    expect(fs.existsSync(path.join(plain, "new-game", ".git"))).toBe(true);
    expect(created.body.defaultModel).toBe("claude-opus-5-5");
    expect(created.body.defaultEffort).toBe("medium");
    expect(created.body.allowedTools).toContain("Bash(git:*)");
  });

  it("validates updates", async () => {
    const app = await start();
    const id = await newProject(app);
    expect((await api(app, "PATCH", `/api/projects/${id}`, { allowedTools: ['Bash(rm -rf "/")'] })).status).toBe(400);
    expect((await api(app, "PATCH", `/api/projects/${id}`, { defaultModel: "opus; rm" })).status).toBe(400);
    const ok = await api<Project>(app, "PATCH", `/api/projects/${id}`, { defaultEffort: "high", allowedTools: ["Bash(pnpm test:*)"] });
    expect(ok.body.defaultEffort).toBe("high");
    expect(ok.body.allowedTools).toEqual(["Bash(pnpm test:*)"]);
  });
});

describe("chat tasks", () => {
  it("runs the first message, then resumes the same session for the next", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "Design three starter classes [tool]" });
    expect(task.title).toBe("Design three starter classes [tool]");
    expect(task.status).toBe("running");

    const firstRun = app.store.listRuns(task.id)[0]!;
    const first = await runFinished(app, firstRun.id);
    expect(first.status).toBe("succeeded");
    expect(first.costUsd).toBeCloseTo(0.0123);
    expect(first.usage.outputTokens).toBe(45);
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.effort).toBe("medium");

    const events = (await api<StampedEvent[]>(app, "GET", `/api/runs/${first.id}/events`)).body;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.event.kind === "tool_use")).toBe(true);
    expect(events.at(-1)?.event.kind).toBe("result");

    const second = await api<{ run: Run }>(app, "POST", `/api/tasks/${task.id}/messages`, { text: "Now make the Warrior tankier" });
    expect(second.status).toBe(201);
    await runFinished(app, second.body.run.id);

    const detail = (await api<TaskDetail>(app, "GET", `/api/tasks/${task.id}`)).body;
    expect(detail.task.status).toBe("idle");
    expect(detail.task.sessionStarted).toBe(true);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(detail.messages[1]!.text).toBe("The working tree is clean.");
    expect(detail.messages[3]!.text).toContain(`Continuing session ${detail.task.sessionId!.slice(0, 8)}`);
    expect(detail.runs.every((r) => r.sessionId === detail.task.sessionId)).toBe(true);
  });

  it("passes the task's model, effort and read-only mode to the agent", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "hi", canEdit: false, model: "claude-haiku-5-5", effort: "low" });
    const run = await runFinished(app, app.store.listRuns(task.id)[0]!.id);
    expect(run.model).toBe("claude-haiku-5-5");
    expect(run.effort).toBe("low");
    expect(app.store.listMessages(task.id)[1]!.text).toContain("on claude-haiku-5-5 (read-only)");
  });

  it("refuses a second message while the agent works", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "[slow]" });
    const busy = await api<{ error: string }>(app, "POST", `/api/tasks/${task.id}/messages`, { text: "again" });
    expect(busy.status).toBe(409);
    const run = app.store.listRuns(task.id)[0]!;
    expect((await api(app, "POST", `/api/runs/${run.id}/stop`)).status).toBe(202);
    const stopped = await runFinished(app, run.id);
    expect(stopped.status).toBe("stopped");
    expect(app.store.getTask(task.id)!.status).toBe("idle");
    expect((await api(app, "POST", `/api/runs/${run.id}/stop`)).status).toBe(409);
  });

  it("records failures and retries the latest one", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "break [fail]" });
    const failed = await runFinished(app, app.store.listRuns(task.id)[0]!.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Simulated failure.");
    expect(app.store.getTask(task.id)!.status).toBe("failed");

    const retry = await api<Run>(app, "POST", `/api/runs/${failed.id}/retry`);
    expect(retry.status).toBe(201);
    expect(retry.body.messageId).toBe(failed.messageId);
    await runFinished(app, retry.body.id);
    // Still fails, since the prompt still says [fail]; the point is that retry reused the session.
    expect(app.store.getRun(retry.body.id)!.sessionId).toBe(failed.sessionId);
    expect((await api(app, "POST", `/api/runs/${failed.id}/retry`)).status).toBe(409);
  });

  it("reports a crash with the agent's stderr", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "[crash]" });
    const run = await runFinished(app, app.store.listRuns(task.id)[0]!.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/exited with code 3/);
    const events = app.runner.readEvents(run.id);
    expect(events.some((e) => e.event.kind === "stderr" && e.event.text.includes("simulated crash"))).toBe(true);
    // The CLI announced the session before crashing, so the next message resumes it.
    expect(app.store.getTask(task.id)!.sessionStarted).toBe(true);
  });

  it("deletes a task with its run logs", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "hello" });
    const run = await runFinished(app, app.store.listRuns(task.id)[0]!.id);
    const file = app.runner.eventsFile(run.id);
    expect(fs.existsSync(file)).toBe(true);
    expect((await api(app, "DELETE", `/api/tasks/${task.id}`)).status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect((await api(app, "GET", `/api/tasks/${task.id}`)).status).toBe(404);
  });

  it("lists tasks with their totals", async () => {
    const app = await start();
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "hello" });
    await runFinished(app, app.store.listRuns(task.id)[0]!.id);
    const list = (await api<{ id: string; messageCount: number; costUsd: number; lastMessage: string }[]>(app, "GET", `/api/projects/${projectId}/tasks`)).body;
    expect(list[0]).toMatchObject({ id: task.id, messageCount: 2 });
    expect(list[0]!.costUsd).toBeCloseTo(0.0123);
    expect(list[0]!.lastMessage).toContain("You said");
  });
});

describe("restarts", () => {
  it("marks runs that were active when the server stopped as interrupted", async () => {
    const dataDir = tempDir("ad-data-");
    const first = await start(dataDir);
    const projectId = await newProject(first);
    const task = await newTask(first, projectId, { message: "[slow]" });
    const run = first.store.listRuns(task.id)[0]!;
    await waitFor(() => first.runner.readEvents(run.id).length > 2);
    // Simulate a crash: the database still says running when the next server opens it.
    first.runner.stop(run.id);
    await runFinished(first, run.id);
    first.store.db.prepare("UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?").run(run.id);
    first.store.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await start(dataDir);
    expect(second.store.getRun(run.id)!.status).toBe("interrupted");
    expect(second.store.getTask(task.id)!.status).toBe("interrupted");
    const retry = await api<Run>(second, "POST", `/api/runs/${run.id}/retry`);
    expect(retry.status).toBe(201);
    await second.fastify.inject({ method: "POST", url: `/api/runs/${retry.body.id}/stop`, headers: { host: "127.0.0.1" } });
    await runFinished(second, retry.body.id);
  });
});
