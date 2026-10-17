import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  createProjectBody,
  compactTaskBody,
  createTaskBody,
  sendMessageBody,
  updateProjectBody,
  updateSettingsBody,
  updateTaskBody,
  taskActionBody,
  type Provider,
  type ServerPush,
  type TaskDetail,
  type TaskStage,
} from "@ad/shared";
import { Bus } from "./bus.ts";
import { checkCli, type Launcher } from "./claude.ts";
import { CODEX_CLI } from "./codex.ts";
import { loadModelCatalog } from "./model-catalog.ts";
import { openDb } from "./db.ts";
import { checkRepo, initRepo } from "./git.ts";
import { HttpError, parse } from "./http.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";
import { Studio } from "./studio.ts";
import { registerStudioRoutes } from "./studio-routes.ts";
import { Coordinator, registerCoordinatorRoutes } from "./coordination.ts";
import type { UsageFetcher } from "./usage.ts";

export interface AppOptions {
  dataDir: string;
  // Built web app to serve; absent in dev, where Vite serves it and proxies /api here.
  webDir?: string;
  // Tests start fake agents instead of the CLIs Settings point at.
  launchers?: Partial<Record<Provider, Launcher>>;
  logger?: boolean;
  // Reads providers' usage APIs for the coordinator; absent in tests, which never go online.
  usage?: UsageFetcher;
}

export interface App {
  fastify: FastifyInstance;
  store: Store;
  runner: Runner;
  studio: Studio;
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

const titleFrom = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return (line.length > 60 ? `${line.slice(0, 57)}…` : line) || "New chat";
};

