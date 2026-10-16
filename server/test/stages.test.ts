import { describe, expect, it } from "vitest";
import { nextStage, type StageEvent } from "../src/stages.ts";
import type { TaskStage } from "@ad/shared";

// One row per transition the design (docs/TASK_STATES.md) allows or refuses. "accepted" undefined
// means the stage must not change and an error must come back.
const rows: { from: TaskStage; event: StageEvent; to?: TaskStage }[] = [
  { from: "backlog", event: "start", to: "in_progress" },
  { from: "needs_review", event: "start", to: "in_progress" },
  { from: "changes_requested", event: "start", to: "in_progress" },
  { from: "in_progress", event: "start", to: "in_progress" },
  { from: "approved", event: "start" },
  { from: "closed", event: "start" },
  { from: "in_progress", event: "run_succeeded", to: "needs_review" },
  { from: "backlog", event: "run_succeeded" },
  { from: "needs_review", event: "run_succeeded" },
  { from: "needs_review", event: "continue", to: "in_progress" },
  { from: "in_progress", event: "continue" },
  { from: "changes_requested", event: "fix", to: "in_progress" },
  { from: "needs_review", event: "fix" },
  { from: "needs_review", event: "request_changes", to: "changes_requested" },
  { from: "in_review", event: "request_changes", to: "changes_requested" },
  { from: "backlog", event: "request_changes" },
  { from: "needs_review", event: "review_start", to: "in_review" },
  { from: "in_progress", event: "review_start" },
  { from: "in_review", event: "review_pass", to: "needs_review" },
  { from: "needs_review", event: "review_pass" },
  { from: "in_review", event: "review_changes", to: "changes_requested" },
  { from: "in_review", event: "review_cancel", to: "needs_review" },
  { from: "needs_review", event: "review_cancel" },
  { from: "needs_review", event: "approve", to: "approved" },
  { from: "in_progress", event: "approve" },
  { from: "changes_requested", event: "approve" },
  { from: "approved", event: "close", to: "closed" },
  { from: "needs_review", event: "close", to: "closed" },
  { from: "in_progress", event: "close", to: "closed" },
  { from: "in_review", event: "close" },
  { from: "closed", event: "close" },
  { from: "closed", event: "reopen", to: "backlog" },
  { from: "backlog", event: "reopen" },
  { from: "needs_review", event: "backlog", to: "backlog" },
  { from: "approved", event: "backlog", to: "backlog" },
  { from: "changes_requested", event: "backlog", to: "backlog" },
  { from: "in_progress", event: "backlog" },
  { from: "closed", event: "backlog" },
];

describe("nextStage", () => {
  for (const row of rows) {
    it(`${row.from} + ${row.event} -> ${row.to ?? "refused"}`, () => {
      const result = nextStage(row.from, row.event);
      if (row.to) {
        expect(result.stage).toBe(row.to);
        expect(result.error).toBeUndefined();
      } else {
        expect(result.stage).toBe(row.from);
        expect(result.error).toBeDefined();
      }
    });
  }
});
