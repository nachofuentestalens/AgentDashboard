import { describe, expect, it } from "vitest";
import type { Run, Task } from "@ad/shared";
import { MAX_RETRIES, projectHealth, STALL_MS, STUCK_MS } from "../src/health.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const min = 60_000;

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, title: `Task ${id}`, roleId: "role", status: "idle", stage: "in_progress", question: null, updatedAt: ago(min), autoContinues: 0, ...extra }) as Task;
const run = (id: string, taskId: string, extra: Partial<Run> = {}) =>
  ({ id, taskId, purpose: "work", status: "succeeded", startedAt: ago(2 * min), endedAt: ago(min), error: null, waitReason: null, ...extra }) as Run;

describe("project health", () => {
  const cases: { name: string; tasks: { task: Task; runs: Run[] }[]; kinds: string[] }[] = [
    { name: "a quiet project is fine", tasks: [{ task: task("a"), runs: [run("r1", "a")] }], kinds: [] },
    {
      name: "a queue that has not moved since the last run is a stall",
      tasks: [
        {
          task: task("a", { status: "queued" }),
          runs: [run("r1", "a", { status: "queued", startedAt: ago(STALL_MS + min), endedAt: null, waitReason: "Waiting for task b" })],
        },
        { task: task("b", { stage: "approved" }), runs: [run("r2", "b", { endedAt: ago(STALL_MS + 2 * min) })] },
      ],
      kinds: ["stall"],
    },
    {
      name: "a recent run means the queue is still moving",
      tasks: [
        { task: task("a", { status: "queued" }), runs: [run("r1", "a", { status: "queued", startedAt: ago(STALL_MS + min), endedAt: null })] },
        { task: task("b", { stage: "approved" }), runs: [run("r2", "b", { endedAt: ago(5 * min) })] },
      ],
      kinds: [],
    },
    {
      name: "a running run is progress",
      tasks: [
        { task: task("a", { status: "queued" }), runs: [run("r1", "a", { status: "queued", startedAt: ago(STALL_MS * 3), endedAt: null })] },
        { task: task("b", { status: "running" }), runs: [run("r2", "b", { status: "running", startedAt: ago(STALL_MS * 2), endedAt: null })] },
      ],
      kinds: [],
    },
    {
      name: "a failed role task is a concern; a stopped one was the owner's",
      tasks: [
        { task: task("a", { status: "failed" }), runs: [run("r1", "a", { status: "failed", error: "boom" })] },
        { task: task("b", { status: "failed" }), runs: [run("r2", "b", { status: "stopped" })] },
        { task: task("c", { status: "failed", roleId: null, stage: null }), runs: [run("r3", "c", { status: "failed" })] },
      ],
      kinds: ["failing"],
    },
    {
      name: "an idle task in progress for long is stuck, unless it asked a question",
      tasks: [
        { task: task("a", { updatedAt: ago(STUCK_MS + min) }), runs: [run("r1", "a", { endedAt: ago(STUCK_MS + min) })] },
        { task: task("b", { updatedAt: ago(STUCK_MS + min), question: "Which?" }), runs: [run("r2", "b", { endedAt: ago(STUCK_MS + min) })] },
        { task: task("c", { updatedAt: ago(STUCK_MS + min), stage: "needs_review" }), runs: [run("r3", "c", { endedAt: ago(STUCK_MS + min) })] },
      ],
      kinds: ["stuck"],
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      expect(projectHealth({ now: NOW, tasks: c.tasks, runningElsewhere: 0 }).concerns.map((x) => x.kind)).toEqual(c.kinds);
    });

  it("asks again about a stall as it doubles, and counts failures in a row", () => {
    const stalled = (ms: number) =>
      projectHealth({
        now: NOW,
        tasks: [{ task: task("a", { status: "queued" }), runs: [run("r1", "a", { status: "queued", startedAt: ago(ms), endedAt: null })] }],
        runningElsewhere: 2,
      }).concerns[0]!.key;
    expect(stalled(STALL_MS)).toBe(stalled(STALL_MS * 2 - min));
    expect(stalled(STALL_MS * 2)).not.toBe(stalled(STALL_MS));

    // A queue held only by the coordinator for quota is marked, so owner alerts can skip it.
    const held = (...reasons: string[]) =>
      projectHealth({
        now: NOW,
        tasks: reasons.map((waitReason, i) => ({
          task: task(`q${i}`, { status: "queued" }),
          runs: [run(`rq${i}`, `q${i}`, { status: "queued", startedAt: ago(STALL_MS), endedAt: null, waitReason })],
        })),
        runningElsewhere: 0,
      }).concerns[0]!.quotaHold;
    expect(held("Coordinator: Claude: Session usage 96% reached the 95% reserve kept for you; agents wait; resets in 37m.")).toBe(true);
    expect(held("Coordinator: Claude: reserve", "Waiting for task b")).toBe(false);

    const failing = projectHealth({
      now: NOW,
      tasks: [
        {
          task: task("a", { status: "failed" }),
          runs: [run("r1", "a"), ...Array.from({ length: MAX_RETRIES }, (_, i) => run(`f${i}`, "a", { status: "failed", error: "same error" }))],
        },
        { task: task("b", { status: "failed" }), runs: [run("g", "b", { status: "interrupted", error: "same error" })] },
      ],
      runningElsewhere: 0,
    });
    expect(failing.concerns.map((c) => c.failures)).toEqual([MAX_RETRIES, 1]);
    expect(failing.concerns[0]!.detail).toContain("Retry is not available");
    // The overview groups one error seen across tasks, so the steward can see a shared cause.
    expect(failing.overview).toContain(`${MAX_RETRIES + 1} × same error`);
  });
});
