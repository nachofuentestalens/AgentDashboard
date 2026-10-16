import { MAX_PRIORITY, type Department, type DesignDoc, type Role, type Task } from "@ad/shared";
import { describeArea, DECISIONS_DOC } from "./folders.ts";

// What a role's agent is told. The fixed part (who it is, where it may write, how to talk to the
// studio) goes in a system prompt file; the part that changes between turns (the team, the
// documents, this task) is put in front of the message on stdin. Neither goes in an argument.

const CONTEXT_DOC_CHARS = 8_000;

export function roleSystemPrompt(input: { projectName: string; department: Department; departments: Department[]; role: Role; agentName: string }): string {
  const { role, department } = input;
  const area = role.canEdit
    ? [
        `You may edit files ${describeArea(department, input.departments)}. Other departments own the rest; edits there are refused, so ask them with a task block instead.`,
        `Only one agent of ${department.name} edits files at a time. Leave the project building and running when you finish.`,
      ]
    : ["This role is read-only: investigate, review and report, but do not try to change files. Ask a role that can edit with a task block."];
  return [
    `You are ${input.agentName}, the ${role.name} in the ${department.name} department of the studio making the game "${input.projectName}".`,
    "You work through AgentDashboard: the owner directs the studio and reads your replies there, rendered as Markdown. Nobody can approve permission prompts while you run; if a command you need is refused, say which one and why.",
    "",
    "Work economically: read only relevant files, bound search and command output, avoid repeating successful checks, and keep replies concise. Delegate only essential work; do not create speculative follow-up tasks.",
    "## Your job",
    "",
    role.brief.trim() || `Do the work of a ${role.name}.`,
    "",
    "## Where you may write",
    "",
    ...area.map((line) => `- ${line}`),
    "",
    "## Design documents",
    "",
    `Design documents are Markdown files under design/. Read the ones that touch your task before you start. ${DECISIONS_DOC} lists what the owner already decided: follow it.`,
    "",
    "## Talking to the studio",
    "",
    "When you need something from someone else, end your reply with one or more fenced blocks. Each block is JSON unless said otherwise.",
    "",
    "```task",
    `{"role": "Exact role name", "title": "Short title", "prompt": "Complete instructions. The other agent sees nothing else.", "priority": 5, "emergency": false}`,
    "```",
    "",
    `Asks another role to do work. Priority goes from 0 (someday) to ${MAX_PRIORITY} (blocks everything); 5 is normal. Higher priorities are always picked up first, so be honest about them.`,
    'Set "emergency": true only when the project does not build, start or run, or data is being lost. An emergency pauses all other work in the project until it is fixed.',
    "",
    "```proposal",
    `{"docPath": "design/area/topic.md", "rationale": "Why", "body": "The complete new content of the document"}`,
    "```",
    "",
    "Proposes a change to a design document you may not edit yourself. The owner accepts, edits or rejects it.",
    "",
    "```question",
    "Plain text: what you need the owner to decide.",
    "```",
    "",
    "Asks the owner something you cannot decide yourself. Your task pauses until they answer.",
    "",
    "```step",
    `{"state": "done", "summary": "What this turn finished, in one line", "next": "The following step, if any"}`,
    "```",
    "",
    'End every reply with one step block. "done": a step is finished and more remain. "complete": the whole task is finished. "partial": you stopped mid-step and will continue. The owner reviews each finished step before you go on.',
    "",
    "```plan",
    `{"steps": ["Short title of each step not finished yet, including the one this reply finishes"]}`,
    "```",
    "",
    "Optional, for work that takes several steps: give a plan on your first reply, and again only when it changes.",
  ].join("\n");
}

// The fixed prompt of a review run. The reviewer starts fresh, so everything it needs is here.
export function reviewPrompt(input: { title: string; request: string; summary: string | null; diff: string; status: string }): string {
  return [
    "Review the work another agent did on the task below. You cannot edit files: read the changes, the relevant design documents and code,",
    "and run read-only checks if they help. Judge whether the work does what was asked, correctly and safely.",
    "",
    `Task: ${input.title}`,
    "",
    "Request:",
    input.request.slice(0, 4000),
    "",
    `Author's summary of the step: ${input.summary ?? "(none given)"}`,
    "",
    "Changed files (git status --short):",
    input.status || "(none)",
    "",
    "Diff since the task began:",
    "```diff",
    input.diff || "(empty)",
    "```",
    "",
    "End your reply with exactly one review block:",
    "",
    "```review",
    `{"verdict": "pass", "findings": ["path/to/file.ts:42 what is wrong and why"]}`,
    "```",
    "",
    'Use "changes" only for problems that must be fixed before the owner approves; otherwise "pass", with any minor notes as findings.',
    "Only the owner approves. Your verdict is advice.",
  ].join("\n");
}

export function studioContext(input: {
  departments: Department[];
  roles: Role[];
  docs: DesignDoc[];
  contextDocs: { path: string; content: string }[];
  task: Task;
  fromRole: string | null;
  firstTurn: boolean;
  includeCatalog?: boolean;
}): string {
  const deptName = new Map(input.departments.map((d) => [d.id, d.name]));
  const lines = ["<studio-context>", "Team (use these exact role names in task blocks):"];
  for (const role of input.roles) lines.push(`- ${role.name} (${deptName.get(role.departmentId) ?? "?"}${role.canEdit ? "" : ", read-only"})`);
  lines.push("", input.docs.length ? "Design documents:" : "Design documents: none yet.");
  for (const doc of input.docs) {
    const owner = doc.departmentId ? deptName.get(doc.departmentId) : null;
    lines.push(`- ${doc.path}: ${doc.title}${doc.summary ? `. ${doc.summary}` : ""}${owner ? ` (${owner})` : ""}, updated ${doc.updatedAt.slice(0, 10)}`);
  }
  const catalog = lines.slice(1).join("\n");
  lines.splice(
    1,
    lines.length - 1,
    input.includeCatalog === false
      ? "Team and document catalog unchanged; use the earlier context. Re-read relevant files if needed."
      : catalog.length > 8_000
        ? catalog.slice(0, 8_000) + "\n[Catalog shortened; inspect design/ for more.]"
        : catalog,
  );
  // Documents the role always reads are included in full on the first turn; later turns resume the
  // session, which still has them.
  if (input.firstTurn) {
    let budget = CONTEXT_DOC_CHARS;
    for (const doc of input.contextDocs) {
      if (budget <= 0) break;
      const text = doc.content.length > budget ? `${doc.content.slice(0, budget)}\n… [cut; read the file for the rest]` : doc.content;
      budget -= text.length;
      lines.push("", `--- ${doc.path} ---`, text.trimEnd());
    }
  }
  const t = input.task;
  lines.push(
    "",
    `This task: "${t.title}", priority ${t.priority} of ${MAX_PRIORITY}${t.emergency ? ", EMERGENCY: fix it before anything else" : ""}, from ${input.fromRole ?? "the owner"}.`,
    "</studio-context>",
    "",
  );
  return lines.join("\n");
}
