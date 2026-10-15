import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import {
  createProjectBody,
  createTaskBody,
  sendMessageBody,
  updateProjectBody,
  updateSettingsBody,
  updateTaskBody,
  type ServerPush,
  type TaskDetail,
} from "@ad/shared";
import { Bus } from "./bus.ts";
import { checkClaude, type Launcher } from "./claude.ts";
import { openDb } from "./db.ts";
import { checkRepo, initRepo } from "./git.ts";
import { Runner, RunnerError } from "./runner.ts";
import { Store } from "./store.ts";

export interface AppOptions {
  dataDir: string;
  // Built web app to serve; absent in dev, where Vite serves it and proxies /api here.
  webDir?: string;
  launcher?: Launcher;
  logger?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  store: Store;
  runner: Runner;
  bus: Bus;
  close: () => Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  void reply.code(400).send({ error: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  return null;
}

const titleFrom = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return (line.length > 60 ? `${line.slice(0, 57)}…` : line) || "New chat";
};

export async function buildApp(options: AppOptions): Promise<App> {
  fs.mkdirSync(options.dataDir, { recursive: true });
  const db = openDb(path.join(options.dataDir, "dashboard.db"));
  const store = new Store(db);
  const bus = new Bus();
  const runner = new Runner(store, bus, options.dataDir, options.launcher);
  store.markInterrupted();

  const app = Fastify({ logger: options.logger ? { level: "warn" } : false, bodyLimit: 2 * 1024 * 1024 });

  // This server starts processes on the developer's machine and has no login. It listens on
  // loopback only, and here it refuses requests a web page on another site could make: a foreign
  // Host header (DNS rebinding) or a foreign Origin (cross-site form posts and fetches).
  app.addHook("onRequest", async (request, reply) => {
    const host = hostnameOf(request.headers.host ?? "");
    if (!host || !LOOPBACK.has(host)) return reply.code(403).send({ error: "Forbidden host." });
    const origin = request.headers.origin;
    if (origin && !LOOPBACK.has(hostnameOf(origin) ?? "")) return reply.code(403).send({ error: "Forbidden origin." });
  });

  // JSON only: a cross-site HTML form can send text/plain or form data without a preflight.
  app.removeContentTypeParser("text/plain");

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunnerError) return reply.code(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({ error: (error as Error).message });
  });

  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found.` });
  const projectsChanged = () => bus.publish({ type: "projects_changed" });

  // ---- settings

  app.get("/api/settings", async () => store.getSettings());

  app.patch("/api/settings", async (request, reply) => {
    const body = parse(updateSettingsBody, request.body, reply);
    if (!body) return;
    return store.updateSettings(body);
  });

  app.post("/api/settings/check-claude", async () => checkClaude(store.getSettings().claudePath));

  // ---- projects

  app.get("/api/projects", async () => store.listProjects());

  app.post("/api/projects", async (request, reply) => {
    const body = parse(createProjectBody, request.body, reply);
    if (!body) return;
    let repo = await checkRepo(body.repoPath);
    if (!repo.ok && repo.canInit && body.initGit) repo = await initRepo(body.repoPath);
    if (!repo.ok) return reply.code(422).send({ error: repo.error, canInit: repo.canInit });
    const project = store.createProject({ name: body.name, repoPath: repo.path });
    projectsChanged();
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => store.getProject(request.params.id) ?? notFound(reply, "Project"));

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const body = parse(updateProjectBody, request.body, reply);
    if (!body) return;
    if (!store.getProject(request.params.id)) return notFound(reply, "Project");
    if (body.repoPath !== undefined) {
      const repo = await checkRepo(body.repoPath);
      if (!repo.ok) return reply.code(422).send({ error: repo.error, canInit: repo.canInit });
      body.repoPath = repo.path;
    }
    const project = store.updateProject(request.params.id, body);
    projectsChanged();
    return project;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const tasks = store.listTasks(request.params.id);
    if (tasks.some((t) => runner.isTaskRunning(t.id))) return reply.code(409).send({ error: "Stop the running agents in this project first." });
    if (!store.deleteProject(request.params.id)) return notFound(reply, "Project");
    for (const task of tasks) for (const run of store.listRuns(task.id)) fs.rmSync(runner.eventsFile(run.id), { force: true });
    projectsChanged();
    return reply.code(204).send();
  });

  // ---- tasks

  app.get<{ Params: { id: string } }>("/api/projects/:id/tasks", async (request, reply) => {
    if (!store.getProject(request.params.id)) return notFound(reply, "Project");
    return store.listTasks(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/tasks", async (request, reply) => {
    const body = parse(createTaskBody, request.body, reply);
    if (!body) return;
    if (!store.getProject(request.params.id)) return notFound(reply, "Project");
    const task = store.createTask({
      projectId: request.params.id,
      title: body.title || (body.message ? titleFrom(body.message) : "New chat"),
      canEdit: body.canEdit ?? true,
      model: body.model ?? null,
      effort: body.effort ?? null,
    });
    bus.publish({ type: "task_updated", task });
    if (body.message?.trim()) runner.send(task.id, body.message.trim());
    return reply.code(201).send(store.getTask(task.id));
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, "Task");
    const detail: TaskDetail = { task, messages: store.listMessages(task.id), runs: store.listRuns(task.id) };
    return detail;
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const body = parse(updateTaskBody, request.body, reply);
    if (!body) return;
    const task = store.updateTask(request.params.id, body);
    if (!task) return notFound(reply, "Task");
    bus.publish({ type: "task_updated", task });
    return task;
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, "Task");
    if (runner.isTaskRunning(task.id)) return reply.code(409).send({ error: "Stop the agent before deleting this task." });
    const runs = store.listRuns(task.id);
    store.deleteTask(task.id);
    for (const run of runs) fs.rmSync(runner.eventsFile(run.id), { force: true });
    bus.publish({ type: "task_deleted", taskId: task.id, projectId: task.projectId });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (request, reply) => {
    const body = parse(sendMessageBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(runner.send(request.params.id, body.text));
  });

  // ---- runs

  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
    if (!store.getRun(request.params.id)) return notFound(reply, "Run");
    return runner.readEvents(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (request, reply) => {
    if (!runner.stop(request.params.id)) return reply.code(409).send({ error: "That run is not active." });
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/retry", async (request, reply) => reply.code(201).send(runner.retry(request.params.id)));

  // ---- live updates

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const send = (push: ServerPush) => res.write(`data: ${JSON.stringify(push)}\n\n`);
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/health", async () => ({ ok: true, activeRuns: runner.activeCount() }));

  // ---- web app

  if (options.webDir && fs.existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir, wildcard: false });
    // Client-side routes all load the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.method !== "GET") return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }

  return {
    fastify: app,
    store,
    runner,
    bus,
    close: async () => {
      runner.stopAll();
      await app.close();
      db.close();
    },
  };
}
