// Runs one part of the Vitest suite so CI can spread the slow Windows API suites across parallel jobs.
// Parts are balanced by measured Windows durations (docs/CI.md). The last part runs every file not listed,
// so a new test file always runs somewhere; move it into a listed part only if it unbalances the split.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const parts = [
  ["server/test/task-stages.test.ts", "server/test/efficiency.test.ts", "server/test/app.test.ts", "server/test/restart.test.ts"],
  [
    "server/test/workspace-cleanup.test.ts",
    "server/test/github.test.ts",
    "server/test/model-routing.test.ts",
    "server/test/providers.test.ts",
    "server/test/dependencies.test.ts",
  ],
];

const part = Number(process.argv[2]);
if (!Number.isInteger(part) || part < 1 || part > parts.length + 1) {
  console.error(`Usage: node scripts/test-part.mjs <1-${parts.length + 1}>`);
  process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = part <= parts.length ? parts[part - 1] : parts.flat().flatMap((file) => ["--exclude", file]);
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", ...args], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
