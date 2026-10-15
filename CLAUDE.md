# AgentDashboard: notes for coding agents

A local dashboard (Node + React) that runs Claude Code CLI agents on the developer's game projects. Single user, loopback only, Windows 11 first.

## Layout

- `shared/`: types (`models.ts`), zod request schemas (`schemas.ts`), the stream-json parser (`parser.ts`) and the transcript reducer (`transcript.ts`). Pure code, used by both server and web. Imported as TypeScript source (`@ad/shared`); there is no build step.
- `server/`: Fastify API run with tsx.
  - `app.ts`: routes, the loopback/origin guard, SSE `/api/events`, static web serving.
  - `store.ts`: **all SQL**. `db.ts`: `node:sqlite` connection and append-only migrations.
  - `runner.ts`: spawns `claude`, records events to `runs/<id>.jsonl`, settles run outcomes, stop/retry, one run per task.
  - `claude.ts`: finds the CLI (PATH, `claude.exe`, npm `.cmd` shims) and builds its arguments.
  - `git.ts`: repository checks. `fake/fake-claude.mjs`: the stand-in agent for tests and demo mode.
- `web/`: React 19 + Vite + Tailwind 4 + TanStack Query + React Router. `live.ts` applies server pushes to the query cache.
- `e2e/`: Playwright tests against the built app with the fake agent.
- `docs/ROADMAP.md`: phases and progress. Update its checkboxes when an item lands.

## Rules

- Workflow and run state changes happen on the server (`runner.ts`, later a workflow state machine), never in React components. The UI only calls the API and renders.
- The prompt goes to the agent through **stdin**. Never put user or agent text in process arguments, and never spawn through a shell (`shell: true`). Model ids and tool rules that do become arguments are validated by `shared/src/schemas.ts`.
- Keep the guard in `app.ts` (loopback `Host`/`Origin`, JSON-only bodies) and the `127.0.0.1` bind.
- Migrations in `db.ts` are append-only: users' databases have already run the existing ones. Add a new entry and never edit a shipped one.
- Run event files are append-only JSONL with a per-run `seq`. Write before publishing (the client merges fetched and pushed events by `seq`).
- Unknown stream-json lines must be ignored, not fail a run: the CLI adds event types over time.
- Windows matters: use `path`, not string concatenation; kill process trees with `taskkill /T` (see `killTree`); no POSIX-only shell commands in scripts.
- Comments explain _why_ in a short line above non-obvious code. No JSDoc boilerplate.

## Testing

- `pnpm test` (vitest): parser/transcript units and API tests in `server/test/` that drive the real runner with the fake agent. Add a scenario keyword to `fake-claude.mjs` when a test needs new agent behaviour.
- `pnpm test:e2e` (Playwright): run after UI changes. In a cloud container with a preinstalled Chromium, set `PW_CHROMIUM` to its executable instead of installing browsers.
- `pnpm validate` before reporting work as done. CI runs it on Windows and Linux.
- Formatting: Prettier (`pnpm format`), print width 160.
