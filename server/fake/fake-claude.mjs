#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json` used by the tests and by demo mode.
// It speaks the same line protocol, spends nothing and needs no account.
// Keywords in the prompt pick a scenario: [tool] runs a fake tool call, [fail] ends with an error
// result, [crash] exits without a result, [slow] keeps streaming for a long time (to test Stop).

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--version")) {
  console.log("0.0.0 (Fake Claude Code)");
  process.exit(0);
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? "00000000-0000-0000-0000-000000000000";
const resumed = flag("--resume") !== undefined;
const model = flag("--model") ?? "fake-model";
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 25);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
prompt = prompt.trim();

emit({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [] });

let lastText = "";
async function say(text) {
  lastText = text;
  emit({ type: "stream_event", event: { type: "message_start" }, session_id: sessionId, parent_tool_use_id: null });
  for (const word of text.split(/(?<= )/)) {
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } },
      session_id: sessionId,
      parent_tool_use_id: null,
    });
    await sleep(delay);
  }
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId, parent_tool_use_id: null });
}

if (prompt.includes("[crash]")) {
  process.stderr.write("fake-claude: simulated crash\n");
  process.exit(3);
}

const mode = args.includes("acceptEdits") ? "can edit" : "read-only";
await say(`${resumed ? "Continuing session" : "Starting session"} ${sessionId.slice(0, 8)} on ${model} (${mode}). You said: "${prompt.slice(0, 200)}"`);

if (prompt.includes("[tool]")) {
  const id = "toolu_fake_1";
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "git status", description: "Show working tree status" } }],
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
  await sleep(delay * 4);
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "On branch main\nnothing to commit, working tree clean", is_error: false }],
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  });
  await say("The working tree is clean.");
}

if (prompt.includes("[slow]")) {
  for (let i = 0; i < 600; i++) await say(`Still working (${i})… `);
}

const isError = prompt.includes("[fail]");
emit({
  type: "result",
  subtype: isError ? "error_during_execution" : "success",
  is_error: isError,
  result: isError ? "Simulated failure." : lastText,
  session_id: sessionId,
  total_cost_usd: 0.0123,
  duration_ms: 1000,
  num_turns: 1,
  usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
});
