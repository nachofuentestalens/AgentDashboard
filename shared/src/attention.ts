import type { Inbox, Run } from "./models.ts";

export interface AttentionItem {
  // Stable while the item waits, so the same item is announced once.
  key: string;
  text: string;
  url: string;
}

// Everything in the inbox, as one line each, for notifications.
export function attentionItems(inbox: Inbox): AttentionItem[] {
  return [
    ...inbox.questions.map((q) => ({
      key: `question:${q.task.id}:${q.task.question ?? ""}`,
      text: `Question from "${q.task.title}"`,
      url: `/tasks/${q.task.id}`,
    })),
    ...inbox.reviews.map((r) => ({
      key: `review:${r.task.id}:${r.task.stageChangedAt ?? ""}`,
      text: `"${r.task.title}" is ready for review`,
      url: `/tasks/${r.task.id}`,
    })),
    ...inbox.changes.map((r) => ({
      key: `changes:${r.task.id}:${r.task.stageChangedAt ?? ""}`,
      text: `Changes requested on "${r.task.title}"`,
      url: `/tasks/${r.task.id}`,
    })),
    ...inbox.proposals.map((p) => ({ key: `proposal:${p.id}`, text: `Design proposal for ${p.docPath}`, url: "/inbox" })),
    ...inbox.handoffs.map((h) => ({ key: `handoff:${h.id}`, text: `Task request: "${h.title}" for ${h.toRoleName}`, url: "/inbox" })),
    ...inbox.blocked.map((h) => ({
      key: `blocked:${h.run.id}:${h.run.waitReason ?? ""}`,
      text: `"${h.task.title}" is blocked: ${h.run.waitReason}`,
      url: "/inbox",
    })),
    ...inbox.held.map((h) => ({ key: `held:${h.run.id}`, text: `"${h.task.title}" is held: ${h.run.waitReason ?? "waiting"}`, url: "/inbox" })),
  ];
}

// A finished agent turn is not an inbox item (a chat just waits for the next message), but the
// owner still wants to hear about it. Stopped runs were the owner's own doing.
export function finishedRunAlert(run: Run, title: string): AttentionItem | null {
  if (run.purpose !== "work") return null;
  const url = `/tasks/${run.taskId}`;
  if (run.status === "succeeded") return { key: `finished:${run.id}`, text: `"${title}" finished`, url };
  if (run.status === "failed") return { key: `finished:${run.id}`, text: `"${title}" failed`, url };
  return null;
}

// Items that were not waiting before. The first look (previous null) announces nothing: those
// items were already there when the dashboard opened.
export function newAttention(previous: ReadonlySet<string> | null, items: AttentionItem[]): AttentionItem[] {
  if (previous === null) return [];
  return items.filter((i) => !previous.has(i.key));
}
