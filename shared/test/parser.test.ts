import { describe, expect, it } from "vitest";
import { MAX_TOOL_RESULT_CHARS, parseClaudeLine } from "../src/parser.ts";

const line = (o: unknown) => JSON.stringify(o);

describe("parseClaudeLine", () => {
  it("reads the init line", () => {
    expect(parseClaudeLine(line({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5" }))).toEqual([
      { kind: "init", sessionId: "s1", model: "claude-opus-5-5" },
    ]);
  });

  it("reads text deltas and message starts from partial messages", () => {
    expect(parseClaudeLine(line({ type: "stream_event", event: { type: "message_start", message: {} } }))).toEqual([{ kind: "message_start" }]);
    expect(parseClaudeLine(line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }))).toEqual([
      { kind: "text_delta", text: "Hi" },
    ]);
    // Thinking and tool-input deltas are not shown.
    expect(
      parseClaudeLine(line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } })),
    ).toEqual([]);
  });

  it("splits an assistant message into text and tool calls", () => {
    const events = parseClaudeLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: "text", text: "Let me look." },
      { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
    ]);
  });

  it("reads tool results given as text or as content parts, and truncates long ones", () => {
    const parts = parseClaudeLine(
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }, { type: "image" }], is_error: true }] },
      }),
    );
    expect(parts).toEqual([{ kind: "tool_result", toolUseId: "t1", content: "ok\n[image]", isError: true }]);

    const long = parseClaudeLine(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(MAX_TOOL_RESULT_CHARS + 50) }] } }),
    );
    const first = long[0];
    expect(first?.kind === "tool_result" && first.content.endsWith("[50 more characters]")).toBe(true);
  });

  it("reads the result with cost and usage, and treats a non-success subtype as an error", () => {
    const [ok] = parseClaudeLine(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0.5,
        duration_ms: 10,
        num_turns: 2,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      }),
    );
    expect(ok).toEqual({
      kind: "result",
      isError: false,
      text: "Done",
      sessionId: "s1",
      costUsd: 0.5,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      durationMs: 10,
      numTurns: 2,
    });
    const [bad] = parseClaudeLine(line({ type: "result", subtype: "error_max_turns", is_error: false }));
    expect(bad?.kind === "result" && bad.isError).toBe(true);
  });

  it("skips subagent internals, unknown types and garbage", () => {
    expect(parseClaudeLine(line({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "inner" }] } }))).toEqual([]);
    expect(parseClaudeLine(line({ type: "something_new", data: 1 }))).toEqual([]);
    expect(parseClaudeLine("not json")).toEqual([]);
    expect(parseClaudeLine("")).toEqual([]);
    expect(parseClaudeLine("[1,2]")).toEqual([]);
  });
});
