# AgentDashboard: notes for coding agents

A local dashboard (Node + React) that runs Claude Code CLI agents on the developer's game projects. Single user, loopback only, Windows 11 first.

## Layout

- `shared/`: types (`models.ts`), zod request schemas (`schemas.ts`), the stream-json parser (`parser.ts`), the transcript reducer (`transcript.ts`), the reply-block parser (`blocks.ts`: `task` / `proposal` / `question` / `step` / `plan` / `review` / `decision`), a line diff (`diff.ts`) and the inbox items that trigger desktop alerts (`attention.ts`, used by `web/src/attention.ts`). Pure code, used by both server and web. Imported as TypeScript source (`@ad/shared`); there is no build step.
- `server/`: Fastify API run with tsx.
  - `app.ts`: core routes, the loopback/origin guard, SSE `/api/events`, static web serving. `studio-routes.ts`: departments, roles, agents, docs, inbox, compute, feedback.
  - `store.ts`: **all SQL**. `db.ts`: `node:sqlite` connection and append-only migrations.
  - `runner.ts`: spawns `claude`, records events to `runs/<id>.jsonl`, settles run outcomes, stop/retry, one run per task. Plain chats start at once; role tasks are queued and started by a scheduling pass.
  - `restart.ts`: durable server restart barrier, agent handoffs and checkpoint readiness; `scripts/server.mjs` relaunches on confirmed restart. See `docs/SERVER_RESTART.md`.
  - `stages.ts`: the pure function for role task stages (backlog → in_progress → needs_review → approved → closed, see `docs/TASK_STATES.md`). `runner.ts` applies it on run start/finish and owner actions (`POST /api/tasks/:id/actions`); change transitions here and in its table test. Plain chats have no stage. Review runs (`purpose: "review"`) run as the reviewer role, read-only, in their own session (`actorTask` in `runner.ts`); `step`, `plan` and `review` reply blocks report progress, never approval.
  - `scheduler.ts`: the pure function deciding which queued runs start (slots, budgets, one writer per department, fair share by weight, priority, emergencies). Change rules here and in its table test.
  - `readiness.ts`: committed input and prerequisite ancestry checks before scheduling/launch; dependency graph validation and approval state live in `store.ts`. See `docs/DEPENDENCIES.md` and the Banner & Bounty recovery audit before enabling automation on legacy task plans.
  - `delivery.ts` / `delivery-plan.ts` / `baseline.ts`: the owner-approved managed baseline (snapshot, task integration previews via `merge-tree`, milestone plan import, enabling automation). Never touches the live checkout; see `docs/DEPENDENCIES.md`.
  - `coordinator.ts`: the pure rules of the project coordinator (provider session/weekly usage levels, the owner's reserve, scheduler holds, pause/resume/start/switch decisions); `coordination.ts` is its service and routes. See `docs/COORDINATOR.md`; change rules there and in its table test.
  - `steward.ts`: the inbox steward, an agent role that triages a project's inbox before the owner through validated `decision` blocks and escalates the rest; `health.ts` holds the pure project health rules (stalls, failing and stuck tasks) it also watches. See `docs/STEWARD.md`.
  - `studio.ts`: the studio service: template, structure views, acting on reply blocks, inbox decisions, compute view, feedback triage. `template.ts`: the default studio.
  - `company.ts`: opt-in company briefs, initial Director/QA staffing, and durable daily observation assignments. See `docs/COMPANY.md` for scheduling, recovery, and unfinished autonomy phases.
  - `folders.ts`: department folders → Claude Code permission rules. `prompts.ts`: the role preamble and the per-turn studio context. `docs.ts`: design documents under `design/` and their commits.
  - `claude.ts`: finds the CLI (PATH, `claude.exe`, npm `.cmd` shims) and builds its arguments.
  - `git.ts`: repository checks and commits. `fake/fake-claude.mjs`: the stand-in agent for tests and demo mode.
  - `workspaces.ts`: persistent per-task Git worktrees and server-owned checkpoints. `github.ts`: branch publication, draft PRs and checked automatic squash merges for completed work; see `docs/WORKSPACES.md` for authentication, baseline requirements, recovery and deployment.
  - `workspace-cleanup.ts`: owner-triggered preview/removal, exact-checkpoint Git delivery evidence and recovery references; runner workspace/delivery locks protect removal. Never force-remove worktrees or delete branches.
- `web/`: React 19 + Vite + Tailwind 4 + TanStack Query + React Router. `live.ts` applies server pushes to the query cache.
- `e2e/`: Playwright tests against the built app with the fake agent.
- `docs/ROADMAP.md`: phases and progress. Update its checkboxes when an item lands.

## Rules

- Workflow and run state changes happen on the server (`runner.ts`, later a workflow state machine), never in React components. The UI only calls the API and renders.
- The prompt goes to the agent through **stdin**. Never put user or agent text in process arguments, and never spawn through a shell (`shell: true`). Model ids, tool rules and department folders that do become arguments are validated by `shared/src/schemas.ts`. A role's preamble goes in a file (`--append-system-prompt-file`); git commit messages go through stdin (`-F -`).
- Agents may only ask for things through reply blocks the server checks (`blocks.ts` → `studio.ts`): paths stay under `design/`, roles must exist, delegation depth is capped. Nothing an agent writes is trusted to change dashboard state directly.
- Keep the guard in `app.ts` (loopback `Host`/`Origin`, JSON-only bodies) and the `127.0.0.1` bind. The only extra names it accepts are the owner's exact `AGENT_DASHBOARD_TRUSTED_HOSTS` (Tailscale Serve, see `docs/REMOTE_ACCESS.md`).
- Migrations in `db.ts` are append-only: users' databases have already run the existing ones. Add a new entry and never edit a shipped one.
- Run event files are append-only JSONL with a per-run `seq`. Write before publishing (the client merges fetched and pushed events by `seq`).
- Unknown stream-json lines must be ignored, not fail a run: the CLI adds event types over time.
- Windows matters: use `path`, not string concatenation; kill process trees with `taskkill /T` (see `killTree`); no POSIX-only shell commands in scripts.
- Comments explain _why_ in a short line above non-obvious code. No JSDoc boilerplate.

## Testing

- `pnpm test` (vitest): parser/transcript units and API tests in `server/test/` that drive the real runner with the fake agent. Add a scenario keyword to `fake-claude.mjs` when a test needs new agent behaviour.
- CI runs on pull requests only (nothing on `main`): one Linux job, `checks`, plus the Windows unit suite in parallel parts (`scripts/test-part.mjs`). Every job has a 300-second `timeout-minutes` budget (see `docs/CI.md`). If your change goes over, optimize it to fit; only if that is impossible, justify it in the PR and raise the budget to the new minimum. Rebalance the Windows parts when one nears the limit. CI uses two Vitest workers explicitly because the default leaves a core idle on two-core runners. Keep file isolation and per-test fixtures.
- `pnpm test:e2e` (Playwright): run after UI changes. With a preinstalled Chromium (a cloud container, or Chrome/Edge on Windows), set `PW_CHROMIUM` to its executable instead of installing browsers. Set `E2E_PORT` when another worktree already runs the suite on the default 5199.
- `pnpm validate` before reporting work as done. CI runs its checks on Linux and the unit suite on Windows too.
- Formatting: Prettier (`pnpm format`), print width 160.

## Token efficiency

Keep file reads and tool output scoped. Run focused tests while iterating, then the full validation once before delivery. Avoid repeating successful broad checks without a relevant change. Codex support lives in server/src/codex.ts and shared/src/codex-parser.ts; provider choices resolve task, role, then project defaults. See docs/TOKEN_EFFICIENCY.md for context budgets and limitations.
