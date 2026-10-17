import { describe, expect, it } from "vitest";
import { taskGitState, type TaskWorkspace } from "../src/models.ts";

const ws = (extra: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  taskId: "t",
  repoPath: "r",
  path: "p",
  branch: "b",
  baseCommit: "base",
  checkpointCommit: null,
  checkpointAt: null,
  publishedCommit: null,
  githubRepo: null,
  pullRequestUrl: null,
  publishError: null,
  mergeCommit: null,
  approvedCommit: null,
  error: null,
  ...extra,
});

describe("taskGitState", () => {
  it.each([
    ["no worktree", null, null],
    ["no changes yet", ws({ checkpointCommit: "base" }), null],
    ["local commits", ws({ checkpointCommit: "c1" }), "local"],
    ["pull request up to date", ws({ checkpointCommit: "c1", publishedCommit: "c1", pullRequestUrl: "u" }), "pr_open"],
    ["new commits after the pull request", ws({ checkpointCommit: "c2", publishedCommit: "c1", pullRequestUrl: "u" }), "local"],
    ["publish failed", ws({ checkpointCommit: "c1", publishError: "auth" }), "publish_failed"],
    ["worktree error", ws({ checkpointCommit: "c1", error: "broken" }), "error"],
    ["merged wins", ws({ checkpointCommit: "c1", pullRequestUrl: "u", mergeCommit: "m", error: "x" }), "merged"],
  ] as const)("%s", (_, w, expected) => {
    expect(taskGitState(w)).toBe(expected);
  });
});
