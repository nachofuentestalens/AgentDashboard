import { z } from "zod";
import { EFFORT_LEVELS } from "./models.ts";

// Request bodies. The server validates every write with these; the web app reuses them for forms.

// Model ids and tool rules end up as process arguments, so they are restricted to plain tokens.
export const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._\-[\]]{1,64}$/, "Model ids are letters, digits, dots and dashes");
export const effort = z.enum(EFFORT_LEVELS);
export const toolRule = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\([^()"\r\n]{1,120}\))?$/, "Tool rules look like Bash(git:*) or PowerShell");

export const createProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  repoPath: z.string().trim().min(1).max(400),
  initGit: z.boolean().optional(),
});

export const updateProjectBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  repoPath: z.string().trim().min(1).max(400).optional(),
  defaultModel: modelId.optional(),
  defaultEffort: effort.optional(),
  allowedTools: z.array(toolRule).max(50).optional(),
});

export const createTaskBody = z.object({
  title: z.string().trim().max(120).optional(),
  canEdit: z.boolean().optional(),
  // The first message, sent right away when present.
  message: z.string().max(100_000).optional(),
  model: modelId.nullable().optional(),
  effort: effort.nullable().optional(),
});

export const updateTaskBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  canEdit: z.boolean().optional(),
  model: modelId.nullable().optional(),
  effort: effort.nullable().optional(),
});

export const sendMessageBody = z.object({
  text: z.string().trim().min(1).max(100_000),
});

export const updateSettingsBody = z.object({
  claudePath: z.string().trim().max(400).optional(),
  defaultModel: modelId.optional(),
  defaultEffort: effort.optional(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;
export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
