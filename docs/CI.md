# CI

The repository is private, so GitHub Actions minutes are metered: each job rounds up to a whole minute, and Windows runners bill at twice the Linux rate. CI is shaped to keep that low while the dashboard still gets the successful check it needs before merging a task's pull request.

## Workflows

| Workflow                   | Trigger                                   | Runs                                                                               | Billed per run |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `ci.yml` (job `checks`)    | every pull request push, manual           | format check, typecheck, full unit suite, Playwright against the built app (Linux) | about 3 min    |
| `windows.yml` (parts 1..3) | manual only (Actions tab → Windows → Run) | the unit suite split by `scripts/test-part.mjs` on `windows-latest`                | about 22 min   |

Earlier CI ran three Windows jobs, two Linux jobs and a budget job on every pull request push and again on every push to `main`: about 27 billed minutes per run, and the dashboard's task flow can make 30 runs a day.

- No run on `main`: a squash merge lands the tree its pull request already passed.
- One Linux job: each separate job pays checkout, install and minute rounding again.
- Windows is the primary platform, but the developer machine is Windows: `pnpm validate` there runs the same unit suite natively for free. Agents run it before reporting work as done. Start `windows.yml` by hand before a release or after changes to process handling, paths or CLI discovery when you have not validated locally.

## Local checks

`pnpm validate` is the full CI locally (format, types, unit suite, e2e). On Windows, set `PW_CHROMIUM` to an installed Chrome or Edge instead of installing Playwright browsers, and `E2E_PORT` if another worktree is running the suite.

## Time budget

The `checks` job has `timeout-minutes: 5` (300 seconds, including setup). A pull request that goes over fails its check, and the dashboard only merges pull requests whose checks all succeed.

1. Optimize first: speed up the slow tests or fixtures, or drop work that a cheaper check already covers.
2. If it truly cannot fit, explain why in the pull request description, then raise `timeout-minutes` in `ci.yml` and the number above to the new minimum, not more.

On `windows.yml`, the process-heavy API suites take roughly ten times longer than on Linux, so the run is split into parts balanced by measured duration. Parts 1 and 2 list their files; part 3 runs every other file, so a new test always runs on Windows. When a part nears its timeout, move a slow file from part 3 into a listed part, or add a part (the matrix in `windows.yml` and the lists in `test-part.mjs`).

## Free alternatives

- **Public repository**: standard GitHub-hosted runners are free and unmetered for public repositories.
- **Self-hosted runner**: register this Windows PC as a runner (Settings → Actions → Runners) and change `runs-on` to `[self-hosted, windows]`. Jobs then cost no minutes and still produce the GitHub check the dashboard waits for, but they only run while the PC is on and they execute pull request code on it. Use it only with a private repository and trusted contributors.
