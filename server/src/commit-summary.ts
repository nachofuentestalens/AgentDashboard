export type CommitSummary = { title: string; taskTitle: string };

function title(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120 && !/[\r\n\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}

// Accept only explicit final-reply metadata, never the initial request or progress narration.
export function commitSummary(reply: string): CommitSummary | null {
  const blocks = [...reply.matchAll(/^(`{3,}|~{3,})commit-summary[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm)];
  try {
    const value = JSON.parse(blocks.at(-1)?.[2] ?? "null");
    const runTitle = title(value?.title);
    const taskTitle = title(value?.taskTitle);
    return runTitle && taskTitle ? { title: runTitle, taskTitle } : null;
  } catch {
    return null;
  }
}

export function checkpointTitle(message: string): string {
  const summary = /^Task-summary: (.+)$/m.exec(message)?.[1];
  return title(summary) ?? title(message.split(/\r?\n/)[0]) ?? "Save task changes";
}
