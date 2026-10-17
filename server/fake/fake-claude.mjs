#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json` used by the tests and by demo mode.
// It speaks the same line protocol, spends nothing and needs no account.
// Keywords in the prompt pick a scenario: [tool] runs a fake tool call, [fail] ends with an error
// result, [crash] exits without a result, [slow] keeps streaming for a long time (to test Stop).
// Studio scenarios end the reply with blocks: [proposal:design/x.md], [task:Role Name:7],
// [emergency:Role Name], [question], [badblock], [plan], [step-done|complete|partial], and in review runs
// [review-pass|changes]. [cost:1.5] reports that cost; [args] and
// [sysprompt] echo the arguments and the role's system prompt file.

import fs from "node:fs";

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
const rawPrompt = prompt;
prompt = prompt.replace(/\n\n<model-routing>[\s\S]*?<\/model-routing>$/, "");
prompt = prompt.replace(/\n\n<efficiency>[\s\S]*?<\/efficiency>$/, "");
const preparingHandoff = prompt.includes("Prepare a compact context handoff");
// A role's run puts the studio context in front of the message; answer the message itself.
const context = prompt.match(/^<studio-context>[\s\S]*?<\/studio-context>\s*/);
if (context) prompt = prompt.slice(context[0].length).trim();
const history = prompt.match(/^<conversation-so-far>[\s\S]*?<\/conversation-so-far>\s*/);
if (history) prompt = prompt.slice(history[0].length).trim();
prompt = prompt.replace(/\n\nWork only in this task's isolated worktree\.[\s\S]*$/, "");
const systemFile = flag("--append-system-prompt-file");
const systemText = systemFile ? fs.readFileSync(systemFile, "utf8") : "";
const who = systemText.match(/^You are (.+?), the (.+?) in the (.+?) department/);

emit({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [] });

let lastText = "";
// Long echoes go out as one delta: word by word they take seconds and slow the tests down.
async function say(text, byWord = true) {
  lastText = text;
  emit({ type: "stream_event", event: { type: "message_start" }, session_id: sessionId, parent_tool_use_id: null });
  for (const word of byWord ? text.split(/(?<= )/) : [text]) {
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

const routingCurrent = rawPrompt.match(/Current provider: ([^;]+); model: ([^;]+); effort: ([^.]+)\./);
const review = routingCurrent
  ? {
      complexity: "simple",
      model: routingCurrent[2].startsWith("CLI default") ? null : routingCurrent[2],
      effort: routingCurrent[3],
      reason: "Current settings fit this step.",
      action: "continue",
    }
  : null;
if (review) await say("```model-review\n" + JSON.stringify(review) + "\n```");

if (prompt.includes("[input]")) await say(`Input: ${rawPrompt}`, false);
if (prompt.includes("[write-workspace]")) {
  fs.writeFileSync("agent-work.txt", "Unfinished agent work\n");
  await say(`Workspace write: ${process.cwd()}`);
}

if (prompt.includes("[crash]")) {
  process.stderr.write("fake-claude: simulated crash\n");
  process.exit(3);
}

// The values of a variadic option, up to the next option.
const list = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const rest = args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
};
const editFolders = list("--allowedTools")
  .filter((a) => a.startsWith("Edit(./"))
  .map((a) => a.slice("Edit(./".length, -"/**)".length));
const mode = args.includes("acceptEdits") ? "can edit" : editFolders.length ? `can edit ${editFolders.join(", ")}` : "read-only";
const persona = who ? ` as ${who[1]} (${who[3]})` : "";
await say(
  `${resumed ? "Continuing session" : "Starting session"} ${sessionId.slice(0, 8)} on ${model} (${mode})${persona}${context ? " with studio context" : ""}. You said: "${prompt.slice(0, 200)}"`,
);
if (prompt.includes("[args]")) await say(`Arguments: ${JSON.stringify(args)}`);
if (prompt.includes("[sysprompt]")) await say(`System prompt: ${systemText.slice(0, 4000)}`, false);
if (prompt.includes("[context]") && context) await say(`Context: ${context[0].slice(0, 4000)}`, false);
if (prompt.includes("[history]")) await say(`History: ${(history?.[0] ?? "none").slice(0, 4000)}`, false);

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

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;
const blocks = [];
for (const m of prompt.matchAll(/\[proposal:([^\]]+)\]/g)) {
  blocks.push(fence("proposal", JSON.stringify({ docPath: m[1], rationale: "Fake rationale.", body: `# ${m[1]}\n\nProposed by the fake agent.\n` })));
}
for (const m of prompt.matchAll(/\[task:([^\]:]+)(?::(\d+))?\]/g)) {
  blocks.push(fence("task", JSON.stringify({ role: m[1], title: `Follow-up for ${m[1]}`, prompt: `Do the follow-up work.`, priority: Number(m[2] ?? 5) })));
}
for (const m of prompt.matchAll(/\[emergency:([^\]]+)\]/g)) {
  blocks.push(fence("task", JSON.stringify({ role: m[1], title: "The build is broken", prompt: "Fix the build.", priority: 10, emergency: true })));
}
if (prompt.includes("[question]")) blocks.push(fence("question", "Should the warrior use a shield?"));
if (prompt.includes("[badblock]")) blocks.push(fence("task", "{ not json"));
// Only a review prompt gets a verdict, so the same keyword in the task's request leaves work runs alone.
const reviewing = prompt.includes("exactly one review block");
if (reviewing && prompt.includes("[review-pass]")) blocks.push(fence("review", JSON.stringify({ verdict: "pass", findings: ["qa/plan.md:3 minor wording"] })));
if (reviewing && prompt.includes("[review-changes]"))
  blocks.push(fence("review", JSON.stringify({ verdict: "changes", findings: ["src/dash.ts:42 cooldown never resets after death"] })));
