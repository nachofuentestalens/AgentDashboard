import { describe, expect, it } from "vitest";
import { createCodexParser } from "../src/codex-parser.ts";
import { effortFor, providerOfModel, resolveChoice } from "../src/models.ts";
import { buildTranscript, finalText } from "../src/transcript.ts";

// Captured from `codex exec --json` (codex-cli 0.154) listing a folder and answering.
const REAL_RUN = [
  '{"type":"thread.started","thread_id":"01a140bb-352f-7423-9f78-63bf7a5a2c14"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll list the folder contents now."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"powershell.exe -Command Get-ChildItem","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"powershell.exe -Command Get-ChildItem","aggregated_output":"hello.txt\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":28879,"cached_input_tokens":25472,"cache_write_input_tokens":0,"output_tokens":86,"reasoning_output_tokens":0}}',
];

describe("codex parser", () => {
  it("turns a real run into the same events as Claude's", () => {
    const parse = createCodexParser();
    const events = REAL_RUN.flatMap(parse);
    expect(events[0]).toEqual({ kind: "init", sessionId: "01a140bb-352f-7423-9f78-63bf7a5a2c14", model: "" });
    const transcript = buildTranscript(events);
    expect(transcript.done).toBe(true);
    expect(transcript.items.map((i) => i.type)).toEqual(["text", "tool", "text"]);
    expect(transcript.items[1]).toMatchObject({
      name: "Shell",
      input: { command: "powershell.exe -Command Get-ChildItem" },
      result: "hello.txt\r\n",
      isError: false,
    });
    expect(finalText(events)).toBe("ok");
    expect(events.at(-1)).toMatchObject({
      kind: "result",
      isError: false,
      text: "ok",
      sessionId: "01a140bb-352f-7423-9f78-63bf7a5a2c14",
      costUsd: 0,
      usage: { inputTokens: 3407, cacheReadTokens: 25472, outputTokens: 86, cacheWriteTokens: 0 },
    });
  });

  it("announces a tool that only arrives completed, and marks failures", () => {
    const parse = createCodexParser();
    const events = [
      '{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"pnpm test","aggregated_output":"1 failed","exit_code":1,"status":"failed"}}',
      '{"type":"item.completed","item":{"id":"f","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}],"status":"completed"}}',
      '{"type":"error","message":"stream disconnected, retrying"}',
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}',
      '{"type":"some.future.event"}',
      "not json",
    ].flatMap(parse);
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "tool_result", "tool_use", "tool_result", "stderr", "result"]);
    expect(events[1]).toMatchObject({ isError: true, content: "1 failed" });
    expect(events[3]).toMatchObject({ content: "update src/a.ts" });
    expect(events[5]).toMatchObject({ isError: true, text: "usage limit reached" });
  });
});

describe("provider, model and effort", () => {
  it.each([
    {
      name: "project default",
      levels: [{}, {}, { provider: "claude", model: "claude-opus-5-5", effort: "medium" }],
      want: ["claude", "claude-opus-5-5", "medium"],
    },
    {
      name: "role on Codex ignores the project's Claude model",
      levels: [{}, { provider: "codex", effort: "high" }, { provider: "claude", model: "claude-opus-5-5" }],
      want: ["codex", null, "high"],
    },
    {
      name: "a task's model implies its provider",
      levels: [{ model: "claude-sonnet-5" }, { provider: "codex", model: "gpt-5.6-sol" }, { provider: "codex" }],
      want: ["claude", "claude-sonnet-5", "medium"],
    },
    {
      name: "a task picks Codex and inherits the role's Codex model",
      levels: [{ provider: "codex" }, { provider: "codex", model: "gpt-5.6-sol" }, { provider: "claude" }],
      want: ["codex", "gpt-5.6-sol", "medium"],
    },
    {
      name: "Claude without a model gets the default one",
      levels: [{ provider: "claude" }, {}, { provider: "codex", model: "gpt-5.6-sol" }],
      want: ["claude", "claude-sonnet-5", "medium"],
    },
    { name: "effort clamps to what the provider accepts", levels: [{ effort: "max" }, {}, { provider: "codex" }], want: ["codex", null, "xhigh"] },
  ] as const)("$name", ({ levels, want }) => {
    const choice = resolveChoice(levels.map((l) => ({ provider: null, model: null, effort: null, ...l })));
    expect([choice.provider, choice.model, choice.effort]).toEqual(want);
  });

  it("maps efforts and model ids to providers", () => {
    expect(effortFor("claude", "minimal")).toBe("low");
    expect(effortFor("codex", "max")).toBe("xhigh");
    expect(effortFor("codex", "minimal")).toBe("minimal");
    expect(providerOfModel("claude-haiku-4-5-20251001")).toBe("claude");
    expect(providerOfModel("sonnet")).toBe("claude");
    expect(providerOfModel("gpt-5.6-sol")).toBe("codex");
    expect(providerOfModel("o4-mini")).toBe("codex");
  });
});
