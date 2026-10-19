# CI

Pull request checks must finish within a time budget: **300 seconds for the slowest job** (`CI_BUDGET_SECONDS` in `.github/workflows/ci.yml`). Jobs run in parallel, so the slowest job is what a pull request waits for. Runner queueing is not counted.

## Jobs

| Job                   | Runs                                            | Why it is needed                                                   |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `linux`               | format check, typecheck, full unit suite        | Code style, types, and Linux behaviour (cloud agents run on Linux) |
| `e2e`                 | Playwright against the built app (Ubuntu)       | The UI; it does not depend on the server's OS                      |
| `windows (part 1..3)` | the unit suite split by `scripts/test-part.mjs` | Windows is the primary platform (paths, process trees, CLI shims)  |
| `budget`              | `scripts/ci-budget.mjs`                         | Fails the run when any job exceeds the budget                      |

The process-heavy API suites take roughly ten times longer on Windows runners than on Linux (about 12 minutes of test time in total), so the Windows run is split into parts balanced by measured duration. Parts 1 and 2 list their files; part 3 runs every other file, so a new test always runs on Windows. When a part nears the budget, move a slow file from part 3 into a listed part, or add a part (the matrix in `ci.yml` and the lists in `test-part.mjs`). The `budget` job's summary shows each job's time.

The dashboard only merges pull requests whose checks all succeed, so a run over budget blocks the merge.

## When a change goes over budget

1. Optimize first: speed up the slow tests or fixtures, rebalance the Windows parts, or drop work that a cheaper check already covers.
2. If it truly cannot fit, explain why in the pull request description, then raise `CI_BUDGET_SECONDS` in `ci.yml` and the number above to the new minimum, not more.
