import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run, Task } from "@ad/shared";
import { buildApp, type App } from "../src/app.ts";
import { FAKE_CLAUDE } from "../src/claude.ts";

export const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function gitRepo(): string {
  const dir = tempDir("ad-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return fs.realpathSync(dir);
}

export async function testApp(dataDir = tempDir("ad-data-")): Promise<App & { dataDir: string }> {
  process.env.FAKE_CLAUDE_DELAY = "2";
  const app = await buildApp({ dataDir, launcher: { command: process.execPath, prefix: [FAKE_CLAUDE], display: "fake" } });
  return Object.assign(app, { dataDir });
}

// Every request carries a loopback Host, like the browser would.
export async function api<T = unknown>(
  app: App,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

export const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};
