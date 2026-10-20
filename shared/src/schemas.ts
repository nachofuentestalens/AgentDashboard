import { z } from "zod";
import { EFFORT_LEVELS, MAX_PRIORITY, MIN_PRIORITY, PROVIDERS } from "./models.ts";

// Request bodies. The server validates every write with these; the web app reuses them for forms.

// Model ids and tool rules end up as process arguments, so they are restricted to plain tokens.
export const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._\-[\]]{1,64}$/, "Model ids are letters, digits, dots and dashes");
// A default model may be empty: the provider's own default.
const defaultModel = modelId.or(z.literal(""));
export const effort = z.enum(EFFORT_LEVELS);
export const provider = z.enum(PROVIDERS.map((p) => p.id) as ["claude", "codex"]);
export const modelHoldBody = z.object({ provider, model: defaultModel, paused: z.boolean() });
export const toolRule = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\([^()"\r\n]{1,120}\))?$/, "Tool rules look like Bash(git:*) or PowerShell");

// Department folders become permission rules such as Edit(./src/**), which the CLI splits on
// spaces and commas, so they are plain relative paths. "." means the whole repository.
export const folder = z
  .string()
  .trim()
  .transform(
    (f) =>
      f
        .replace(/\\/g, "/")
        .replace(/^\.\/(?=.)/, "")
        .replace(/\/+$/, "") || ".",
  )
  .refine((f) => f === "." || (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f) && !f.split("/").some((part) => part === ".." || part === ".")), {
    message: "Folders are relative paths like src or design/game, without spaces or ..",
  });

export const priority = z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY);
const money = z.number().min(0).max(100_000);

export const createProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  repoPath: z.string().trim().min(1).max(400),
  initGit: z.boolean().optional(),
});

export const updateProjectBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  repoPath: z.string().trim().min(1).max(400).optional(),
  defaultProvider: provider.optional(),
  defaultModel: defaultModel.optional(),
  defaultEffort: effort.optional(),
  allowedTools: z.array(toolRule).max(50).optional(),
  autoReview: z.boolean().optional(),
  autoContinueSteps: z.number().int().min(0).max(20).optional(),
  startNextWhenIdle: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  automationPaused: z.boolean().optional(),
  inboxSteward: z.boolean().optional(),
});

export const dependencyIds = z.array(z.string().trim().min(1).max(64)).max(100);
export const requiredPaths = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine(
        (p) => !p.includes("\\") && !p.includes(":") && !p.startsWith("/") && p.split("/").every((s) => s && s !== "." && s !== ".."),
        "Use a relative repository path without traversal.",
      ),
  )
  .max(100);

export const createTaskBody = z.object({
  dependencyIds: dependencyIds.optional(),
  requiredPaths: requiredPaths.optional(),
  title: z.string().trim().max(120).optional(),
  canEdit: z.boolean().optional(),
  // The first message, sent right away when present.
  message: z.string().max(100_000).optional(),
  provider: provider.nullable().optional(),
  model: modelId.nullable().optional(),
  effort: effort.nullable().optional(),
  // A role's task: its agents pick it up in priority order. Without one, a plain chat.
  roleId: z.string().max(64).nullable().optional(),
  priority: priority.optional(),
  emergency: z.boolean().optional(),
});

const tokenBudget = z.number().int().min(1).max(1_000_000_000).nullable();
const toolBudget = z.number().int().min(1).max(100_000).nullable();

export const updateTaskBody = z.object({
  dependencyIds: dependencyIds.optional(),
  requiredPaths: requiredPaths.optional(),
  tokenBudget: tokenBudget.optional(),
  toolBudget: toolBudget.optional(),
  autoCompact: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  canEdit: z.boolean().optional(),
  provider: provider.nullable().optional(),
  model: modelId.nullable().optional(),
  effort: effort.nullable().optional(),
  priority: priority.optional(),
  emergency: z.boolean().optional(),
  // A plain chat: true marks it done, false reopens it. A role task: approve and close, or reopen.
  done: z.boolean().optional(),
  // Role tasks only. Null: the role's default reviewer.
  reviewerRoleId: z.string().max(64).nullable().optional(),
});

const actionText = z.string().trim().min(1).max(100_000);

// Owner moves through a role task's stages (docs/TASK_STATES.md). The server decides whether the
// move is allowed (stages.ts).
export const taskActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), text: actionText.optional() }),
  z.object({ action: z.literal("continue"), text: actionText.optional() }),
  z.object({ action: z.literal("request_changes"), text: actionText }),
  z.object({ action: z.literal("fix"), text: actionText.optional() }),
  // roleId: a one-off reviewer instead of the task's or role's configured one.
  z.object({ action: z.literal("review"), roleId: z.string().max(64).optional() }),
  z.object({ action: z.literal("approve"), force: z.boolean().optional() }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("backlog") }),
]);
export type TaskAction = z.infer<typeof taskActionBody>;

export const sendMessageBody = z.object({
  text: z.string().trim().min(1).max(100_000),
});

export const compactTaskBody = z.object({ summary: z.string().trim().min(1).max(6000) });

export const answerBody = z.object({
  text: z.string().trim().min(1).max(100_000),
  // Also append the question and answer to design/decisions.md.
  record: z.boolean().optional(),
});

const runLimit = z.number().int().min(1).max(32);

