import { describe, expect, it } from "vitest";
import { parseReplyBlocks } from "../src/blocks.ts";
import { lineDiff } from "../src/diff.ts";

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("reply blocks", () => {
  it("reads task, proposal and question blocks after the prose", () => {
    const reply = [
      "I looked at the combat code.",
      fence("task", JSON.stringify({ role: "QA Tester", title: "Test combat", prompt: "Run the combat tests.", priority: 8 })),
      fence("proposal", JSON.stringify({ docPath: "design/game/combat.md", rationale: "Clearer", body: "# Combat\n\n```js\nx\n```\n" })),
      fence("question", "Shields or no shields?"),
    ].join("\n\n");
    expect(parseReplyBlocks(reply)).toEqual([
      { type: "task", role: "QA Tester", title: "Test combat", prompt: "Run the combat tests.", priority: 8, emergency: false },
      { type: "proposal", docPath: "design/game/combat.md", rationale: "Clearer", body: "# Combat\n\n```js\nx\n```\n" },
      { type: "question", question: "Shields or no shields?" },
    ]);
  });

  it("clamps and rounds priorities instead of refusing them", () => {
    const blocks = parseReplyBlocks(
      [
        fence("task", JSON.stringify({ role: "A", title: "t", prompt: "p", priority: 42 })),
        fence("task", JSON.stringify({ role: "A", title: "t", prompt: "p", priority: "6.6", emergency: true })),
        fence("task", JSON.stringify({ role: "A", title: "t", prompt: "p" })),
      ].join("\n"),
    );
    expect(blocks.map((b) => (b.type === "task" ? [b.priority, b.emergency] : null))).toEqual([
      [10, false],
      [7, true],
      [5, false],
    ]);
  });

  it("reports malformed blocks and ignores other code fences", () => {
    const blocks = parseReplyBlocks(
      [fence("ts", "const task = 1;"), fence("task", "{ nope"), fence("proposal", JSON.stringify({ docPath: "design/a.md" })), fence("question", "{}")].join(
        "\n",
      ),
    );
    expect(blocks.map((b) => b.type)).toEqual(["invalid", "invalid", "invalid"]);
    expect(blocks[1]).toMatchObject({ lang: "proposal", error: expect.stringMatching(/body/) });
  });
});

describe("line diff", () => {
  it("keeps common lines and marks changes", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
    expect(lineDiff("", "new")).toEqual([{ type: "add", text: "new" }]);
  });
});
