# CI

The repository is public, so GitHub-hosted runners cost no Actions minutes. If it ever becomes private again, minutes are metered (each job rounds up to a whole minute, Windows bills double): a run then costs about 27 minutes, so move the Windows job to manual dispatch or a self-hosted runner first.

## Jobs

All jobs run on every pull request push and on manual dispatch. Nothing runs on pushes to `main`: a squash merge lands the tree its pull request already passed.

| Job                   | Runs                                                                       | Why it is needed                                                   |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `checks`              | format check, typecheck, full unit suite, Playwright against the built app | Code style, types, Linux behaviour (cloud agents run on Linux), UI |
| `windows (part 1..3)` | the unit suite split by `scripts/test-part.mjs`                            | Windows is the primary platform (paths, process trees, CLI shims)  |

The dashboard only merges pull requests whose checks all succeed. `pnpm validate` runs the same checks locally; on Windows, set `PW_CHROMIUM` to an installed Chrome or Edge and `E2E_PORT` if another worktree is running the suite.

## Time budget

Every job has `timeout-minutes: 5` (300 seconds, including setup), so a pull request that goes over fails its check and blocks the merge. Jobs run in parallel, so the slowest job is what a pull request waits for.

The process-heavy API suites take roughly ten times longer on Windows runners than on Linux, so the Windows run is split into parts balanced by measured duration. Parts 1 and 2 list their files; part 3 runs every other file, so a new test always runs on Windows. When a part nears the budget, move a slow file from part 3 into a listed part, or add a part (the matrix in `ci.yml` and the lists in `test-part.mjs`).

## When a change goes over budget

1. Optimize first: speed up the slow tests or fixtures, rebalance the Windows parts, or drop work that a cheaper check already covers.
2. If it truly cannot fit, explain why in the pull request description, then raise `timeout-minutes` in `ci.yml` and the number above to the new minimum, not more.
