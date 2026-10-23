# AgentDashboard

A local web dashboard for directing Claude Code or ChatGPT (via Codex CLI) agents on personal game projects. It uses your installed, authenticated CLIs and records conversations, runs and reported usage.

**Status: Phase 1.** Projects, chat tasks with live streaming and session resume, stop/retry, run history, and cost tracking. See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next (design docs and proposals, multi-step workflows, personas, playtest and balance steps).

## Requirements

- Windows 11 (macOS and Linux work too)
- [Node.js 22.13+](https://nodejs.org/) (LTS 22 or 24)
- [pnpm](https://pnpm.io/installation) 12: `npm install -g pnpm`, then `pnpm self-update` (or `corepack enable`)
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
3. **Start a chat** from the project's Tasks tab. Replies stream in live, and every follow-up continues the same provider session.

## How agents run

Each message starts `claude -p --output-format stream-json` or `codex exec --json` in the project folder. The prompt goes through stdin, never through the command line.

- **Model and effort**: by default Sonnet 5 at medium effort. Change the default per project (Settings tab) or per chat (the pickers under the message box).
- **Can edit files** (on by default): ordinary owner chats get full filesystem, command and network access without interactive approval prompts (Claude `bypassPermissions`; Codex `danger-full-access` with approvals `never`). Repository edits still belong in the assigned task worktree. Studio roles retain their department restrictions and configured allowed commands; reviews and handoff preparation remain read-only.
- **Read-only** (toggle off): the agent can read, search and browse, but can't edit or run commands.
- **Writing agents use isolated task worktrees.** A new writing task starts from the last commit; uncommitted project-folder changes stay where they are and the agent does not see them. The server saves WIP checkpoints after runs and publishes them as GitHub draft PRs when `origin` and authentication are configured. Use **Pause & checkpoint** to stop and save work; **Merge on GitHub** requires passing checks and leaves the running checkout unchanged. See [setup and recovery](docs/WORKSPACES.md).

## Switching Claude / ChatGPT

Install Codex CLI and run `codex login` once using your ChatGPT account. In Settings, use **Save and check Codex**; an empty CLI path searches PATH. Choose **ChatGPT (Codex)** in the **Provider** selector below the message box. Defaults can also be set in Settings, project settings, and each studio role. Leave the Codex model empty to use your CLI configuration.

Same-provider follow-ups resume the session. Switching providers starts a new session with up to 8,000 characters of recent conversation; older messages and tool history are not transferred. The full dashboard history remains visible. This uses Codex, not a browser ChatGPT conversation. See [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Codex reports tokens, but this adapter does not receive a dollar cost. **Cost not reported** does not mean free; dollar budgets are not a reliable cap on Codex subscription usage. Claude's Allowed commands rules do not apply to Codex. Codex uses full access for editable owner chats, workspace-write for writing studio roles, and read-only for other runs. See [OpenAI's sandbox documentation](https://learn.chatgpt.com/docs/sandboxing).

## Token efficiency

Every work run instructs the agent to assess the task and current step **before tools or implementation**, recommend the least expensive capable model and sufficient effort, and reassess at phase boundaries. Keeping the current settings continues in the same run, avoiding a separate planner call. A worthwhile change ends the turn with a validated `model-review` and `context-handoff`; the dashboard starts the next step in a fresh session with the original request and summary. Model changes are limited to the selected provider's catalog (or the current custom model), supported provider effort levels, and three automatic changes per owner message. Usage remains cumulative, and changes made manually during a run take precedence. Model availability and capability are not exact price guarantees. Missing/malformed assessments produce a notice; this is an agent instruction, not a CLI-level guarantee that no tool can execute first.

New projects use Sonnet/medium; new studio roles use Sonnet/medium or low. Existing saved model/effort choices are preserved: lower them in project/role settings if desired. Choose low effort for straightforward work and reserve higher effort for difficult tasks.

Role context provides a bounded document catalog and reference paths, not document bodies. Agents read relevant documents on demand. Unchanged catalogs are omitted on follow-ups. Prompts request focused phases, bounded output, concise replies, and no speculative delegation.

Open **Context & usage** in a task to prepare and review a compact handoff. **Prepare handoff** spends one read-only agent run summarizing the current session; you can also write a summary yourself without a model call. **Use compact handoff** keeps the complete dashboard transcript and starts a fresh CLI session on your next message, carrying only your summary and current project instructions. Include requirements, constraints, relevant files, completed checks, and remaining work. Optional automatic handoffs use a validated summary from the latest successful phase when you send the next message; they never start work on their own.

Tasks now start with **unlimited token and tool-call allowances**. On upgrade, migration 11 clears existing task allowances and saved allowance defaults once, preserving usage history. You can opt into limits later in Settings or a task's Context & usage; blank means unlimited. Retries, provider switches and compaction do not reset usage. If you set a token checkpoint, it is checked when final provider usage arrives; tool checkpoints stop after observed tools finish. Both include delegated descendants and can overshoot. Provider subscription limits, coordinator reserves and scheduling checks still apply; unlimited task allowances do not remove them.

Run footers separate fresh input, cached input, cache writes and output, and show tool-call counts. Task totals include delegated work; session age helps identify long conversations. New studio templates ask before delegating, and the default studio concurrency is one. Existing saved model, concurrency and autonomy choices remain unchanged.

Use one chat per focused task. Keep the provider stable during that task to retain its session context. Studio departments set to Auto can create additional agent tasks; choose Ask before delegating for tighter control. Dollar budgets only gate queued role runs using estimates: plain chats and in-progress runs are not capped. These changes reduce avoidable overhead, not guarantee a fixed token ceiling.

See [the setup audit](docs/TOKEN_EFFICIENCY.md) for findings and limitations.

## Where data lives

- Windows: `%LOCALAPPDATA%\AgentDashboard\`. Elsewhere: `~/.local/share/agent-dashboard/`. Override with `AGENT_DASHBOARD_DATA`.
- `dashboard.db` (SQLite) holds projects, tasks, messages and runs. `runs/<id>.jsonl` holds each run's raw event stream.
- Nothing is written into your game repositories by the dashboard itself.

## Security

The server listens on `127.0.0.1` only and has no login, because it starts processes on your machine. It refuses requests whose `Host` or `Origin` isn't loopback (which blocks DNS rebinding and other websites calling it), and accepts JSON bodies only. Don't expose the port to a network.

To reach it from your phone, put a private, authenticated proxy in front of it, such as Tailscale Serve (`tailscale serve --bg 5190`, never `tailscale funnel`), and list the proxy's host name in `AGENT_DASHBOARD_ALLOWED_HOSTS` (comma-separated, e.g. `desktop-name.tailnet.ts.net`) before starting the server. Anyone who can reach those hosts can run agents on your machine.

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

Codex model choices refresh once whenever the server starts (`pnpm start`, `pnpm dev`, or a dev-server restart). All selectors use the first five visible, distinct entries in the installed CLI catalog order. Discovery uses `codex app-server` → `model/list` and sends no inference prompt. Codex may return cached/bundled metadata depending on its version/configuration; keep the CLI updated. If discovery fails, Settings shows a notice and the dashboard uses its last saved list; with no saved list, CLI default and custom model IDs remain available. Existing selected models are preserved even if no longer in the top five.
