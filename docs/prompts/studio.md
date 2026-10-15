# The studio: role-based agents for a game project

This was the prompt for roadmap Phase 2, and is now its spec: what was built, the rules it follows, and what was left for later. Keep it in step with the code.
To extend the studio with an agent, paste the relevant section into a chat on the AgentDashboard project along with what you want changed.

## Goal

Each project is run like a small game studio. The owner (you) directs it; agents work for you.

- **Departments** (Leadership, Engineering, Design, QA, ...) each own **folders** of the repository and get a **share of compute**.
- **Roles** inside departments (CTO, Game Director, Gameplay Programmer, QA Tester, ...) are job descriptions: responsibilities, model, effort, whether they edit files, which documents they always read.
- **Agents** staff roles. Hire several of one role to work in parallel, pause them, or remove them (agents with history are archived, so their runs stay attributed).
- **Tasks** for a role have a **priority from 0 to 10**; free agents always take the highest priority first. **Emergency** tasks (the project does not build or run) go before everything and pause the project's other work until done.
- **Agents create tasks for each other**, propose changes to design documents, and ask you questions, through fenced blocks at the end of their replies.
- **Design documents** live under `design/` in the game's repository and are the studio's shared memory.

Example: the CTO (Opus, xhigh effort) owns `design/studio/tech-stack.md` and `architecture.md` and never writes game code; it creates tasks for the Gameplay Programmer (Sonnet, medium), which must follow those documents and may only propose changes to them. The QA Tester files bugs as prioritised tasks, and raises an emergency when the build breaks.

## Data model

Migration 2 in `server/src/db.ts`; types in `shared/src/models.ts`; bodies in `shared/src/schemas.ts`.

- **Department**: `name, color, weight (1-10), dailyBudgetUsd | null, folders[], autonomy ("ask" | "auto")`.
- **Role**: `departmentId, name (unique per project: agents address roles by name), brief, model | null, effort | null, canEdit, allowedTools[] | null, contextDocs[]`. Null model, effort or tools mean the project's.
- **Agent**: `roleId, name, paused, archived`.
- **Task** gains `roleId | null` (null = a plain chat with the owner), `agentId`, `priority (0-10, default 5)`, `emergency`, `parentTaskId`, `depth`, `createdByRoleId`, `question`. New statuses: `queued`, `waiting` (a question for the owner), `done`.
- **Run** gains `queued` status, `roleId, agentId, departmentId, waitReason, forced, prompt`.
- **Proposal** (`docPath, rationale, body, status`), **Handoff** (a task one agent asked for: `toRoleName, title, prompt, priority, emergency, depth, reason, status`), **Feedback** (`source, text, status, taskId`).
- Design documents are not in the database: the repository is the source of truth.

## Folders and writing

- A department's folders are repo-relative paths; `"."` means everything no other department owns. A path belongs to the department with the most specific folder holding it.
- A writing role's run gets Claude Code permission rules built from its department (`server/src/folders.ts`): confined departments run with `--permission-mode default --allowedTools Edit(./<folder>/**) ...`; a `"."` department runs with `acceptEdits` and `--disallowedTools` for every other department's folders. `design/decisions.md` is denied to everyone. The CLI itself refuses edits outside the area.
- **One writing agent per department at a time**, so agents in one working tree never overwrite each other's files. Read-only runs go alongside. Git worktrees (Phase 3) can lift this later.
- Limitation: shell commands (`Bash(node:*)`, `PowerShell`) can still write anywhere. Narrow a role's allowed commands if that matters.

## How a role task runs

1. The owner (Tasks tab, Inbox, Feedback triage) or an agent (a `task` block) creates a task for a role, with a priority.
2. Its run is **queued**. The scheduler (`server/src/scheduler.ts`, a pure function with a table test) starts queued runs when:
   - a non-paused agent of the role is free,
   - for a writer, nobody else in the department is writing,
   - unless it is an emergency or the owner said **run anyway**: the project has no open emergency, the department and global daily budgets (sliding 24 hours) are not reached, and a slot is free (`maxConcurrentRuns`, default 3).
   - Order: emergencies first; then the department with the lowest `spend / weight` (24-hour spend plus estimates for its running agents); inside it the highest priority, then the oldest. Emergencies also ignore the slot limit.
   - Every run that waits shows why ("Every QA Tester agent is busy.", "QA reached its daily budget ($1.50 of $1.00).").
3. The agent gets its role preamble through `--append-system-prompt-file` (who it is, its job, where it may write, the block protocol) and, in front of the message on stdin, the studio context: the team, the design document index, its always-read documents (first turn), and the task's priority and origin. No role or user text is ever a process argument.
4. When the run succeeds, the dashboard reads the reply's blocks, acts on them and writes a notice for each into the transcript. A role task with no open question becomes **done**; a question makes it **waiting**.
5. Queued runs survive a server restart; running ones become interrupted, as before.

Plain chats (no role) are unchanged: they start at once and count toward the slot limit, never become emergencies, and are not confined to a folder.

## Reply blocks

`shared/src/blocks.ts`. JSON unless noted; malformed blocks become a warning notice and never fail the run.

- ` ```task ` `{"role", "title", "prompt", "priority" (0-10, clamped and rounded), "emergency"}`: a task for another role. Created right away when the sender's department is on `auto`, the role exists, and the new depth is at most 2; otherwise a **task request** waits in the Inbox with the reason, where the owner can pick a role and priority.
- ` ```proposal ` `{"docPath", "rationale", "body"}`: a new version of a document under `design/`. The Inbox shows a diff; accept (as is or edited) writes the file, appends to `design/decisions.md` and commits both; reject with a reason sends that reason to the agent's task.
- ` ```question `: plain text. The task waits; answer in the Inbox (optionally recorded in `decisions.md`) or reply in the task.

## Screens

- **Studio** tab: departments with weight slider, budget, folders, autonomy, who is writing; roles with model, effort, queued count and spend; agents as chips (idle, working, waiting on you, paused) with pause and remove; role editor with average cost per effort from past runs; template button on an empty studio; emergency banner.
- **Tasks** tab: assign a new task to a role with a priority and the emergency flag, or chat as before.
- **Task** page: role and agent, priority and emergency editable, mark done or reopen, the open question, queued runs with their reason, "run anyway" and "take out of the queue".
- **Docs** tab: documents under `design/` with their owning department, Markdown view, edit and commit, git history.
- **Feedback** tab: paste or import (.txt/.md paragraphs, .csv lines), filter by status, select and triage with a role (the Game Director by default).
- **Inbox** (sidebar, with a count): questions, design proposals, task requests, runs held by a budget or an emergency.
- **Compute** (sidebar): agents running of slots, queue length, 24-hour spend against the budget; the limits; running and queued runs in order with reasons; spend per department against its budget.

## Not built yet

- Review by the reporting line (a lead reviewing proposals before the owner): roadmap Phase 3.
- A per-department concurrency cap other than one writer (seats per role already cap parallelism).
- Tags on feedback.
- Detecting edits made through shell commands outside a department's folders.
