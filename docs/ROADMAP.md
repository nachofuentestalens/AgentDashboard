# Roadmap

Each phase ends with passing tests, a working `pnpm dev`, and a short demo checklist.

## Phase 1: chat tasks (done)

- [x] pnpm monorepo (shared / server / web), SQLite via `node:sqlite` (no native build on Windows)
- [x] Projects: create (validates the git repo's top folder, optional `git init`), edit, delete
- [x] Chat tasks: first message starts a Claude Code session (`--session-id`), follow-ups `--resume` it
- [x] Live streaming over SSE: text deltas, collapsible tool calls with results, errors
- [x] Per-task model/effort (default Opus 5.5 · medium) and Can-edit toggle; per-project allowed commands
- [x] Stop (kills the process tree), retry of the latest failed/stopped/interrupted run
- [x] Restart safety: runs active when the server died are marked interrupted
- [x] Tokens and cost per run and per task
- [x] Fake agent for tests and `pnpm dev:demo`
- [x] Tests: vitest (parser, transcript, launcher, API + runner), Playwright e2e; CI on Windows + Linux

Demo checklist (real Claude Code, on Windows):

1. Settings → Save and check Claude Code shows a version.
2. Create a project on a scratch repo; start a chat "List the files here and summarise the project".
3. Text streams in; the Read/Glob tool rows expand to show input and output; Done shows tokens and cost.
4. Send a follow-up that refers to the first answer: the agent remembers (session resumed).
5. Ask for something long, press Stop: the run shows Stopped, the agent process is gone (Task Manager), Retry works.
6. Turn off Can edit files, ask it to create a file: it refuses or reports the tool was denied.
7. Stop the server mid-run, start it again: the run shows Interrupted and can be retried.

## Phase 2: the studio (done)

Spec: [docs/prompts/studio.md](prompts/studio.md).

- [x] Departments with a compute weight (1-10), an optional daily budget, the repository folders they own, and whether the tasks they create start right away or wait for approval
- [x] Roles: job description, model, effort, can-edit, allowed commands, always-read documents. Agents staff roles; hire, pause and remove them (removed agents with history are archived)
- [x] "Small indie studio" template: Leadership (CTO, Game Director), Engineering (Gameplay Programmer, Tools Engineer), Design (Systems, Narrative, Economy), QA
- [x] Role tasks: a priority from 0 to 10 and an emergency flag; queued, then picked up by a free agent of the role, highest priority first
- [x] Folder ownership enforced by Claude Code permission rules; one writing agent per department at a time; read-only runs alongside
- [x] Role preamble via `--append-system-prompt-file`, studio context (team, design document index, always-read documents) in front of the message on stdin
- [x] Scheduler: global concurrency limit and daily budget, per-department budgets, fair share by spend per weight, emergencies first and freezing their project, "run anyway", queued runs survive restarts
- [x] Agents end replies with fenced `task`, `proposal` and `question` blocks; malformed blocks become warnings, never failures
- [x] Delegation: department autonomy, depth limit of 2, unknown roles and deeper requests go to the inbox
- [x] Design documents under `design/` with a Docs tab (view, edit and commit, history); proposals with a diff; `design/decisions.md` appended on accepted proposals and recorded answers
- [x] Inbox across projects (questions, proposals, task requests, held runs) with a badge; Compute page (limits, running, queue with reasons, spend per department)
- [x] Feedback tab: paste or import feedback, triage a selection with a role
- [x] Tests: blocks, diff, scheduler table, folder rules, API tests for every flow above, Playwright for the new screens

Demo checklist (real Claude Code, on Windows):

1. Studio tab → Apply the template. Edit the CTO: see its model, effort and job description.
2. Tasks tab → assign "CTO" a task: "Choose the stack for a small 2D idle game and write design/studio/tech-stack.md". It queues, starts, and the file appears; the CTO cannot edit `src/`.
3. Give the Gameplay Programmer two tasks at priority 3 and 8 with one slot (Compute → Agents at once = 1): the 8 starts first. A second programmer agent still waits: one writer per department.
4. Ask the QA Tester to break the build on purpose and report it: it raises an emergency for the Gameplay Programmer, which starts at once; the Studio shows the emergency banner until it is done.
5. Ask the Systems Designer for a combat design: its task requests wait in the Inbox (Design asks first); approve one with a different priority.
6. Ask the Gameplay Programmer to propose a change to `design/game/combat.md`: accept it with an edit in the Inbox; the file, `design/decisions.md` and one commit appear.
7. Set QA's daily budget to $0.01 and give it a task: it is held with the reason, shows in the Inbox, and "Run anyway" starts it.
8. Feedback tab: paste three comments, select them, Triage with Game Director.
9. Stop the server while a task is queued; start it again: the task still runs.

## Phase 3: workflows

- [x] Task stages (backlog → in progress → needs review → approved → closed), `step`/`review` blocks, review runs, grouped board with "Next up": design in [docs/TASK_STATES.md](TASK_STATES.md)
  - [x] Rollout 1: stage model, migration, owner actions endpoint, stage pill and stage actions on the task page
  - [x] Rollout 2: `step` block, grouped board, Next-up banner, Inbox groups
  - [x] Rollout 3: review runs and reviewer resolution
  - [x] Rollout 4: `plan` block and optional automation

- [ ] Workflow tasks: ordered steps (agent / approval gate / human input), enable/disable, retry with guidance, run from a chosen step without losing history
- [ ] Each writing task gets its own git worktree and branch; final approval shows the diff and merges; conflicts go to the Inbox with "Resolve with agent". Lifts the one-writer-per-department rule
  - [x] Persistent task worktrees, isolated runner/reviews, local end-of-run checkpoints and Pause & checkpoint UI; [recovery and rollout](WORKSPACES.md)
  - [x] GitHub checkpoint pushes and draft PRs, exact-commit approval/check gating and owner-triggered squash merge; manual deploy/revert instructions
  - [ ] Automatic conflict resolution and worktree cleanup; lift department concurrency limits after integration
- [ ] Templates: Feature, Bugfix, Balance pass, Content batch; save your own
- [ ] Promote a chat to a workflow
- [ ] Review by the reporting line: a role's proposals against another department's documents are reviewed by that department's lead before they reach the owner

## Phase 4: gamedev tools

- [ ] Brainstorm: one prompt to several roles in parallel, each returns proposals
- [ ] Playtest step: start the game's dev server, Playwright screenshots of configured screens, attached to the run
- [ ] Simulate step: run the project's sim command, chart its JSON/CSV output
- [ ] Usage summary per day/week/project

## Provider switching and efficiency audit

- [x] Review-first model/effort instructions, validated agent-requested step changes, and bounded automatic continuation with compact context

- [x] Reviewed compact handoffs with fresh sessions and preserved transcript
- [x] Opt-in phase handoffs, cumulative task/descendant usage checkpoints, persisted tool counts
- [x] Separate cache reporting, task usage controls and session age
- [x] On-demand reference documents and ask-before-delegating studio defaults

- [x] Claude / ChatGPT (Codex CLI) selectors in settings, projects, roles and prompts
- [x] Session reuse and bounded provider handoffs
- [x] Smaller document context, unchanged-catalog suppression and economical defaults
- [x] Provider integration and browser regression coverage
- [x] Discover the first five visible Codex models on every server startup; share across selectors and retain a last-known catalog on failure
