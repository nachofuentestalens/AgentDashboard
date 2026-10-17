import { randomUUID } from "node:crypto";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_EFFORT,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_TASK_TOKEN_BUDGET,
  DEFAULT_TASK_TOOL_BUDGET,
  DEFAULT_MODEL,
  DEFAULT_PRIORITY,
  DEFAULT_PROVIDER,
  EFFORT_LEVELS,
  emptyUsage,
  isProvider,
  taskGitState,
  type Provider,
  type Agent,
  type Autonomy,
  type Department,
  type Effort,
  type EffortCost,
  type FeedbackItem,
  type FeedbackStatus,
  type Handoff,
  type HandoffStatus,
  type Message,
  type MessageRole,
  type Project,
  type ProjectBaseline,
  type DeliveryPlanPreview,
  type Proposal,
  type ProposalStatus,
  type Role,
  type Run,
  type RunStatus,
  type Settings,
  type Task,
  type TaskWorkspace,
  type TaskReview,
  type TaskStage,
  type TaskStep,
  type TaskStatus,
  type TaskSummary,
  type Usage,
} from "@ad/shared";
import { HttpError } from "./http.ts";
import { nextStage } from "./stages.ts";
import { transaction, type Db } from "./db.ts";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const asEffort = (v: unknown): Effort => (EFFORT_LEVELS.includes(v as Effort) ? (v as Effort) : DEFAULT_EFFORT);
const optEffort = (v: unknown): Effort | null => (v == null ? null : asEffort(v));
const optProvider = (v: unknown): Provider | null => (isProvider(v) ? v : null);
const str = (v: unknown): string | null => (v as string | null) ?? null;
const num = (v: unknown): number | null => (v == null ? null : Number(v));
// Unset: the built-in default. An empty string: cleared, meaning unlimited.
const allowance = (v: string | undefined, fallback: number): number | null => (v === undefined ? fallback : v === "" ? null : Number(v));

