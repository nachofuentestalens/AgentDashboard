import type { TaskStage } from "@ad/shared";

// Progress through a role task's work, separate from the run activity (idle/running/waiting/...).
// Plain chats have stage null and never reach this function. Transitions are a pure function of
// the current stage and an event, tested as a table, so runner.ts and the routes never set stage
// directly (CLAUDE.md: workflow state changes happen on the server, not ad hoc at each call site).
export type StageEvent =
  | "start" // a work run begins: backlog, needs_review or changes_requested → in_progress
  | "run_succeeded" // a work run finished a step without a question
  | "continue" // owner asks for the next step from needs_review
  | "fix" // owner (or the author session) addresses review findings
  | "request_changes" // owner reviews and finds problems, without a review run
  | "review_start" // a read-only review run begins
  | "review_pass"
  | "review_changes"
  | "review_cancel" // the review run failed, was stopped or gave no verdict
  | "approve"
  | "close"
  | "reopen"
  | "backlog"; // owner moves it back to the queue

export interface StageResult {
  stage: TaskStage;
  error?: string;
}

const ok = (stage: TaskStage): StageResult => ({ stage });
const refuse = (stage: TaskStage, error: string): StageResult => ({ stage, error });

export function nextStage(stage: TaskStage, event: StageEvent): StageResult {
  switch (event) {
    case "start":
      if (stage === "backlog" || stage === "needs_review" || stage === "changes_requested" || stage === "in_progress") return ok("in_progress");
      return refuse(stage, `Cannot start work from ${stage}.`);
    case "run_succeeded":
      if (stage === "in_progress") return ok("needs_review");
      return refuse(stage, `A work run finished while the stage was ${stage}.`);
    case "continue":
      if (stage === "needs_review") return ok("in_progress");
      return refuse(stage, `Continue is only for needs_review, not ${stage}.`);
    case "fix":
      if (stage === "changes_requested") return ok("in_progress");
      return refuse(stage, `Fix is only for changes_requested, not ${stage}.`);
    case "request_changes":
      if (stage === "needs_review" || stage === "in_review") return ok("changes_requested");
      return refuse(stage, `Request changes is only for needs_review or in_review, not ${stage}.`);
    case "review_start":
      if (stage === "needs_review") return ok("in_review");
      return refuse(stage, `Review is only from needs_review, not ${stage}.`);
    case "review_pass":
      if (stage === "in_review") return ok("needs_review");
      return refuse(stage, `A review verdict arrived while the stage was ${stage}.`);
    case "review_changes":
      if (stage === "in_review") return ok("changes_requested");
      return refuse(stage, `A review verdict arrived while the stage was ${stage}.`);
    case "review_cancel":
      // Never towards approval: the work goes back to the owner unreviewed.
      if (stage === "in_review") return ok("needs_review");
      return refuse(stage, `No review is running (the stage is ${stage}).`);
    case "approve":
      if (stage === "needs_review") return ok("approved");
      return refuse(stage, `Approve is only for needs_review, not ${stage}.`);
    case "close":
      // Approved work is the usual path; from other stages the owner drops the task. The caller
      // already refuses while an agent is running.
      if (stage !== "closed" && stage !== "in_review") return ok("closed");
      return refuse(stage, `Cannot close a task that is ${stage === "closed" ? "already closed" : "being reviewed"}.`);
    case "reopen":
      if (stage === "closed") return ok("backlog");
      return refuse(stage, `Reopen is only for closed, not ${stage}.`);
    case "backlog":
      if (stage === "approved" || stage === "needs_review" || stage === "changes_requested") return ok("backlog");
      return refuse(stage, `Cannot move ${stage} back to the backlog.`);
  }
}
