import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.ts";
import { emptyUsage } from "../src/models.ts";
import { buildTranscript, describeToolInput, finalText } from "../src/transcript.ts";

const result = (isError = false, text = ""): AgentEvent => ({
  kind: "result",
  isError,
  text,
  sessionId: "s",
  costUsd: 0,
  usage: emptyUsage(),
  durationMs: 0,
  numTurns: 1,
});

describe("transcript", () => {
  it("streams deltas into one block and lets the full block replace them", () => {
    const streaming = buildTranscript([{ kind: "message_start" }, { kind: "text_delta", text: "Hel" }, { kind: "text_delta", text: "lo" }]);
    expect(streaming.items).toEqual([{ type: "text", text: "Hello", streaming: true }]);
    const settled = buildTranscript([
      { kind: "text_delta", text: "Hel" },
      { kind: "text", text: "Hello!" },
    ]);
    expect(settled.items).toEqual([{ type: "text", text: "Hello!", streaming: false }]);
  });

  it("attaches tool results to their call and keeps order", () => {
    const t = buildTranscript([
      { kind: "text", text: "Checking." },
      { kind: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
      { kind: "tool_result", toolUseId: "t1", content: "clean", isError: false },
      { kind: "message_start" },
      { kind: "text_delta", text: "All good." },
      result(),
    ]);
    expect(t.done).toBe(true);
    expect(t.items).toEqual([
      { type: "text", text: "Checking.", streaming: false },
      { type: "tool", id: "t1", name: "Bash", input: { command: "git status" }, result: "clean", isError: false },
      { type: "text", text: "All good.", streaming: false },
    ]);
  });

  it("shows an error result", () => {
    expect(buildTranscript([result(true, "Boom")]).items).toEqual([{ type: "error", message: "Boom" }]);
  });

  it("takes the text after the last tool call as the reply", () => {
    const events: AgentEvent[] = [
      { kind: "text", text: "Let me check." },
      { kind: "tool_use", id: "t1", name: "Read", input: {} },
      { kind: "text", text: "Answer part 1." },
      { kind: "text", text: "Part 2." },
    ];
    expect(finalText(events)).toBe("Answer part 1.\n\nPart 2.");
    expect(
      finalText([
        { kind: "text", text: "Only" },
        { kind: "tool_use", id: "t", name: "X", input: {} },
      ]),
    ).toBe("Only");
  });

  it("summarises tool input on one line", () => {
    expect(describeToolInput({ command: "pnpm   test\n --run" })).toBe("pnpm test --run");
    expect(describeToolInput({ file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(describeToolInput(null)).toBe("");
  });
});
