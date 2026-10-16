// Shapes the server returns and the web app renders. The database rows map onto these one to one.

// The coding agents the dashboard can run: Claude Code (`claude -p`) or OpenAI's Codex CLI (`codex exec`).
export const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "ChatGPT (Codex)" },
] as const;
export type Provider = (typeof PROVIDERS)[number]["id"];
export const DEFAULT_PROVIDER: Provider = "claude";
export const isProvider = (v: unknown): v is Provider => v === "claude" || v === "codex";

// Every effort any provider knows; each provider accepts a range of them (PROVIDER_EFFORTS).
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const PROVIDER_EFFORTS: Record<Provider, readonly Effort[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export interface ModelOption {
  id: string;
  label: string;
}
export interface ModelCatalog {
  presets: Record<Provider, readonly ModelOption[]>;
  codex: { source: "cli" | "cache" | "unavailable"; checkedAt: string; error: string | null };
}

export const MODEL_PRESETS: Record<Provider, readonly ModelOption[]> = {
  claude: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  codex: [],
};

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT: Effort = "medium";

// An effort the provider accepts: the nearest one when it does not know this one (Codex has no
// "max", Claude no "minimal").
export function effortFor(provider: Provider, effort: Effort): Effort {
  const allowed = PROVIDER_EFFORTS[provider];
  if (allowed.includes(effort)) return effort;
  const i = EFFORT_LEVELS.indexOf(effort);
  return i < EFFORT_LEVELS.indexOf(allowed[0]!) ? allowed[0]! : allowed[allowed.length - 1]!;
}

export interface Choice {
  provider: Provider;
  // Null: the provider's own default (Codex reads it from ~/.codex/config.toml).
  model: string | null;
  effort: Effort;
}

export interface ChoiceLevel {
  provider: Provider | null;
  model: string | null;
  effort: Effort | null;
}

// The provider a model id belongs to: a preset's, else Claude for Claude-looking ids, else Codex.
export function providerOfModel(model: string): Provider {
  for (const p of PROVIDERS) if (MODEL_PRESETS[p.id].some((m) => m.id === model)) return p.id;
  return /^(claude|opus|sonnet|haiku|fable)/i.test(model) ? "claude" : "codex";
}

// What a run uses, from the most specific level (task, role, project) to the least. The first
// level that names a provider (or a model, which implies one) wins. A model only counts for its
// own provider, so a role on Codex never gets the project's Claude model.
export function resolveChoice(levels: ChoiceLevel[]): Choice {
  const own = levels.map((l) => l.provider ?? (l.model ? providerOfModel(l.model) : null));
  const provider = own.find((p) => p !== null) ?? DEFAULT_PROVIDER;
  const model = levels.find((l, i) => l.model && own[i] === provider)?.model ?? (provider === "claude" ? DEFAULT_MODEL : null);
  const effort = levels.find((l) => l.effort)?.effort ?? DEFAULT_EFFORT;
  return { provider, model, effort: effortFor(provider, effort) };
}

// Commands a writing agent may run without asking. Edits are allowed by acceptEdits mode.
export const DEFAULT_ALLOWED_TOOLS = ["Bash(git:*)", "Bash(pnpm:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "PowerShell"];

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultProvider: Provider;
  // Empty: the provider's default model.
  defaultModel: string;
  defaultEffort: Effort;
  allowedTools: string[];
  // Task stage automation, all off by default (docs/TASK_STATES.md). The owner still approves.
  autoReview: boolean;
  // 0: off. Else how many steps in a row may continue after a passed agent review.
  autoContinueSteps: number;
  startNextWhenIdle: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TaskKind = "chat" | "workflow";
// idle: waiting for the next message; queued: a run waits for the scheduler; running: an agent is
// working; waiting: the agent asked the owner a question; done: the owner marked a plain chat done
// (role tasks use stage "closed" instead); failed/interrupted: the last run did not finish and can be retried.
export type TaskStatus = "idle" | "queued" | "running" | "waiting" | "done" | "failed" | "interrupted";

// Progress through a role task's work, independent of TaskStatus (which activity is happening
// right now). Null for plain chats, which have no stage. See docs/TASK_STATES.md.
export type TaskStage = "backlog" | "in_progress" | "needs_review" | "in_review" | "changes_requested" | "approved" | "closed";

export type StepState = "done" | "partial" | "complete";

// One step of the plan an agent gave for its task.
export interface TaskStep {
  id: string;
  taskId: string;
  ord: number;
  title: string;
  state: "pending" | "active" | "done";
  summary: string | null;
  // The run that finished it.
  runId: string | null;
}

export interface TaskReview {
  id: string;
  taskId: string;
  // The review run, null for the owner's own review.
  runId: string | null;
  // "owner" or a role id.
  reviewer: string;
  verdict: "pass" | "changes" | "approved";
  findings: string[];
  createdAt: string;
}

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 10;
export const DEFAULT_PRIORITY = 5;
// Tasks an agent creates may be created by a task an agent created, and so on, up to this depth.
// Deeper requests always wait for the owner, so agents cannot keep each other busy forever.
export const MAX_DELEGATION_DEPTH = 2;

export interface Task {
  handoff: string | null;
  handoffRunId: string | null;
  autoCompact: boolean;
  tokenBudget: number | null;
  toolBudget: number | null;
  id: string;
  projectId: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  // The agent session the conversation continues (Claude Code --resume, Codex `exec resume`).
  // Null until the first run starts.
  sessionId: string | null;
  // Session that has at least one completed turn; only this one can be resumed.
  sessionStarted: boolean;
  // Which provider the session belongs to: switching provider starts a new session.
  sessionProvider: Provider | null;
  canEdit: boolean;
  // Null: the role's, else the project's.
  provider: Provider | null;
  model: string | null;
  effort: Effort | null;
  // Null: a plain chat with the owner, run right away. Otherwise the role's agents work on it in
  // priority order, when the scheduler gives them a slot.
  roleId: string | null;
  // The agent that last worked on it.
  agentId: string | null;
  priority: number;
  // The project does not build or run until this is fixed: it goes first and pauses other work.
  emergency: boolean;
  parentTaskId: string | null;
  depth: number;
  // Null when the owner created it.
  createdByRoleId: string | null;
  // The open question the agent asked, while the status is waiting.
  question: string | null;
  // Null for plain chats (roleId null). Set by the server through stages.ts, never written directly.
  stage: TaskStage | null;
  // Null: the role's default reviewer, else the role itself.
  reviewerRoleId: string | null;
  // What the agent reported in its last step block ("complete": it thinks the whole task is done).
  stepState: StepState | null;
  stepSummary: string | null;
  nextStep: string | null;
  stageChangedAt: string | null;
  // HEAD when the first work run was queued: reviews diff the work against it.
  baseCommit: string | null;
  // Steps continued automatically since the owner last acted, against the project's limit.
  autoContinues: number;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  toolCalls: number;
  // review: a read-only run by the reviewer role, in its own fresh session (docs/TASK_STATES.md).
  purpose: "work" | "handoff" | "review";
  id: string;
  taskId: string;
  messageId: string;
  status: RunStatus;
  provider: Provider;
  // Empty: the provider's default model.
  model: string;
  effort: Effort;
  sessionId: string | null;
  usage: Usage;
  costUsd: number;
  error: string | null;
  // For a queued run, when it was queued; then when it started.
  startedAt: string;
  endedAt: string | null;
  roleId: string | null;
  agentId: string | null;
  departmentId: string | null;
  // Why a queued run has not started yet.
  waitReason: string | null;
  // The owner said "run anyway": budgets and an open emergency do not hold it back.
  forced: boolean;
}

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  text: string;
  // For assistant messages, the run that produced it; for user messages, null.
  runId: string | null;
  createdAt: string;
}

export interface TaskWorkspace {
  taskId: string;
  repoPath: string;
  path: string;
  branch: string;
  baseCommit: string;
  checkpointCommit: string | null;
  checkpointAt: string | null;
  publishedCommit: string | null;
  githubRepo: string | null;
  pullRequestUrl: string | null;
  publishError: string | null;
  mergeCommit: string | null;
  approvedCommit: string | null;
  error: string | null;
}

export interface TaskDetail {
  task: Task;
  messages: Message[];
  runs: Run[];
  usageSummary?: { tokens: number; toolCalls: number; runs: number; unreportedRuns: number };
  // Why new runs are blocked, including limits inherited from parent tasks; null when none is reached.
  checkpoint?: string | null;
  // Owner and agent reviews of a role task, oldest first.
  reviews?: TaskReview[];
  steps?: TaskStep[];
  workspace?: TaskWorkspace | null;
}

export interface TaskSummary extends Task {
  messageCount: number;
  lastMessage: string | null;
  costUsd: number;
  lastReview: Pick<TaskReview, "verdict" | "reviewer"> | null;
  // The agent's plan, when it gave one.
  steps: { done: number; total: number } | null;
}

export interface Settings {
  claudePath: string;
  codexPath: string;
  // Defaults for new projects.
  defaultProvider: Provider;
  defaultModel: string;
  defaultEffort: Effort;
  // Agents that may run at once across all projects. Plain chats always start, but count.
  maxConcurrentRuns: number;
  // Spend over the last 24 hours after which role tasks wait. Null: no limit.
  dailyBudgetUsd: number | null;
}

export const DEFAULT_MAX_CONCURRENT_RUNS = 1;

// ---- studio: departments, roles and the agents staffing them

export type Autonomy = "ask" | "auto";

export interface Department {
  id: string;
  projectId: string;
  name: string;
  color: string;
  // Share of compute relative to the other departments, 1 to 10.
  weight: number;
  dailyBudgetUsd: number | null;
  // Repository folders this department's agents may edit. "." means every folder no other
  // department claims.
  folders: string[];
  // Tasks this department's agents create: wait for the owner (ask) or start right away (auto).
  autonomy: Autonomy;
  sort: number;
  createdAt: string;
}

export interface Role {
  id: string;
  projectId: string;
  departmentId: string;
  name: string;
  // Markdown job description given to every agent of this role.
  brief: string;
  // Null: the project default.
  provider: Provider | null;
  model: string | null;
  effort: Effort | null;
  canEdit: boolean;
  // Null: the project's allowed commands.
  allowedTools: string[] | null;
  // Design documents included in full in every run, not just listed.
  contextDocs: string[];
  // Null: a task reviews with its own role in a fresh session (the default).
  reviewerRoleId: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  roleId: string;
  name: string;
  paused: boolean;
  createdAt: string;
}

export type AgentStatus = "idle" | "running" | "waiting" | "paused";

export interface AgentView extends Agent {
  status: AgentStatus;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  spend24h: number;
}

export interface EffortCost {
  avgUsd: number;
  runs: number;
}

export interface RoleView extends Role {
  agents: AgentView[];
  queued: number;
  spend24h: number;
  costByEffort: Partial<Record<Effort, EffortCost>>;
}

export interface DepartmentView extends Department {
  roles: RoleView[];
  spend24h: number;
  spend7d: number;
  // The run currently editing files for this department, if any.
  writerRunId: string | null;
}

export interface Studio {
  projectId: string;
  departments: DepartmentView[];
  // Open emergency tasks; while any exist, other role tasks in the project wait.
  emergencies: { taskId: string; title: string }[];
}

// ---- design documents, proposals, delegation, feedback

export interface DesignDoc {
  // Repository-relative, forward slashes, under design/.
  path: string;
  title: string;
  summary: string;
  departmentId: string | null;
  updatedAt: string;
  size: number;
}

export interface DocCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface DocDetail {
  doc: DesignDoc;
  content: string;
  history: DocCommit[];
}

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface Proposal {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  roleName: string | null;
  docPath: string;
  rationale: string;
  body: string;
  status: ProposalStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type HandoffStatus = "pending" | "created" | "rejected";

// A task one agent asked for another role.
export interface Handoff {
  id: string;
  projectId: string;
  fromTaskId: string | null;
  fromRoleName: string | null;
  toRoleName: string;
  roleId: string | null;
  title: string;
  prompt: string;
  priority: number;
  emergency: boolean;
  depth: number;
  // Why it waits for the owner instead of starting.
  reason: string | null;
  status: HandoffStatus;
  createdTaskId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type FeedbackStatus = "new" | "triaged" | "done";

export interface FeedbackItem {
  id: string;
  projectId: string;
  source: string;
  text: string;
  status: FeedbackStatus;
  taskId: string | null;
  createdAt: string;
}

export interface InboxQuestion {
  task: Task;
  projectName: string;
}

export interface InboxRun {
  run: Run;
  task: Task;
  projectName: string;
}

export interface Inbox {
  proposals: (Proposal & { projectName: string; current: string | null })[];
  handoffs: (Handoff & { projectName: string })[];
  questions: InboxQuestion[];
  // Role tasks whose finished step waits for the owner, and those with changes to send back.
  reviews: InboxQuestion[];
  changes: InboxQuestion[];
  // Queued runs held back by a budget or an emergency, which the owner can run anyway.
  held: InboxRun[];
  count: number;
}

export interface ComputeRun {
  run: Run;
  taskTitle: string;
  projectId: string;
  projectName: string;
  roleName: string | null;
  agentName: string | null;
  departmentName: string | null;
  priority: number;
  emergency: boolean;
}

export interface ComputeDepartment {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  color: string;
  weight: number;
  dailyBudgetUsd: number | null;
  spend24h: number;
  spend7d: number;
}

export interface Compute {
  maxConcurrentRuns: number;
  dailyBudgetUsd: number | null;
  spend24h: number;
  active: ComputeRun[];
  queued: ComputeRun[];
  departments: ComputeDepartment[];
}

// The result of looking for a provider's CLI and asking its version.
export interface ClaudeCheck {
  ok: boolean;
  command: string | null;
  version: string | null;
  error: string | null;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
