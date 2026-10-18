#!/usr/bin/env node
// A stand-in for `codex exec --json` used by the tests and by demo mode. It speaks the same JSONL
// events, spends nothing and needs no account. It understands the same keywords as fake-claude.mjs:
// [tool], [fail], [crash], [slow], [proposal:path], [task:Role:priority], [emergency:Role],
// [question], [badblock], [args], [sysprompt], [context], [history].

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("app-server")) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
    if (request.method === "model/list")
      console.log(
        JSON.stringify({
          id: request.id,
          result: {
            data: Array.from({ length: 7 }, (_, i) => ({ model: `demo-model-${i + 1}`, displayName: `Demo Model ${i + 1}`, hidden: false })),
            nextCursor: null,
          },
        }),
      );
  }
  process.exit(0);
}
if (args.includes("--version")) {
  console.log("codex-cli 0.0.0 (Fake Codex)");
  process.exit(0);
}

const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0;
const threadId = resumed ? args[resumeAt + 1] : randomUUID();
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = (key) => {
  const entry = args.find((a, i) => args[i - 1] === "-c" && a.startsWith(`${key}=`));
  return entry?.slice(key.length + 1).replace(/^"|"$/g, "");
};
const model = flag("-m") ?? "codex-default";
const sandbox = config("sandbox_mode") ?? "read-only";
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

// The dashboard puts its instructions, the studio context and, after a provider switch, the
// conversation so far in front of the message. Answer the message itself.
const blocksBefore = {};
for (;;) {
  const m = prompt.match(/^<(instructions|studio-context|conversation-so-far)>[\s\S]*?<\/\1>\s*/);
  if (!m) break;
  blocksBefore[m[1]] = m[0];
  prompt = prompt.slice(m[0].length).trim();
}
const who = (blocksBefore.instructions ?? "").match(/You are (.+?), the (.+?) in the (.+?) department/);

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

let n = 0;
async function say(text) {
  await sleep(delay * 3);
  emit({ type: "item.completed", item: { id: `item_${n++}`, type: "agent_message", text } });
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

if (prompt.includes("[input]")) await say(`Input: ${rawPrompt}`);

if (prompt.includes("[crash]")) {
  process.stderr.write("fake-codex: simulated crash\n");
  process.exit(3);
}

const persona = who ? ` as ${who[1]} (${who[3]})` : "";
await say(
  `${resumed ? "Continuing thread" : "Starting thread"} ${threadId.slice(0, 8)} on ${model} (${sandbox})${persona}${blocksBefore["studio-context"] ? " with studio context" : ""}. You said: "${prompt.slice(0, 200)}"`,
);
if (prompt.includes("[args]")) await say(`Arguments: ${JSON.stringify(args)}`);
if (prompt.includes("[sysprompt]")) await say(`Instructions: ${(blocksBefore.instructions ?? "").slice(0, 4000)}`);
if (prompt.includes("[context]")) await say(`Context: ${(blocksBefore["studio-context"] ?? "").slice(0, 4000)}`);
if (prompt.includes("[history]")) await say(`History: ${(blocksBefore["conversation-so-far"] ?? "none").slice(0, 4000)}`);
if (prompt.includes("[cwd]")) await say(`Working directory: ${process.cwd()}`);
if (prompt.includes("[write-workspace]")) {
  fs.writeFileSync("agent-work.txt", "Unfinished agent work\n");
  await say(`Workspace write: ${process.cwd()}`);
}

if (prompt.includes("[tool]")) {
  const id = `item_${n++}`;
  emit({ type: "item.started", item: { id, type: "command_execution", command: "git status", aggregated_output: "", exit_code: null, status: "in_progress" } });
  await sleep(delay * 4);
  emit({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command: "git status",
      aggregated_output: "On branch main\nnothing to commit, working tree clean",
      exit_code: 0,
      status: "completed",
    },
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

if (prompt.includes("[fail]")) {
  emit({ type: "error", message: "Simulated failure." });
  emit({ type: "turn.failed", error: { message: "Simulated failure." } });
  process.exit(1);
}

emit({
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 45, reasoning_output_tokens: 0 },
});