export async function buildApp(options: AppOptions): Promise<App> {
  fs.mkdirSync(options.dataDir, { recursive: true });
  const db = openDb(path.join(options.dataDir, "dashboard.db"));
  const store = new Store(db);
  const bus = new Bus();
  const runner = new Runner(store, bus, options.dataDir, options.launchers);
  const studio = new Studio(store, bus, runner);
  const coordinator = new Coordinator(store, bus, runner, Date.now, options.usage ?? null);
  coordinator.startUsagePolling();
  store.markInterrupted();
  const modelCatalog = await loadModelCatalog(options.dataDir, store.getSettings().codexPath, options.launchers?.codex);
  runner.modelOptions = modelCatalog.presets;

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
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({ error: (error as Error).message });
  });

  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found.` });
  const projectsChanged = () => bus.publish({ type: "projects_changed" });

  // ---- settings

  app.get("/api/settings", async () => store.getSettings());
  app.get("/api/models", async () => modelCatalog);

  app.patch("/api/settings", async (request, reply) => {
    const body = parse(updateSettingsBody, request.body, reply);
    if (!body) return;
    const settings = store.updateSettings(body);
    // A higher limit or budget may let queued runs start.
    runner.tick();
    return settings;
  });

  app.post("/api/settings/check-claude", async () => checkCli(store.getSettings().claudePath));
  app.post("/api/settings/check-codex", async () => checkCli(store.getSettings().codexPath, CODEX_CLI));

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
    // Turning on "start next when idle" may start backlog work right away.
    if (body.startNextWhenIdle) runner.tick();
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
    const task = studio.createTask({
      projectId: request.params.id,
      roleId: body.roleId ?? null,
      title: body.title || (body.message ? titleFrom(body.message) : "New chat"),
      message: body.message,
      canEdit: body.canEdit,
      provider: body.provider ?? null,
      model: body.model ?? null,
      effort: body.effort ?? null,
      priority: body.priority,
      emergency: body.emergency,
    });
    // A new backlog task may start at once in a project that starts work when a role is idle.
    runner.tick();
    return reply.code(201).send(task);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, "Task");
    const detail: TaskDetail = {
      task,
      messages: store.listMessages(task.id),
      runs: store.listRuns(task.id),
      usageSummary: runner.usageSummary(task.id),
      checkpoint: runner.budgetReason(task),
      reviews: store.listTaskReviews(task.id),
      steps: store.listTaskSteps(task.id),
      workspace: store.getWorkspace(task.id),
    };
    return detail;
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const body = parse(updateTaskBody, request.body, reply);
    if (!body) return;
    const current = store.getTask(request.params.id);
    if (!current) return notFound(reply, "Task");
    if (
      (current.status === "running" || current.status === "queued") &&
      (body.tokenBudget !== undefined || body.toolBudget !== undefined || body.autoCompact !== undefined)
    )
      return reply.code(409).send({ error: "Wait for the agent or stop it before changing usage controls." });
    const { done, ...patch } = body;
    if (patch.reviewerRoleId !== undefined) {
      if (!current.roleId) return reply.code(400).send({ error: "Only a role's task has a reviewer." });
      if (patch.reviewerRoleId && store.getRole(patch.reviewerRoleId)?.projectId !== current.projectId)
        return reply.code(400).send({ error: "The reviewer must be a role in this project." });
    }
    let status = current.status;
    if (done !== undefined) {
      if (current.status === "running" || current.status === "queued")
        return reply.code(409).send({ error: "Stop the agent before closing or reopening this task." });
      if (current.stage) {
        // Kept for older clients: a role task's done flag maps to the stage actions.
        // Marking finished work done also records the approval; other stages are dropped.
        const closeMoves: Partial<Record<TaskStage, ("approve" | "close")[]>> = { needs_review: ["approve", "close"], closed: [] };
        const moves = done ? (closeMoves[current.stage] ?? ["close"]) : current.stage === "closed" ? ["reopen" as const] : [];
        for (const action of moves) runner.stageAction(current.id, { action });
      } else status = done ? "done" : "idle";
    }
    const task = store.updateTask(current.id, {
      ...patch,
      status,
      // Closing a task answers nothing: the open question goes away with it.
      question: done ? null : undefined,
      // Only a role's task can be an emergency.
      emergency: current.roleId ? patch.emergency : undefined,
    })!;
    bus.publish({ type: "task_updated", task });
    if (patch.priority !== undefined || patch.emergency !== undefined || done !== undefined) {
      bus.publish({ type: "studio_changed", projectId: task.projectId });
      bus.publish({ type: "inbox_changed" });
      runner.tick();
    }
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

  app.post<{ Params: { id: string } }>("/api/tasks/:id/actions", async (request, reply) => {
    const body = parse(taskActionBody, request.body, reply);
    if (!body) return;
    return body.action === "review" ? runner.startReview(request.params.id, body.roleId) : runner.stageAction(request.params.id, body);
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/messages", async (request, reply) => {
    const body = parse(sendMessageBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(runner.send(request.params.id, body.text));
  });

  // ---- runs

  app.post<{ Params: { id: string } }>("/api/tasks/:id/checkpoint", async (request) => runner.checkpointTask(request.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/publish", async (request) => runner.publishWorkspace(request.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/merge", async (request) => runner.mergeWorkspace(request.params.id));

  app.post<{ Params: { id: string } }>("/api/tasks/:id/prepare-handoff", async (request, reply) =>
    reply.code(201).send(runner.prepareHandoff(request.params.id)),
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/compact", async (request, reply) => {
    const body = parse(compactTaskBody, request.body, reply);
    if (!body) return;
    return runner.compact(request.params.id, body.summary);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
    if (!store.getRun(request.params.id)) return notFound(reply, "Run");
    return runner.readEvents(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (request, reply) => {
    if (!runner.stop(request.params.id)) return reply.code(409).send({ error: "That run is not active." });
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/retry", async (request, reply) => reply.code(201).send(await runner.retry(request.params.id)));

  app.post<{ Params: { id: string } }>("/api/runs/:id/force", async (request) => {
    const run = runner.force(request.params.id);
    bus.publish({ type: "inbox_changed" });
    return run;
  });

  registerStudioRoutes(app, { store, bus, runner, studio });
  registerCoordinatorRoutes(app, coordinator);

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

  // Runs queued before a restart are still waiting for their turn.
  runner.tick();

  return {
    fastify: app,
    store,
    runner,
    studio,
    bus,
    close: async () => {
      coordinator.stopUsagePolling();
      runner.close();
      await app.close();
      db.close();
    },
  };
}
