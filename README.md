# AgentDashboard

A local web dashboard for directing Claude Code agents on personal game projects. It runs on your PC, uses the `claude` CLI you already have (and your existing subscription), and keeps every conversation, run and cost in one place.

**Status: Phase 1.** Projects, chat tasks with live streaming and session resume, stop/retry, run history, and cost tracking. See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next (design docs and proposals, multi-step workflows, personas, playtest and balance steps).

## Requirements

- Windows 11 (macOS and Linux work too)
- [Node.js 22.13+](https://nodejs.org/) (LTS 22 or 24)
- [pnpm](https://pnpm.io/installation): `npm install -g pnpm` or `corepack enable`
- [Claude Code](https://code.claude.com/docs) installed and logged in (`claude` works in a terminal)
- git

## Run it

```powershell
pnpm install
pnpm start
```

Open http://127.0.0.1:5190. `pnpm start` builds the web app and serves everything from one process.

To work on the dashboard itself, use `pnpm dev` instead (API on 5190 with auto-restart, Vite on http://127.0.0.1:5173 with hot reload).

### Try it without spending anything

```powershell
pnpm dev:demo
```

This runs a built-in fake agent instead of Claude Code and keeps its data in `.data/demo`, separate from your real data. Put `[tool]`, `[slow]`, `[fail]` or `[crash]` in a message to see a tool call, a long run (try Stop), a failed run (try Retry) or a crash. You can also type `fake` as the Claude Code path in Settings.

## First steps

1. **Settings → Save and check Claude Code.** It searches PATH (and `%USERPROFILE%\.local\bin`) for `claude.exe` or `claude.cmd`. If it isn't found, paste the full path.
2. **New project** (the + in the sidebar). Point it at the top folder of a game's git repository, or at an empty folder and click **Create git repository there**.
3. **Start a chat** from the project's Tasks tab. Replies stream in live, and every follow-up continues the same Claude Code session.

## How agents run

Each message starts `claude -p --output-format stream-json` in the project folder. The prompt goes through stdin, never through the command line.

- **Model and effort**: by default Opus 5.5 at medium effort. Change the default per project (Settings tab) or per chat (the pickers under the message box).
- **Can edit files** (on by default): the agent may edit files (`--permission-mode acceptEdits`) and run only the commands listed in the project's **Allowed commands** (by default git, pnpm, npm, npx, node and PowerShell). Headless agents can't ask for permission, so anything else is refused and the agent will tell you.
- **Read-only** (toggle off): the agent can read, search and browse, but can't edit or run commands.
- **Phase 1 agents work directly in your project folder.** Commit before letting one loose. Phase 3 gives each task its own git worktree and branch.

## Where data lives

- Windows: `%LOCALAPPDATA%\AgentDashboard\`. Elsewhere: `~/.local/share/agent-dashboard/`. Override with `AGENT_DASHBOARD_DATA`.
- `dashboard.db` (SQLite) holds projects, tasks, messages and runs. `runs/<id>.jsonl` holds each run's raw event stream.
- Nothing is written into your game repositories by the dashboard itself.

## Security

The server listens on `127.0.0.1` only and has no login, because it starts processes on your machine. It refuses requests whose `Host` or `Origin` isn't loopback (which blocks DNS rebinding and other websites calling it), and accepts JSON bodies only. Don't expose the port to a network.

## Develop

| Command                      | What it does                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev` / `pnpm dev:demo` | API + Vite with hot reload (real / fake agent)                                                                                 |
| `pnpm test`                  | Unit and API tests (vitest, fake agent, about 3 s)                                                                             |
| `pnpm test:e2e`              | Builds, starts the server with the fake agent, drives Chromium (Playwright). Run `npx playwright install chromium` once first. |
| `pnpm typecheck`             | TypeScript across all packages                                                                                                 |
| `pnpm validate`              | typecheck + test + e2e: the gate before committing                                                                             |
| `pnpm format`                | Prettier                                                                                                                       |

See [CLAUDE.md](CLAUDE.md) for the architecture and conventions.
