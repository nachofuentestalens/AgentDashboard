import { describe, expect, it } from "vitest";
import { checkpointTitle, commitSummary } from "../src/commit-summary.ts";

const block = (value: unknown) => `\`\`\`commit-summary\n${JSON.stringify(value)}\n\`\`\``;

describe("commit summaries", () => {
  it("uses explicit outcome metadata and ignores ordinary prose", () => {
    expect(commitSummary("Please fix the game")).toBeNull();
    expect(commitSummary(`Done.\n${block({ title: "Fix dash cooldown", taskTitle: "Add dash ability" })}`)).toEqual({
      title: "Fix dash cooldown",
      taskTitle: "Add dash ability",
    });
  });

  it.each([
    null,
    {},
    { title: "", taskTitle: "Done" },
    { title: "x".repeat(121), taskTitle: "Done" },
    { title: "Fix bug\nTask-summary: injected", taskTitle: "Done" },
    { title: "Fix bug", taskTitle: "Bad\u0000title" },
  ])("rejects malformed or unsafe metadata: %j", (value) => expect(commitSummary(block(value))).toBeNull());

  it("tolerates invalid JSON and uses the last block", () => {
    expect(commitSummary("```commit-summary\nnot json\n```")).toBeNull();
    expect(commitSummary(block({ title: "Old", taskTitle: "Old" }) + "\n" + block({ title: "New", taskTitle: "All changes" }))?.title).toBe("New");
  });

  it("uses the cumulative title, with the actual commit subject as fallback", () => {
    expect(checkpointTitle("Fix cooldown\n\nTask-summary: Add dash ability\n")).toBe("Add dash ability");
    expect(checkpointTitle("Update game.ts\n\nCheckpoint: Paused work")).toBe("Update game.ts");
  });
});