if (prompt.includes("[plan]")) blocks.push(fence("plan", JSON.stringify({ steps: ["Add the dash ability", "Tune the dash cooldown", "Write the tests"] })));
for (const state of ["done", "complete", "partial"]) {
  if (prompt.includes(`[step-${state}]`))
    blocks.push(fence("step", JSON.stringify({ state, summary: `Fake step ${state}.`, next: state === "complete" ? null : "Tune the dash cooldown." })));
}
if (blocks.length) await say(`Here is what I need.\n\n${blocks.join("\n\n")}`);

if (preparingHandoff || prompt.includes("[handoff]"))
  await say(
    "```context-handoff\n" +
      JSON.stringify({
        goal: "Implement the requested feature",
        constraints: "Preserve user requirements",
        files: "shared/src/models.ts",
        completed: "Investigation complete",
        verification: "No checks run",
        remaining: "Implement and verify",
      }) +
      "\n```",
  );

if (
  review &&
  (prompt.includes("[switch-model]") || prompt.includes("[switch-invalid]") || prompt.includes("[switch-loop]")) &&
  (!rawPrompt.includes("<model-continuation>") || prompt.includes("[switch-loop]"))
) {
  const target =
    routingCurrent[1] === "claude" ? (review.model === "claude-haiku-4-5-20251001" ? "claude-sonnet-5" : "claude-haiku-4-5-20251001") : "demo-model-2";
  await say(
    "```model-review\n" +
      JSON.stringify({
        ...review,
        model: prompt.includes("[switch-invalid]") ? "nonexistent-model" : target,
        effort: "low",
        action: "switch",
        reason: "A simpler model is sufficient for implementation.",
        nextStep: "Implement the next step.",
      }) +
      "\n```\n\n```context-handoff\n" +
      JSON.stringify({
        goal: "Complete owner request",
        constraints: "Preserve requirements",
        files: "src",
        completed: "Reviewed complexity",
        verification: "No checks run",
        remaining: "Implement and verify",
      }) +
      "\n```",
  );
}

const cost = Number(prompt.match(/\[cost:([\d.]+)\]/)?.[1] ?? 0.0123);
const isError = prompt.includes("[fail]");
emit({
  type: "result",
  subtype: isError ? "error_during_execution" : "success",
  is_error: isError,
  result: isError ? "Simulated failure." : lastText,
  session_id: sessionId,
  total_cost_usd: cost,
  duration_ms: 1000,
  num_turns: 1,
  usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
});
