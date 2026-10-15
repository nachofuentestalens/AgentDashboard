import { randomUUID } from "node:crypto";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  emptyUsage,
  type Effort,
  type Message,
  type MessageRole,
  type Project,
  type Run,
  type RunStatus,
  type Settings,
  type Task,
  type TaskStatus,
  type TaskSummary,
  type Usage,
} from "@ad/shared";
import { transaction, type Db } from "./db.ts";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const asEffort = (v: unknown): Effort => (EFFORT_LEVELS.includes(v as Effort) ? (v as Effort) : DEFAULT_EFFORT);

function parseJson<T>(text: unknown, fallback: T): T {
  try {
    return typeof text === "string" ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  repoPath: r.repo_path as string,
  defaultModel: r.default_model as string,
  defaultEffort: asEffort(r.default_effort),
  allowedTools: parseJson<string[]>(r.allowed_tools, []),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toTask = (r: Row): Task => ({
  id: r.id as string,
  projectId: r.project_id as string,
  kind: r.kind as Task["kind"],
  title: r.title as string,
  status: r.status as TaskStatus,
  sessionId: (r.session_id as string | null) ?? null,
  sessionStarted: r.session_started === 1,
  canEdit: r.can_edit === 1,
  model: (r.model as string | null) ?? null,
  effort: r.effort == null ? null : asEffort(r.effort),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  taskId: r.task_id as string,
  role: r.role as MessageRole,
  text: r.text as string,
  runId: (r.run_id as string | null) ?? null,
  createdAt: r.created_at as string,
});

const toRun = (r: Row): Run => ({
  id: r.id as string,
  taskId: r.task_id as string,
  messageId: r.message_id as string,
  status: r.status as RunStatus,
  model: r.model as string,
  effort: asEffort(r.effort),
  sessionId: (r.session_id as string | null) ?? null,
  usage: parseJson<Usage>(r.usage, emptyUsage()),
  costUsd: Number(r.cost_usd ?? 0),
  error: (r.error as string | null) ?? null,
  startedAt: r.started_at as string,
  endedAt: (r.ended_at as string | null) ?? null,
});

// All SQL lives here. Callers get typed objects and never see rows.
export class Store {
  constructor(readonly db: Db) {}

  // ---- settings

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      claudePath: map.get("claudePath") ?? "",
      defaultModel: map.get("defaultModel") ?? DEFAULT_MODEL,
      defaultEffort: asEffort(map.get("defaultEffort") ?? DEFAULT_EFFORT),
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    transaction(this.db, () => {
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) upsert.run(key, String(value));
    });
    return this.getSettings();
  }

  // ---- projects

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as Row[]).map(toProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  createProject(input: { name: string; repoPath: string }): Project {
    const settings = this.getSettings();
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(
        "INSERT INTO projects (id, name, repo_path, default_model, default_effort, allowed_tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.repoPath, settings.defaultModel, settings.defaultEffort, JSON.stringify(DEFAULT_ALLOWED_TOOLS), at, at);
    return this.getProject(id)!;
  }

  updateProject(id: string, patch: Partial<Pick<Project, "name" | "repoPath" | "defaultModel" | "defaultEffort" | "allowedTools">>): Project | null {
    const current = this.getProject(id);
    if (!current) return null;
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Project;
    this.db
      .prepare("UPDATE projects SET name = ?, repo_path = ?, default_model = ?, default_effort = ?, allowed_tools = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.repoPath, next.defaultModel, next.defaultEffort, JSON.stringify(next.allowedTools), now(), id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // ---- tasks

  listTasks(projectId: string): TaskSummary[] {
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) AS message_count,
           (SELECT m.text FROM messages m WHERE m.task_id = t.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message,
           (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.task_id = t.id) AS cost_usd
         FROM tasks t WHERE t.project_id = ? ORDER BY t.updated_at DESC`,
      )
      .all(projectId) as Row[];
    return rows.map((r) => ({
      ...toTask(r),
      messageCount: Number(r.message_count),
      lastMessage: (r.last_message as string | null) ?? null,
      costUsd: Number(r.cost_usd),
    }));
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  createTask(input: { projectId: string; title: string; canEdit: boolean; model: string | null; effort: Effort | null }): Task {
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, project_id, kind, title, status, session_id, session_started, can_edit, model, effort, created_at, updated_at) VALUES (?, ?, 'chat', ?, 'idle', NULL, 0, ?, ?, ?, ?, ?)",
      )
      .run(id, input.projectId, input.title, input.canEdit ? 1 : 0, input.model, input.effort, at, at);
    return this.getTask(id)!;
  }

  updateTask(id: string, patch: Partial<Pick<Task, "title" | "status" | "sessionId" | "sessionStarted" | "canEdit" | "model" | "effort">>): Task | null {
    const current = this.getTask(id);
    if (!current) return null;
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Task;
    this.db
      .prepare("UPDATE tasks SET title = ?, status = ?, session_id = ?, session_started = ?, can_edit = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.status, next.sessionId, next.sessionStarted ? 1 : 0, next.canEdit ? 1 : 0, next.model, next.effort, now(), id);
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }

  // ---- messages

  listMessages(taskId: string): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[]).map(toMessage);
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  addMessage(input: { taskId: string; role: MessageRole; text: string; runId: string | null }): Message {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages (id, task_id, role, text, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.taskId, input.role, input.text, input.runId, now());
    return this.getMessage(id)!;
  }

  // ---- runs

  listRuns(taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  createRun(input: { taskId: string; messageId: string; model: string; effort: Effort; sessionId: string }): Run {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs (id, task_id, message_id, status, model, effort, session_id, usage, cost_usd, error, started_at, ended_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0, NULL, ?, NULL)",
      )
      .run(id, input.taskId, input.messageId, input.model, input.effort, input.sessionId, JSON.stringify(emptyUsage()), now());
    return this.getRun(id)!;
  }

  finishRun(id: string, outcome: { status: RunStatus; usage?: Usage; costUsd?: number; error?: string | null; sessionId?: string | null }): Run | null {
    const current = this.getRun(id);
    if (!current) return null;
    this.db
      .prepare("UPDATE runs SET status = ?, usage = ?, cost_usd = ?, error = ?, session_id = ?, ended_at = ? WHERE id = ?")
      .run(
        outcome.status,
        JSON.stringify(outcome.usage ?? current.usage),
        outcome.costUsd ?? current.costUsd,
        outcome.error ?? null,
        outcome.sessionId ?? current.sessionId,
        now(),
        id,
      );
    return this.getRun(id);
  }

  // A server that stopped while agents were running left those runs without an outcome.
  markInterrupted(): { runs: number; tasks: number } {
    return transaction(this.db, () => {
      const runs = this.db
        .prepare("UPDATE runs SET status = 'interrupted', error = 'The server stopped while this run was active.', ended_at = ? WHERE status = 'running'")
        .run(now()).changes;
      const tasks = this.db.prepare("UPDATE tasks SET status = 'interrupted' WHERE status = 'running'").run().changes;
      return { runs: Number(runs), tasks: Number(tasks) };
    });
  }
}