export const updateSettingsBody = z.object({
  claudePath: z.string().trim().max(400).optional(),
  codexPath: z.string().trim().max(400).optional(),
  defaultProvider: provider.optional(),
  defaultModel: defaultModel.optional(),
  defaultEffort: effort.optional(),
  // Per provider; a provider left out keeps its limit.
  maxConcurrentRuns: z.object({ claude: runLimit.optional(), codex: runLimit.optional() }).strict().optional(),
  dailyBudgetUsd: money.nullable().optional(),
  defaultTokenBudget: tokenBudget.optional(),
  defaultToolBudget: toolBudget.optional(),
});

export const departmentFields = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Colors look like #a78bfa"),
  weight: z.number().int().min(1).max(10),
  dailyBudgetUsd: money.nullable(),
  folders: z.array(folder).min(1).max(20),
  autonomy: z.enum(["ask", "auto"]),
});
export const createDepartmentBody = departmentFields.partial().required({ name: true });
export const updateDepartmentBody = departmentFields.partial();

const docPathSchema = z.string().trim().min(1).max(300);

export const roleFields = z.object({
  departmentId: z.string().max(64),
  name: z.string().trim().min(1).max(60),
  brief: z.string().max(20_000),
  provider: provider.nullable(),
  model: modelId.nullable(),
  effort: effort.nullable(),
  canEdit: z.boolean(),
  allowedTools: z.array(toolRule).max(50).nullable(),
  contextDocs: z.array(docPathSchema).max(10),
  // Null: tasks of this role review with the role itself, in a fresh session.
  reviewerRoleId: z.string().max(64).nullable(),
});
export const createRoleBody = roleFields.partial().required({ departmentId: true, name: true });
export const updateRoleBody = roleFields.partial();

export const hireAgentBody = z.object({ name: z.string().trim().min(1).max(60).optional() });
export const updateAgentBody = z.object({ name: z.string().trim().min(1).max(60).optional(), paused: z.boolean().optional() });

export const saveDocBody = z.object({
  path: docPathSchema,
  content: z.string().max(500_000),
  message: z.string().trim().max(200).optional(),
});

export const acceptProposalBody = z.object({
  // The owner's edited version; absent to accept the agent's text as is.
  body: z.string().max(500_000).optional(),
});
export const rejectBody = z.object({ reason: z.string().trim().max(5000).optional() });

export const approveHandoffBody = z.object({
  roleId: z.string().max(64).optional(),
  priority: priority.optional(),
  emergency: z.boolean().optional(),
});

export const addFeedbackBody = z.object({
  items: z
    .array(z.object({ text: z.string().trim().min(1).max(20_000), source: z.string().trim().max(120).optional() }))
    .min(1)
    .max(500),
});
export const updateFeedbackBody = z.object({ status: z.enum(["new", "triaged", "done"]) });
export const triageFeedbackBody = z.object({
  itemIds: z.array(z.string().max(64)).min(1).max(200),
  roleId: z.string().max(64),
  priority: priority.optional(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;
export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type AnswerBody = z.infer<typeof answerBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
export type CreateDepartmentBody = z.input<typeof createDepartmentBody>;
export type UpdateDepartmentBody = z.input<typeof updateDepartmentBody>;
export type CreateRoleBody = z.infer<typeof createRoleBody>;
export type UpdateRoleBody = z.infer<typeof updateRoleBody>;
export type UpdateAgentBody = z.infer<typeof updateAgentBody>;
export type SaveDocBody = z.infer<typeof saveDocBody>;
export type ApproveHandoffBody = z.infer<typeof approveHandoffBody>;
export type AddFeedbackBody = z.infer<typeof addFeedbackBody>;
export type TriageFeedbackBody = z.infer<typeof triageFeedbackBody>;

const providerPlan = z.object({
  sessionHours: z.number().min(1).max(24),
  weeklyResetDay: z.number().int().min(0).max(6),
  weeklyResetHour: z.number().int().min(0).max(23),
  sessionTokenCap: z.number().int().min(1).max(1e12).nullable(),
  weeklyTokenCap: z.number().int().min(1).max(1e13).nullable(),
});
export const coordinatorConfigBody = z.object({
  mode: z.enum(["off", "advise", "auto"]),
  sessionReservePct: z.number().min(0).max(90),
  weeklyReservePct: z.number().min(0).max(90),
  conserveMarginPct: z.number().min(0).max(50),
  weeklyBurstPct: z.number().min(0).max(100),
  conservePriority: z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY),
  pauseRunning: z.boolean(),
  resumePaused: z.boolean(),
  fillIdle: z.boolean(),
  switchProvider: z.boolean(),
  plans: z.object({ claude: providerPlan, codex: providerPlan }),
});
// The owner copies a provider's usage page (Claude's /usage, ChatGPT's Codex usage) into the dashboard.
export const quotaReadingBody = z.object({
  provider,
  window: z.enum(["session", "weekly"]),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
});
export const applyCoordinatorBody = z.object({ key: z.string().min(1).max(200) });
export type CoordinatorConfigBody = z.infer<typeof coordinatorConfigBody>;
export type QuotaReadingBody = z.infer<typeof quotaReadingBody>;

// The owner dismisses a project health alert the inbox steward escalated.
export const dismissAlertBody = z.object({ key: z.string().trim().min(1).max(300) }).strict();
export type DismissAlertBody = z.infer<typeof dismissAlertBody>;
