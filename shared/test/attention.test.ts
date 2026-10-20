import { describe, expect, it } from "vitest";
import { attentionItems, finishedRunAlert, newAttention } from "../src/attention.ts";
import type { Inbox, Run, Task } from "../src/models.ts";

const task = (id: string, extra: Partial<Task> = {}) => ({ id, title: `Task ${id}`, question: null, stageChangedAt: "t1", ...extra }) as Task;
const inbox = (parts: Partial<Inbox>): Inbox => ({
  proposals: [],
  handoffs: [],
  questions: [],
  reviews: [],
  changes: [],
  held: [],
  blocked: [],
  alerts: [],
  count: 0,
  ...parts,
});

describe("attention", () => {
  it("lists inbox items with links, and announces only new ones", () => {
    const first = attentionItems(inbox({ reviews: [{ task: task("a"), projectName: "P" }] }));
    expect(first).toEqual([{ key: "review:a:t1", text: '"Task a" is ready for review', url: "/tasks/a" }]);
    // Opening the dashboard announces nothing that was already waiting.
    expect(newAttention(null, first)).toEqual([]);

    const second = attentionItems(
      inbox({
        reviews: [{ task: task("a"), projectName: "P" }],
        questions: [{ task: task("b", { question: "Shields?" }), projectName: "P" }],
      }),
    );
    expect(newAttention(new Set(first.map((i) => i.key)), second).map((i) => i.text)).toEqual(['Question from "Task b"']);

    // The same task needing review again after another step is new again.
    const again = attentionItems(inbox({ reviews: [{ task: task("a", { stageChangedAt: "t2" }), projectName: "P" }] }));
    expect(newAttention(new Set(first.map((i) => i.key)), again)).toHaveLength(1);
  });

  it("announces finished and failed work runs, not stopped or review runs", () => {
    const run = (extra: Partial<Run>) => ({ id: "r1", taskId: "a", purpose: "work", status: "succeeded", ...extra }) as Run;
    expect(finishedRunAlert(run({}), "Chat")).toEqual({ key: "finished:r1", text: '"Chat" finished', url: "/tasks/a" });
    expect(finishedRunAlert(run({ status: "failed" }), "Chat")?.text).toBe('"Chat" failed');
    expect(finishedRunAlert(run({ status: "stopped" }), "Chat")).toBeNull();
    expect(finishedRunAlert(run({ purpose: "review" }), "Chat")).toBeNull();
  });
});
