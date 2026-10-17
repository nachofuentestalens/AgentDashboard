import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run, Task } from "@ad/shared";
import { buildApp, type App, type AppOptions } from "../src/app.ts";
import { FAKE_CLAUDE } from "../src/claude.ts";
import { FAKE_CODEX } from "../src/codex.ts";

export const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function gitRepo(): string {
  const dir = tempDir("ad-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return fs.realpathSync(dir);
}

export async function testApp(dataDir = tempDir("ad-data-"), extra: Partial<AppOptions> = {}): Promise<App & { dataDir: string }> {
  process.env.FAKE_CLAUDE_DELAY = "2";
  const app = await buildApp({
    ...extra,
    dataDir,
    launchers: {
      claude: { command: process.execPath, prefix: [FAKE_CLAUDE], display: "fake" },
      codex: { command: process.execPath, prefix: [FAKE_CODEX], display: "fake codex" },
    },
  });
  return Object.assign(app, { dataDir });
}

// Every request carries a loopback Host, like the browser would.
export async function api<T = unknown>(
  app: App,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.fastify.inject({
    method,
    url,
    headers: { host: "127.0.0.1:5190", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

// Resolves when the run leaves the running state.
export function runFinished(app: App, runId: string): Promise<Run> {
  const done = app.store.getRun(runId);
  if (done && done.status !== "running") return Promise.resolve(done);
  return new Promise((resolve) => {
    const off = app.bus.subscribe((push) => {
      if (push.type === "run_updated" && push.run.id === runId && push.run.status !== "running") {
        off();
        resolve(push.run);
      }
    });
  });
}

export async function newProject(app: App, repoPath = gitRepo()) {
  const res = await api<{ id: string }>(app, "POST", "/api/projects", { name: "Idle Quest", repoPath });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.id;
}

export async function newTask(app: App, projectId: string, body: Record<string, unknown> = {}) {
  return (await api<Task>(app, "POST", `/api/projects/${projectId}/tasks`, body)).body;
}

// CI's Windows runners are several times slower than a dev machine; waiting longer only costs time on failure.
export const waitFor = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Resolves when the task reaches one of these statuses.
export async function taskReaches(app: App, taskId: string, statuses: Task["status"][], ms = 15_000): Promise<Task> {
  await waitFor(() => statuses.includes(app.store.getTask(taskId)?.status ?? "idle"), ms);
  return app.store.getTask(taskId)!;
}

// A role task's agent finished a step: the task is idle and waits for the owner's review.
export async function stepFinished(app: App, taskId: string, ms = 15_000): Promise<Task> {
  await waitFor(() => {
    const task = app.store.getTask(taskId);
    return task?.status === "idle" && task.stage === "needs_review";
  }, ms);
  return app.store.getTask(taskId)!;
}

export const latestRun = (app: App, taskId: string) => app.store.listRuns(taskId).at(-1)!;

export const reply = (app: App, taskId: string) =>
  app.store
    .listMessages(taskId)
    .filter((m) => m.role === "assistant")
    .at(-1)?.text ?? "";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}
