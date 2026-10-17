import type { QuotaWindow, Run, Task, Usage } from "./models.ts";

// Provider-neutral events a run produces. The parser turns Claude's stream-json into these; they are
// stored one per line in the run's JSONL file and pushed live to the browser.
export type AgentEvent =
  | { kind: "init"; sessionId: string; model: string }
  // A message from the model begins; text deltas until the next message_start belong to it.
  | { kind: "message_start" }
  | { kind: "text_delta"; text: string }
  // A complete text block. Replaces whatever deltas streamed for it.
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "result";
      isError: boolean;
      text: string;
      sessionId: string | null;
      costUsd: number;
      usage: Usage;
      durationMs: number;
      numTurns: number;
    }
  // The provider reported a usage limit window (see the coordinator).
  | { kind: "rate_limit"; window: QuotaWindow; usedPercent: number | null; resetsAt: string | null; rejected: boolean }
  | { kind: "stderr"; text: string }
  | { kind: "error"; message: string }
  // Written by the dashboard, not the agent: what it did with the reply (a task created, a
  // proposal sent to the inbox, a block it could not read).
  | { kind: "notice"; level: "info" | "warn"; text: string };

export interface StampedEvent {
  seq: number;
  at: string;
  event: AgentEvent;
}

// Everything the server pushes over the /api/events stream.
export type ServerPush =
  | { type: "run_event"; runId: string; taskId: string; stamped: StampedEvent }
  | { type: "run_updated"; run: Run }
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; taskId: string; projectId: string }
  | { type: "projects_changed" }
  // Departments, roles or agents of a project changed.
  | { type: "studio_changed"; projectId: string }
  | { type: "inbox_changed" }
  | { type: "docs_changed"; projectId: string }
  | { type: "feedback_changed"; projectId: string }
  | { type: "coordinator_changed" };
