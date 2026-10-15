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

## Phase 2: design docs, proposals, decisions

- [ ] Design tab: sections stored as `design/*.md` in the project repo; view and edit them
- [ ] Proposals: agents end a reply with a fenced `proposal` JSON block (section, rationale, body); the inbox lets you accept / edit / reject. Accepting writes the section file and commits
- [ ] Decision log: entries appended when accepting proposals or answering questions; included in every agent prompt
- [ ] Chat tasks can be asked to produce proposals; the design sections are included as context

## Phase 3: workflows

- [ ] Workflow tasks: ordered steps (agent / approval gate / human input), enable/disable, retry with guidance, run from a chosen step without losing history
- [ ] Structured agent questions (fenced `question` block) that pause a step until answered
- [ ] Each writing task gets its own git worktree and branch; final approval shows the diff and merges; conflicts go to "Waiting on me" with "Resolve with agent"
- [ ] Templates: Feature, Bugfix, Balance pass, Content batch; save your own
- [ ] "Waiting on me" view across projects; promote a chat to a workflow

## Phase 4: gamedev tools

- [ ] Personas (Systems Designer, Economy/Balance, Narrative, Gameplay Programmer, UI, QA/Playtester): role prompt, model, effort, read-only default
- [ ] Brainstorm: one prompt to several personas in parallel, each returns proposals
- [ ] Playtest step: start the game's dev server, Playwright screenshots of configured screens, attached to the run
- [ ] Simulate step: run the project's sim command, chart its JSON/CSV output
- [ ] Usage summary per day/week/project; concurrency limit with a queue