function parseJson<T>(text: unknown, fallback: T): T {
  try {
    return typeof text === "string" ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Only the given keys of a patch, without the undefined ones, over the current value.
function merge<T extends object>(current: T, patch: Partial<T>): T {
  return { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as T;
}

const toWorkspace = (r: Row): TaskWorkspace => ({
  taskId: String(r.task_id),
  repoPath: String(r.repo_path),
  path: String(r.path),
  branch: String(r.branch),
  baseCommit: String(r.base_commit),
  checkpointCommit: str(r.checkpoint_commit),
  checkpointAt: str(r.checkpoint_at),
  publishedCommit: str(r.published_commit),
  githubRepo: str(r.github_repo),
  pullRequestUrl: str(r.pull_request_url),
  publishError: str(r.publish_error),
  mergeCommit: str(r.merge_commit),
  approvedCommit: str(r.approved_commit),
  error: str(r.error),
});

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  repoPath: r.repo_path as string,
  defaultProvider: optProvider(r.default_provider) ?? DEFAULT_PROVIDER,
  defaultModel: r.default_model as string,
  defaultEffort: asEffort(r.default_effort),
  allowedTools: parseJson<string[]>(r.allowed_tools, []),
  autoReview: r.auto_review === 1,
  autoContinueSteps: Number(r.auto_continue_steps ?? 0),
  startNextWhenIdle: r.start_next_when_idle === 1,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toTask = (r: Row): Task => ({
  dependencyIds: JSON.parse(String(r.dependency_ids ?? "[]")),
  requiredPaths: JSON.parse(String(r.required_paths ?? "[]")),
  handoff: str(r.handoff),
  handoffRunId: str(r.handoff_run_id),
  autoCompact: r.auto_compact === 1,
  tokenBudget: num(r.token_budget),
  toolBudget: num(r.tool_budget),
  id: r.id as string,
  projectId: r.project_id as string,
  kind: r.kind as Task["kind"],
  title: r.title as string,
  status: r.status as TaskStatus,
  sessionId: str(r.session_id),
  sessionStarted: r.session_started === 1,
  sessionProvider: optProvider(r.session_provider),
  canEdit: r.can_edit === 1,
  provider: optProvider(r.provider),
  model: str(r.model),
  effort: optEffort(r.effort),
  roleId: str(r.role_id),
  agentId: str(r.agent_id),
  priority: Number(r.priority ?? DEFAULT_PRIORITY),
  emergency: r.emergency === 1,
  parentTaskId: str(r.parent_task_id),
  depth: Number(r.depth ?? 0),
  createdByRoleId: str(r.created_by_role_id),
  question: str(r.question),
  stage: (r.stage as Task["stage"]) ?? null,
  reviewerRoleId: str(r.reviewer_role_id),
  stepState: (r.step_state as Task["stepState"]) ?? null,
  stepSummary: str(r.step_summary),
  nextStep: str(r.next_step),
  stageChangedAt: str(r.stage_changed_at),
  baseCommit: str(r.base_commit),
  autoContinues: Number(r.auto_continues ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  taskId: r.task_id as string,
  role: r.role as MessageRole,
  text: r.text as string,
  runId: str(r.run_id),
  createdAt: r.created_at as string,
});

const toRun = (r: Row): Run => ({
  toolCalls: Number(r.tool_calls ?? 0),
  purpose: r.purpose === "handoff" || r.purpose === "review" ? r.purpose : "work",
  id: r.id as string,
  taskId: r.task_id as string,
  messageId: r.message_id as string,
  status: r.status as RunStatus,
  provider: optProvider(r.provider) ?? DEFAULT_PROVIDER,
  model: r.model as string,
  effort: asEffort(r.effort),
  sessionId: str(r.session_id),
  usage: parseJson<Usage>(r.usage, emptyUsage()),
  costUsd: Number(r.cost_usd ?? 0),
  error: str(r.error),
  startedAt: r.started_at as string,
  endedAt: str(r.ended_at),
  roleId: str(r.role_id),
  agentId: str(r.agent_id),
  departmentId: str(r.department_id),
  waitReason: str(r.wait_reason),
  forced: r.forced === 1,
});

const toDepartment = (r: Row): Department => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  color: r.color as string,
  weight: Number(r.weight),
  dailyBudgetUsd: num(r.daily_budget_usd),
  folders: parseJson<string[]>(r.folders, []),
  autonomy: (r.autonomy === "auto" ? "auto" : "ask") as Autonomy,
  sort: Number(r.sort),
  createdAt: r.created_at as string,
});

const toRole = (r: Row): Role => ({
  id: r.id as string,
  projectId: r.project_id as string,
  departmentId: r.department_id as string,
  name: r.name as string,
  brief: r.brief as string,
  provider: optProvider(r.provider),
  model: str(r.model),
  effort: optEffort(r.effort),
  canEdit: r.can_edit === 1,
  allowedTools: r.allowed_tools == null ? null : parseJson<string[]>(r.allowed_tools, []),
  contextDocs: parseJson<string[]>(r.context_docs, []),
  reviewerRoleId: str(r.reviewer_role_id),
  sort: Number(r.sort),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toAgent = (r: Row): Agent => ({
  id: r.id as string,
  roleId: r.role_id as string,
  name: r.name as string,
  paused: r.paused === 1,
  createdAt: r.created_at as string,
});

const toProposal = (r: Row): Proposal => ({
  id: r.id as string,
  projectId: r.project_id as string,
  taskId: str(r.task_id),
  runId: str(r.run_id),
  roleName: str(r.role_name),
  docPath: r.doc_path as string,
  rationale: r.rationale as string,
  body: r.body as string,
  status: r.status as ProposalStatus,
  note: str(r.note),
  createdAt: r.created_at as string,
  decidedAt: str(r.decided_at),
});

const toHandoff = (r: Row): Handoff => ({
  dependencyIds: JSON.parse(String(r.dependency_ids ?? "[]")),
  requiredPaths: JSON.parse(String(r.required_paths ?? "[]")),
  id: r.id as string,
  projectId: r.project_id as string,
  fromTaskId: str(r.from_task_id),
  fromRoleName: str(r.from_role_name),
  toRoleName: r.to_role_name as string,
  roleId: str(r.role_id),
  title: r.title as string,
  prompt: r.prompt as string,
  priority: Number(r.priority),
  emergency: r.emergency === 1,
  depth: Number(r.depth),
  reason: str(r.reason),
  status: r.status as HandoffStatus,
  createdTaskId: str(r.created_task_id),
  createdAt: r.created_at as string,
  decidedAt: str(r.decided_at),
});

const toFeedback = (r: Row): FeedbackItem => ({
  id: r.id as string,
  projectId: r.project_id as string,
  source: r.source as string,
  text: r.text as string,
  status: r.status as FeedbackStatus,
  taskId: str(r.task_id),
  createdAt: r.created_at as string,
});

export type TaskPatch = Partial<
  Pick<
    Task,
    | "dependencyIds"
    | "requiredPaths"
    | "title"
    | "status"
    | "sessionId"
    | "sessionStarted"
    | "sessionProvider"
    | "canEdit"
    | "provider"
    | "model"
    | "effort"
    | "agentId"
    | "priority"
    | "emergency"
    | "question"
    | "handoff"
    | "handoffRunId"
    | "autoCompact"
    | "tokenBudget"
    | "toolBudget"
    | "stage"
    | "reviewerRoleId"
    | "stepState"
    | "stepSummary"
    | "nextStep"
    | "stageChangedAt"
    | "baseCommit"
    | "autoContinues"
  >
>;

export interface NewTask {
  dependencyIds?: string[];
  requiredPaths?: string[];
  projectId: string;
  title: string;
  canEdit: boolean;
  provider?: Provider | null;
  model: string | null;
  effort: Effort | null;
  roleId?: string | null;
  priority?: number;
  emergency?: boolean;
  parentTaskId?: string | null;
  depth?: number;
  createdByRoleId?: string | null;
}

// All SQL lives here. Callers get typed objects and never see rows.
export class Store {
  constructor(readonly db: Db) {}

  projectBaseline(projectId: string): ProjectBaseline | null {
    return this.getStateJson<ProjectBaseline>(`baseline.${projectId}`);
  }

  setProjectBaseline(projectId: string, baseline: ProjectBaseline): void {
    this.setStateJson(`baseline.${projectId}`, baseline);
  }

  deliveryPaused(projectId: string): boolean {
    return this.getStateJson<boolean>(`delivery-paused.${projectId}`) === true;
  }

  validateTaskPlan(projectId: string, entries: DeliveryPlanPreview["entries"]): void {
    const tasks = new Map(this.listTasks(projectId).map((t) => [t.id, t]));
    const overrides = new Map(entries.map((e) => [e.taskId, e.dependencyIds]));
    if (overrides.size !== entries.length) throw new HttpError("The plan maps multiple entries to the same task.", 400);
    const done = new Set<string>();
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new HttpError("The imported dependency graph contains a cycle.", 400);
      if (done.has(id)) return;
      const task = tasks.get(id);
      if (!task?.roleId) throw new HttpError("The plan must reference existing role tasks in this project.", 400);
      for (const dependency of overrides.get(id) ?? task.dependencyIds) visit(dependency, new Set(stack).add(id));
      done.add(id);
    };
    for (const entry of entries) visit(entry.taskId, new Set());
  }

  applyTaskPlan(plan: DeliveryPlanPreview): void {
    this.validateTaskPlan(plan.projectId, plan.entries);
    transaction(this.db, () => {
      // Clear only inside this transaction; adding the validated final graph cannot create an intermediate cycle.
      for (const entry of plan.entries) this.db.prepare("UPDATE tasks SET dependency_ids = '[]' WHERE id = ?").run(entry.taskId);
      for (const entry of plan.entries) {
        const task = this.getTask(entry.taskId)!;
        const transition =
          task.stage === entry.toStage
            ? { stage: task.stage }
            : nextStage(task.stage!, entry.toStage === "needs_review" ? "recover_review" : "recover_backlog");
        if (transition.error) throw new HttpError(transition.error, 409);
        this.updateTask(task.id, {
          dependencyIds: entry.dependencyIds,
          requiredPaths: entry.requiredPaths,
          stage: transition.stage,
          status: task.status === "done" ? "idle" : task.status,
          autoContinues: 0,
        });
      }
      this.updateProject(plan.projectId, { startNextWhenIdle: false });
      this.setStateJson(`delivery-paused.${plan.projectId}`, true);
      this.setStateJson(`delivery-plan.${plan.projectId}`, plan);
      this.setStateJson(`delivery-plan-preview.${plan.projectId}`, null);
    });
  }

  // ---- settings

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const budget = map.get("dailyBudgetUsd");
    return {
      claudePath: map.get("claudePath") ?? "",
      codexPath: map.get("codexPath") ?? "",
      defaultProvider: optProvider(map.get("defaultProvider")) ?? DEFAULT_PROVIDER,
      defaultModel: map.get("defaultModel") ?? DEFAULT_MODEL,
      defaultEffort: asEffort(map.get("defaultEffort") ?? DEFAULT_EFFORT),
      maxConcurrentRuns: Number(map.get("maxConcurrentRuns")) || DEFAULT_MAX_CONCURRENT_RUNS,
      dailyBudgetUsd: budget ? Number(budget) : null,
      defaultTokenBudget: allowance(map.get("defaultTokenBudget"), DEFAULT_TASK_TOKEN_BUDGET),
      defaultToolBudget: allowance(map.get("defaultToolBudget"), DEFAULT_TASK_TOOL_BUDGET),
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    transaction(this.db, () => {
      // null clears a limit: stored as an empty string.
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) upsert.run(key, value === null ? "" : String(value));
    });
    return this.getSettings();
  }

  // State the dashboard keeps for itself (the coordinator's config and readings) shares the settings
  // table under its own keys, as JSON. getSettings ignores keys it does not know.
  getStateJson<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ? parseJson<T | null>(row.value, null) : null;
  }

  setStateJson(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
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
        `INSERT INTO projects (id, name, repo_path, default_provider, default_model, default_effort, allowed_tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.repoPath,
        settings.defaultProvider,
        settings.defaultModel,
        settings.defaultEffort,
        JSON.stringify(DEFAULT_ALLOWED_TOOLS),
        at,
        at,
      );
    return this.getProject(id)!;
  }

  updateProject(
    id: string,
    patch: Partial<
      Pick<
        Project,
        "name" | "repoPath" | "defaultProvider" | "defaultModel" | "defaultEffort" | "allowedTools" | "autoReview" | "autoContinueSteps" | "startNextWhenIdle"
      >
    >,
  ): Project | null {
    const current = this.getProject(id);
    if (!current) return null;
    const next = merge(current, patch);
    this.db
      .prepare(
        `UPDATE projects SET name = ?, repo_path = ?, default_provider = ?, default_model = ?, default_effort = ?, allowed_tools = ?, auto_review = ?,
           auto_continue_steps = ?, start_next_when_idle = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.repoPath,
        next.defaultProvider,
        next.defaultModel,
        next.defaultEffort,
        JSON.stringify(next.allowedTools),
        next.autoReview ? 1 : 0,
        next.autoContinueSteps,
        next.startNextWhenIdle ? 1 : 0,
        now(),
        id,
      );
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
           (SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.task_id = t.id) AS cost_usd,
           (SELECT v.verdict || ':' || v.reviewer FROM task_reviews v WHERE v.task_id = t.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS last_review,
           (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS steps_total,
           (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id AND s.state = 'done') AS steps_done
         FROM tasks t WHERE t.project_id = ? ORDER BY t.updated_at DESC`,
      )
      .all(projectId) as Row[];
    const workspaces = new Map(
      (this.db.prepare("SELECT w.* FROM task_workspaces w JOIN tasks t ON t.id = w.task_id WHERE t.project_id = ?").all(projectId) as Row[]).map((r) => [
        String(r.task_id),
        toWorkspace(r),
      ]),
    );
    return rows.map((r) => ({
      ...toTask(r),
      messageCount: Number(r.message_count),
      lastMessage: str(r.last_message),
      costUsd: Number(r.cost_usd),
      lastReview: r.last_review
        ? {
            verdict: String(r.last_review).split(":")[0] as TaskReview["verdict"],
            reviewer: String(r.last_review).split(":").slice(1).join(":"),
          }
        : null,
      steps: Number(r.steps_total) > 0 ? { done: Number(r.steps_done), total: Number(r.steps_total) } : null,
      git: taskGitState(workspaces.get(String(r.id)) ?? null),
    }));
  }

  // ---- task steps (an agent's plan)

  listTaskSteps(taskId: string): TaskStep[] {
    const rows = this.db.prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY ord").all(taskId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      ord: Number(r.ord),
      title: r.title as string,
      state: r.state as TaskStep["state"],
      summary: str(r.summary),
      runId: str(r.run_id),
    }));
  }

  // A new plan replaces the steps not done yet; finished ones stay as history.
  replanTask(taskId: string, titles: string[]): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM task_steps WHERE task_id = ? AND state <> 'done'").run(taskId);
      const row = this.db.prepare("SELECT COALESCE(MAX(ord), -1) AS n FROM task_steps WHERE task_id = ?").get(taskId) as Row;
      const insert = this.db.prepare("INSERT INTO task_steps (id, task_id, ord, title, state, summary, run_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)");
      titles.forEach((title, i) => insert.run(randomUUID(), taskId, Number(row.n) + 1 + i, title, i === 0 ? "active" : "pending"));
    });
  }

  // The active step is finished: record it and make the next one active.
  finishActiveStep(taskId: string, summary: string | null, runId: string): void {
    transaction(this.db, () => {
      this.db.prepare("UPDATE task_steps SET state = 'done', summary = ?, run_id = ? WHERE task_id = ? AND state = 'active'").run(summary, runId, taskId);
      const next = this.db.prepare("SELECT id FROM task_steps WHERE task_id = ? AND state = 'pending' ORDER BY ord LIMIT 1").get(taskId) as Row | undefined;
      if (next) this.db.prepare("UPDATE task_steps SET state = 'active' WHERE id = ?").run(next.id as string);
    });
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  getWorkspace(taskId: string): TaskWorkspace | null {
    const r = this.db.prepare("SELECT * FROM task_workspaces WHERE task_id = ?").get(taskId) as Row | undefined;
    return r ? toWorkspace(r) : null;
  }

  saveWorkspace(w: TaskWorkspace): void {
    this.db
      .prepare(
        `INSERT INTO task_workspaces (task_id, repo_path, path, branch, base_commit, checkpoint_commit, checkpoint_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET
      checkpoint_commit = excluded.checkpoint_commit, checkpoint_at = excluded.checkpoint_at, error = excluded.error`,
      )
      .run(w.taskId, w.repoPath, w.path, w.branch, w.baseCommit, w.checkpointCommit, w.checkpointAt, w.error);
    this.db
      .prepare(
        "UPDATE task_workspaces SET published_commit = ?, pull_request_url = ?, publish_error = ?, merge_commit = ?, github_repo = ?, approved_commit = ? WHERE task_id = ?",
      )
      .run(w.publishedCommit, w.pullRequestUrl, w.publishError, w.mergeCommit, w.githubRepo, w.approvedCommit, w.taskId);
  }

  createTask(input: NewTask): Task {
    this.validateDependencies(input.projectId, null, input.dependencyIds ?? [], !!input.roleId);
    const id = randomUUID();
    const at = now();
    // Only role tasks get a stage (docs/TASK_STATES.md); plain chats keep it null.
    const stage = input.roleId ? "backlog" : null;
    const settings = this.getSettings();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, kind, title, status, session_id, session_started, can_edit, provider, model, effort, role_id, agent_id, priority,
           emergency, parent_task_id, depth, created_by_role_id, question, stage, stage_changed_at, created_at, updated_at, token_budget, tool_budget)
         VALUES (?, ?, 'chat', ?, 'idle', NULL, 0, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.canEdit ? 1 : 0,
        input.provider ?? null,
        input.model,
        input.effort,
        input.roleId ?? null,
        input.priority ?? DEFAULT_PRIORITY,
        input.emergency ? 1 : 0,
        input.parentTaskId ?? null,
        input.depth ?? 0,
        input.createdByRoleId ?? null,
        stage,
        stage ? at : null,
        at,
        at,
        settings.defaultTokenBudget,
        settings.defaultToolBudget,
      );
    this.db
      .prepare("UPDATE tasks SET dependency_ids = ?, required_paths = ? WHERE id = ?")
      .run(JSON.stringify(input.dependencyIds ?? []), JSON.stringify(input.requiredPaths ?? []), id);
    return this.getTask(id)!;
  }

  updateTask(id: string, patch: TaskPatch): Task | null {
    const current = this.getTask(id);
    if (!current) return null;
    if (patch.dependencyIds) this.validateDependencies(current.projectId, id, patch.dependencyIds, !!current.roleId);
    const next = merge(current, patch);
    // stage_changed_at tracks the stage itself, not every field update, so the UI can show how
    // long a task has sat in its current stage.
    const stageChangedAt = patch.stage !== undefined && patch.stage !== current.stage ? now() : next.stageChangedAt;
    if (patch.stage !== undefined && patch.stage !== current.stage) {
      // Reopening or dropping work must not revive a historical approval.
      if (patch.stage !== "closed") this.db.prepare("UPDATE tasks SET dependency_approved = ? WHERE id = ?").run(patch.stage === "approved" ? 1 : 0, id);
      else if (current.stage !== "approved") this.db.prepare("UPDATE tasks SET dependency_approved = 0 WHERE id = ?").run(id);
    }
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, status = ?, session_id = ?, session_started = ?, session_provider = ?, can_edit = ?, provider = ?, model = ?, effort = ?,
           agent_id = ?, priority = ?, emergency = ?, question = ?, handoff = ?, handoff_run_id = ?, auto_compact = ?, token_budget = ?, tool_budget = ?,
           stage = ?, reviewer_role_id = ?, step_state = ?, step_summary = ?, next_step = ?, stage_changed_at = ?, base_commit = ?, auto_continues = ?,
           dependency_ids = ?, required_paths = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.status,
        next.sessionId,
        next.sessionStarted ? 1 : 0,
        next.sessionProvider,
        next.canEdit ? 1 : 0,
        next.provider,
        next.model,
        next.effort,
        next.agentId,
        next.priority,
        next.emergency ? 1 : 0,
        next.question,
        next.handoff,
        next.handoffRunId,
        next.autoCompact ? 1 : 0,
        next.tokenBudget,
        next.toolBudget,
        next.stage,
        next.reviewerRoleId,
        next.stepState,
        next.stepSummary,
        next.nextStep,
        stageChangedAt,
        next.baseCommit,
        next.autoContinues,
        JSON.stringify(next.dependencyIds),
        JSON.stringify(next.requiredPaths),
        now(),
        id,
      );
    return this.getTask(id);
  }

  // Failure recovery must not depend on every optional task column being writable.
  setTaskStatus(id: string, status: Task["status"]): Task | null {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    return this.getTask(id);
  }

  validateDependencies(projectId: string, taskId: string | null, ids: string[], roleTask = true): void {
    if (!roleTask && ids.length) throw new HttpError("Only role tasks can have dependencies.", 400);
    if (new Set(ids).size !== ids.length) throw new HttpError("Duplicate dependencies are not allowed.", 400);
    const visit = (id: string, seen: Set<string>) => {
      if (id === taskId) throw new HttpError("Task dependencies cannot form a cycle.", 400);
      if (seen.has(id)) return;
      seen.add(id);
      const task = this.getTask(id);
      if (!task || task.projectId !== projectId || !task.roleId) throw new HttpError("Dependencies must be existing role tasks in this project.", 400);
      for (const parent of task.dependencyIds) visit(parent, seen);
    };
    for (const id of ids) visit(id, new Set());
  }

  taskApproved(task: Task): boolean {
    return (
      (task.stage === "approved" || task.stage === "closed") &&
      task.status !== "running" &&
      task.status !== "queued" &&
      this.db.prepare("SELECT dependency_approved FROM tasks WHERE id = ?").get(task.id)?.dependency_approved === 1
    );
  }

  dependencyBlocker(task: Task, ancestors = new Set<string>()): string | null {
    if (ancestors.has(task.id)) return "Dependency: cycle detected; repair the prerequisite graph.";
    const visited = new Set(ancestors).add(task.id);
    for (const id of task.dependencyIds) {
      const prerequisite = this.getTask(id);
      if (!prerequisite || prerequisite.projectId !== task.projectId) return "Dependency: prerequisite is missing: " + id;
      const accepted = this.taskApproved(prerequisite);
      if (!accepted || prerequisite.status === "running" || prerequisite.status === "queued")
        return "Dependency: waiting for owner approval of " + prerequisite.title;
      if (prerequisite.stepState === "done" && prerequisite.nextStep) return "Dependency: remaining steps must finish in " + prerequisite.title;
      const upstream = this.dependencyBlocker(prerequisite, visited);
      if (upstream) return upstream;
      const workspace = this.getWorkspace(id);
      if (workspace && (workspace.error || !workspace.approvedCommit || workspace.approvedCommit !== workspace.checkpointCommit))
        return "Dependency: waiting for approval of the current checkpoint of " + prerequisite.title;
    }
    return null;
  }

  deleteTask(id: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }

  // Emergencies whose agent has not finished a step yet. Failed or stopped ones still hold the
  // project; one waiting for the owner's review no longer does.
  openEmergencies(projectId?: string): Task[] {
    const open = `emergency = 1 AND status <> 'done' AND COALESCE(stage, '') NOT IN ('needs_review', 'in_review', 'approved', 'closed')`;
    const rows = projectId
      ? this.db.prepare(`SELECT * FROM tasks WHERE ${open} AND project_id = ? ORDER BY created_at`).all(projectId)
      : this.db.prepare(`SELECT * FROM tasks WHERE ${open} ORDER BY created_at`).all();
    return (rows as Row[]).map(toTask);
  }

  // Delegated work under a task that the owner has not approved or closed yet.
  openChildTasks(taskId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE parent_task_id = ? AND CASE WHEN stage IS NULL THEN status <> 'done' ELSE stage NOT IN ('approved', 'closed') END
         ORDER BY created_at`,
      )
      .all(taskId) as Row[];
    return rows.map(toTask);
  }

  addTaskReview(input: Omit<TaskReview, "id" | "createdAt">): TaskReview {
    const review: TaskReview = { ...input, id: randomUUID(), createdAt: now() };
    this.db
      .prepare("INSERT INTO task_reviews (id, task_id, run_id, reviewer, verdict, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(review.id, review.taskId, review.runId, review.reviewer, review.verdict, JSON.stringify(review.findings), review.createdAt);
    return review;
  }

  listTaskReviews(taskId: string): TaskReview[] {
    const rows = this.db.prepare("SELECT * FROM task_reviews WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      runId: str(r.run_id),
      reviewer: r.reviewer as string,
      verdict: r.verdict as TaskReview["verdict"],
      findings: parseJson<string[]>(r.findings, []),
      createdAt: r.created_at as string,
    }));
  }

  waitingTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = 'waiting' ORDER BY updated_at").all() as Row[]).map(toTask);
  }

  // Role tasks waiting to start, in the order the board's "Up next" shows them.
  backlogTasks(projectId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ? AND stage = 'backlog' AND role_id IS NOT NULL AND status NOT IN ('running', 'queued')
         ORDER BY emergency DESC, priority DESC, created_at`,
      )
      .all(projectId);
    return (rows as Row[]).map(toTask);
  }

  // Oldest first: the work that has waited longest for the owner comes up first.
  tasksInStage(stage: TaskStage): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE stage = ? AND status NOT IN ('running', 'queued') ORDER BY stage_changed_at").all(stage);
    return (rows as Row[]).map(toTask);
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

  taskTreeRuns(taskId: string): Run[] {
    return (
      this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id = ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id
    ) SELECT r.* FROM runs r JOIN tree ON r.task_id = tree.id`,
        )
        .all(taskId) as Row[]
    ).map(toRun);
  }

  runsNeedingToolCounts(): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE tool_calls < 0").all() as Row[]).map(toRun);
  }

  setRunPurpose(id: string, purpose: Run["purpose"]): void {
    this.db.prepare("UPDATE runs SET purpose = ? WHERE id = ?").run(purpose, id);
  }

  setToolCalls(id: string, count: number): void {
    this.db.prepare("UPDATE runs SET tool_calls = ? WHERE id = ?").run(count, id);
  }

  listRuns(taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  runsWithStatus(status: RunStatus): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at, rowid").all(status) as Row[]).map(toRun);
  }

  // A plain chat's run starts at once (running); a role task's run waits for the scheduler (queued).
  // prompt: what to send instead of the message text, e.g. for a retry.
  createRun(input: {
    taskId: string;
    messageId: string;
    provider: Provider;
    model: string;
    effort: Effort;
    sessionId: string | null;
    status: "queued" | "running";
    roleId?: string | null;
    departmentId?: string | null;
    prompt?: string | null;
  }): Run {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, message_id, status, provider, model, effort, session_id, usage, cost_usd, error, started_at, ended_at, role_id,
           agent_id, department_id, wait_reason, forced, prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, NULL, ?, NULL, 0, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.messageId,
        input.status,
        input.provider,
        input.model,
        input.effort,
        input.sessionId,
        JSON.stringify(emptyUsage()),
        now(),
        input.roleId ?? null,
        input.departmentId ?? null,
        input.prompt ?? null,
      );
    return this.getRun(id)!;
  }

  runPrompt(id: string): string | null {
    const row = this.db.prepare("SELECT prompt FROM runs WHERE id = ?").get(id) as Row | undefined;
    return str(row?.prompt);
  }

  // A queued run leaves the queue: what it runs with is decided now, not when it was queued.
  startRun(
    id: string,
    input: { provider: Provider; model: string; effort: Effort; sessionId: string | null; agentId: string | null; departmentId: string | null },
  ): Run | null {
    this.db
      .prepare(
        `UPDATE runs SET status = 'running', provider = ?, model = ?, effort = ?, session_id = ?, agent_id = ?, department_id = ?, wait_reason = NULL,
           started_at = ? WHERE id = ?`,
      )
      .run(input.provider, input.model, input.effort, input.sessionId, input.agentId, input.departmentId, now(), id);
    return this.getRun(id);
  }

  setWaitReason(id: string, reason: string | null): Run | null {
    this.db.prepare("UPDATE runs SET wait_reason = ? WHERE id = ? AND status = 'queued'").run(reason, id);
    return this.getRun(id);
  }

  forceRun(id: string): Run | null {
    this.db.prepare("UPDATE runs SET forced = 1 WHERE id = ? AND status = 'queued'").run(id);
    return this.getRun(id);
  }

  finishRun(id: string, outcome: { status: RunStatus; usage?: Usage; costUsd?: number; error?: string | null; sessionId?: string | null }): Run | null {
    const current = this.getRun(id);
    if (!current) return null;
    this.db
      .prepare("UPDATE runs SET status = ?, usage = ?, cost_usd = ?, error = ?, session_id = ?, wait_reason = NULL, ended_at = ? WHERE id = ?")
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

  // A server that stopped while agents were running left those runs without an outcome. Queued
  // runs never started, so they stay in the queue.
  markInterrupted(): { runs: number; tasks: number } {
    return transaction(this.db, () => {
      const runs = this.db
        .prepare("UPDATE runs SET status = 'interrupted', error = 'The server stopped while this run was active.', ended_at = ? WHERE status = 'running'")
        .run(now()).changes;
      // A review cut short gives no verdict: the work goes back to the owner (stages.ts review_cancel).
      this.db.prepare("UPDATE tasks SET stage = 'needs_review', stage_changed_at = ? WHERE status = 'running' AND stage = 'in_review'").run(now());
      const tasks = this.db.prepare("UPDATE tasks SET status = 'interrupted' WHERE status = 'running'").run().changes;
      return { runs: Number(runs), tasks: Number(tasks) };
    });
  }

  // ---- spend

  // Cost of runs that ended since the given time, per department (runs without one are left out).
  departmentSpendSince(since: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT department_id, SUM(cost_usd) AS total FROM runs WHERE department_id IS NOT NULL AND ended_at >= ? GROUP BY department_id")
      .all(since) as Row[];
    return new Map(rows.map((r) => [r.department_id as string, Number(r.total)]));
  }

  roleSpendSince(since: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT role_id, SUM(cost_usd) AS total FROM runs WHERE role_id IS NOT NULL AND ended_at >= ? GROUP BY role_id")
      .all(since) as Row[];
    return new Map(rows.map((r) => [r.role_id as string, Number(r.total)]));
  }

  agentSpendSince(since: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT agent_id, SUM(cost_usd) AS total FROM runs WHERE agent_id IS NOT NULL AND ended_at >= ? GROUP BY agent_id")
      .all(since) as Row[];
    return new Map(rows.map((r) => [r.agent_id as string, Number(r.total)]));
  }

  // Reported tokens (cache included) of runs on a provider that ended since a time.
  providerTokensSince(provider: Provider, since: string): number {
    const rows = this.db.prepare("SELECT usage FROM runs WHERE provider = ? AND ended_at >= ?").all(provider, since) as Row[];
    return rows.reduce((n, r) => {
      const u = parseJson<Usage>(r.usage, emptyUsage());
      return n + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    }, 0);
  }

  totalSpendSince(since: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE ended_at >= ?").get(since) as Row;
    return Number(row.total);
  }

  // Average cost of a finished run per role and effort: the basis for cost estimates.
  costByRoleEffort(): Map<string, Partial<Record<Effort, EffortCost>>> {
    const rows = this.db
      .prepare(
        "SELECT role_id, effort, AVG(cost_usd) AS avg, COUNT(*) AS n FROM runs WHERE role_id IS NOT NULL AND status = 'succeeded' GROUP BY role_id, effort",
      )
      .all() as Row[];
    const out = new Map<string, Partial<Record<Effort, EffortCost>>>();
    for (const r of rows) {
      const entry = out.get(r.role_id as string) ?? {};
      entry[asEffort(r.effort)] = { avgUsd: Number(r.avg), runs: Number(r.n) };
      out.set(r.role_id as string, entry);
    }
    return out;
  }

  // ---- departments

  listDepartments(projectId?: string): Department[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM departments WHERE project_id = ? ORDER BY sort, created_at").all(projectId)
      : this.db.prepare("SELECT * FROM departments ORDER BY project_id, sort, created_at").all();
    return (rows as Row[]).map(toDepartment);
  }

  getDepartment(id: string): Department | null {
    const row = this.db.prepare("SELECT * FROM departments WHERE id = ?").get(id) as Row | undefined;
    return row ? toDepartment(row) : null;
  }

  createDepartment(input: Omit<Department, "id" | "sort" | "createdAt">): Department {
    const id = randomUUID();
    const sort = this.db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM departments WHERE project_id = ?").get(input.projectId) as Row;
    this.db
      .prepare(
        "INSERT INTO departments (id, project_id, name, color, weight, daily_budget_usd, folders, autonomy, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.projectId,
        input.name,
        input.color,
        input.weight,
        input.dailyBudgetUsd,
        JSON.stringify(input.folders),
        input.autonomy,
        Number(sort.n),
        now(),
      );
    return this.getDepartment(id)!;
  }

  updateDepartment(id: string, patch: Partial<Pick<Department, "name" | "color" | "weight" | "dailyBudgetUsd" | "folders" | "autonomy">>): Department | null {
    const current = this.getDepartment(id);
    if (!current) return null;
    const next = merge(current, patch);
    this.db
      .prepare("UPDATE departments SET name = ?, color = ?, weight = ?, daily_budget_usd = ?, folders = ?, autonomy = ? WHERE id = ?")
      .run(next.name, next.color, next.weight, next.dailyBudgetUsd, JSON.stringify(next.folders), next.autonomy, id);
    return this.getDepartment(id);
  }

  deleteDepartment(id: string): boolean {
    return this.db.prepare("DELETE FROM departments WHERE id = ?").run(id).changes > 0;
  }

  // ---- roles

  listRoles(projectId?: string): Role[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM roles WHERE project_id = ? ORDER BY sort, created_at").all(projectId)
      : this.db.prepare("SELECT * FROM roles ORDER BY sort, created_at").all();
    return (rows as Row[]).map(toRole);
  }

  getRole(id: string): Role | null {
    const row = this.db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as Row | undefined;
    return row ? toRole(row) : null;
  }

  findRoleByName(projectId: string, name: string): Role | null {
    const row = this.db.prepare("SELECT * FROM roles WHERE project_id = ? AND name = ? COLLATE NOCASE").get(projectId, name.trim()) as Row | undefined;
    return row ? toRole(row) : null;
  }

  createRole(input: Omit<Role, "id" | "sort" | "createdAt" | "updatedAt" | "reviewerRoleId"> & { reviewerRoleId?: string | null }): Role {
    const id = randomUUID();
    const at = now();
    const sort = this.db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM roles WHERE department_id = ?").get(input.departmentId) as Row;
    this.db
      .prepare(
        `INSERT INTO roles (id, project_id, department_id, name, brief, provider, model, effort, can_edit, allowed_tools, context_docs, reviewer_role_id,
           sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.departmentId,
        input.name,
        input.brief,
        input.provider,
        input.model,
        input.effort,
        input.canEdit ? 1 : 0,
        input.allowedTools === null ? null : JSON.stringify(input.allowedTools),
        JSON.stringify(input.contextDocs),
        input.reviewerRoleId ?? null,
        Number(sort.n),
        at,
        at,
      );
    return this.getRole(id)!;
  }

  updateRole(
    id: string,
    patch: Partial<
      Pick<Role, "departmentId" | "name" | "brief" | "provider" | "model" | "effort" | "canEdit" | "allowedTools" | "contextDocs" | "reviewerRoleId">
    >,
  ): Role | null {
    const current = this.getRole(id);
    if (!current) return null;
    const next = merge(current, patch);
    this.db
      .prepare(
        `UPDATE roles SET department_id = ?, name = ?, brief = ?, provider = ?, model = ?, effort = ?, can_edit = ?, allowed_tools = ?, context_docs = ?,
           reviewer_role_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.departmentId,
        next.name,
        next.brief,
        next.provider,
        next.model,
        next.effort,
        next.canEdit ? 1 : 0,
        next.allowedTools === null ? null : JSON.stringify(next.allowedTools),
        JSON.stringify(next.contextDocs),
        next.reviewerRoleId,
        now(),
        id,
      );
    return this.getRole(id);
  }

  deleteRole(id: string): boolean {
    return this.db.prepare("DELETE FROM roles WHERE id = ?").run(id).changes > 0;
  }

  // ---- agents

  // Archived agents are gone from the studio but keep their name for past runs.
  listAgents(projectId?: string): Agent[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT a.* FROM agents a JOIN roles r ON r.id = a.role_id WHERE r.project_id = ? AND a.archived = 0 ORDER BY a.created_at, a.rowid")
          .all(projectId)
      : this.db.prepare("SELECT * FROM agents WHERE archived = 0 ORDER BY created_at, rowid").all();
    return (rows as Row[]).map(toAgent);
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  agentName(id: string): string | null {
    const row = this.db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as Row | undefined;
    return str(row?.name);
  }

  // Every agent ever hired for the role, archived ones included, so new names do not repeat.
  countAgentsEver(roleId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE role_id = ?").get(roleId) as Row).n);
  }

  createAgent(input: { roleId: string; name: string }): Agent {
    const id = randomUUID();
    this.db.prepare("INSERT INTO agents (id, role_id, name, paused, archived, created_at) VALUES (?, ?, ?, 0, 0, ?)").run(id, input.roleId, input.name, now());
    return this.getAgent(id)!;
  }

  updateAgent(id: string, patch: Partial<Pick<Agent, "name" | "paused">>): Agent | null {
    const current = this.getAgent(id);
    if (!current) return null;
    const next = merge(current, patch);
    this.db.prepare("UPDATE agents SET name = ?, paused = ? WHERE id = ?").run(next.name, next.paused ? 1 : 0, id);
    return this.getAgent(id);
  }

  // An agent with history is archived, so its runs and costs stay attributed; one without is deleted.
  removeAgent(id: string): void {
    const used = this.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? LIMIT 1").get(id);
    if (used) this.db.prepare("UPDATE agents SET archived = 1 WHERE id = ?").run(id);
    else this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ---- proposals

  createProposal(input: {
    projectId: string;
    taskId: string | null;
    runId: string | null;
    roleName: string | null;
    docPath: string;
    rationale: string;
    body: string;
  }): Proposal {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO proposals (id, project_id, task_id, run_id, role_name, doc_path, rationale, body, status, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)",
      )
      .run(id, input.projectId, input.taskId, input.runId, input.roleName, input.docPath, input.rationale, input.body, now());
    return this.getProposal(id)!;
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return row ? toProposal(row) : null;
  }

  pendingProposals(): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at").all() as Row[]).map(toProposal);
  }

  decideProposal(id: string, input: { status: ProposalStatus; body?: string; note?: string | null }): Proposal | null {
    const current = this.getProposal(id);
    if (!current) return null;
    this.db
      .prepare("UPDATE proposals SET status = ?, body = ?, note = ?, decided_at = ? WHERE id = ?")
      .run(input.status, input.body ?? current.body, input.note ?? null, now(), id);
    return this.getProposal(id);
  }

  // ---- handoffs

  createHandoff(input: Omit<Handoff, "id" | "createdAt" | "decidedAt">): Handoff {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO handoffs (id, project_id, from_task_id, from_role_name, to_role_name, role_id, title, prompt, priority, emergency, depth, reason, status,
           created_task_id, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.fromTaskId,
        input.fromRoleName,
        input.toRoleName,
        input.roleId,
        input.title,
        input.prompt,
        input.priority,
        input.emergency ? 1 : 0,
        input.depth,
        input.reason,
        input.status,
        input.createdTaskId,
        now(),
        input.status === "pending" ? null : now(),
      );
    this.db
      .prepare("UPDATE handoffs SET dependency_ids = ?, required_paths = ? WHERE id = ?")
      .run(JSON.stringify(input.dependencyIds ?? []), JSON.stringify(input.requiredPaths ?? []), id);
    return this.getHandoff(id)!;
  }

  getHandoff(id: string): Handoff | null {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
    return row ? toHandoff(row) : null;
  }

  pendingHandoffs(): Handoff[] {
    return (this.db.prepare("SELECT * FROM handoffs WHERE status = 'pending' ORDER BY emergency DESC, priority DESC, created_at").all() as Row[]).map(
      toHandoff,
    );
  }

  decideHandoff(id: string, input: { status: HandoffStatus; createdTaskId?: string | null }): Handoff | null {
    this.db
      .prepare("UPDATE handoffs SET status = ?, created_task_id = ?, decided_at = ? WHERE id = ?")
      .run(input.status, input.createdTaskId ?? null, now(), id);
    return this.getHandoff(id);
  }

  // ---- feedback

  listFeedback(projectId: string): FeedbackItem[] {
    return (this.db.prepare("SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at DESC, rowid DESC").all(projectId) as Row[]).map(toFeedback);
  }

  getFeedback(id: string): FeedbackItem | null {
    const row = this.db.prepare("SELECT * FROM feedback WHERE id = ?").get(id) as Row | undefined;
    return row ? toFeedback(row) : null;
  }

  addFeedback(projectId: string, items: { text: string; source?: string }[]): FeedbackItem[] {
    const insert = this.db.prepare("INSERT INTO feedback (id, project_id, source, text, status, task_id, created_at) VALUES (?, ?, ?, ?, 'new', NULL, ?)");
    const ids = transaction(this.db, () =>
      items.map((item) => {
        const id = randomUUID();
        insert.run(id, projectId, item.source || "pasted", item.text, now());
        return id;
      }),
    );
    return ids.map((id) => this.getFeedback(id)!);
  }

  updateFeedback(id: string, patch: { status?: FeedbackStatus; taskId?: string | null }): FeedbackItem | null {
    const current = this.getFeedback(id);
    if (!current) return null;
    const next = merge(current, patch);
    this.db.prepare("UPDATE feedback SET status = ?, task_id = ? WHERE id = ?").run(next.status, next.taskId, id);
    return this.getFeedback(id);
  }

  deleteFeedback(id: string): boolean {
    return this.db.prepare("DELETE FROM feedback WHERE id = ?").run(id).changes > 0;
  }
}
