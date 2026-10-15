// Shapes the server returns and the web app renders. The database rows map onto these one to one.

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const MODEL_PRESETS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
] as const;

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";

// Commands a writing agent may run without asking. Edits are allowed by acceptEdits mode.
export const DEFAULT_ALLOWED_TOOLS = ["Bash(git:*)", "Bash(pnpm:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "PowerShell"];

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultModel: string;
  defaultEffort: Effort;
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

export type TaskKind = "chat" | "workflow";
// idle: waiting for the next message; running: an agent is working; failed/interrupted: the
// last run did not finish and can be retried.
export type TaskStatus = "idle" | "running" | "failed" | "interrupted";

export interface Task {
  id: string;
  projectId: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  // The Claude Code session the conversation continues with --resume. Null until the first run starts.
  sessionId: string | null;
  // Session that has at least one completed turn; only this one can be resumed.
  sessionStarted: boolean;
  canEdit: boolean;
  model: string | null;
  effort: Effort | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Run {
  id: string;
  taskId: string;
  messageId: string;
  status: RunStatus;
  model: string;
  effort: Effort;
  sessionId: string | null;
  usage: Usage;
  costUsd: number;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
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

export interface TaskDetail {
  task: Task;
  messages: Message[];
  runs: Run[];
}

export interface TaskSummary extends Task {
  messageCount: number;
  lastMessage: string | null;
  costUsd: number;
}

export interface Settings {
  claudePath: string;
  defaultModel: string;
  defaultEffort: Effort;
}

export interface ClaudeCheck {
  ok: boolean;
  command: string | null;
  version: string | null;
  error: string | null;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
