import type { Handoff, Proposal, Run, Task } from "./models.ts";

// The inbox steward: an agent that triages a project's inbox before the owner sees it
// (docs/STEWARD.md). These keys name one waiting item; they change when the item does, so a new
// question or a later review is triaged again.

export type StewardItemKind = "question" | "proposal" | "handoff" | "review" | "changes" | "held" | "blocked";

// What the steward may do with each kind of item. Everything else is the owner's.
export const STEWARD_ACTIONS = {
  question: ["answer", "escalate"],
  proposal: ["accept", "reject", "escalate"],
  handoff: ["approve", "reject", "escalate"],
  review: ["continue", "review", "request_changes", "approve", "close", "escalate"],
  changes: ["fix", "escalate"],
  held: ["wait", "escalate"],
  blocked: ["wait", "escalate"],
} as const satisfies Record<StewardItemKind, readonly string[]>;

export type StewardAction = (typeof STEWARD_ACTIONS)[StewardItemKind][number];

// Short and stable, so long questions make short keys. Not for security.
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export const inboxKeys = {
  question: (task: Task) => `question:${task.id}:${shortHash(task.question ?? "")}`,
  review: (task: Task) => `review:${task.id}:${task.stageChangedAt ?? ""}`,
  changes: (task: Task) => `changes:${task.id}:${task.stageChangedAt ?? ""}`,
  proposal: (p: Proposal) => `proposal:${p.id}`,
  handoff: (h: Handoff) => `handoff:${h.id}`,
  held: (run: Run) => `held:${run.id}:${shortHash(run.waitReason ?? "")}`,
  blocked: (run: Run) => `blocked:${run.id}:${shortHash(run.waitReason ?? "")}`,
};

export type StewardItemStatus = "triaging" | "handled" | "escalated";

export interface StewardItem {
  projectId: string;
  key: string;
  kind: StewardItemKind;
  title: string;
  // The steward's triage task.
  taskId: string | null;
  status: StewardItemStatus;
  action: StewardAction | null;
  // The steward's reason, shown to the owner on escalated and handled items.
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}
