// Keep the launcher alive across owner-confirmed restarts, including on Windows.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = new URL("../server/", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("package.json", server));
let child;
let stopping = false;
function start() {
  child = spawn(
    process.execPath,
    ["--import", pathToFileURL(require.resolve("tsx")).href, "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("src/index.ts", server))],
    {
      cwd: fileURLToPath(server),
      env: { ...process.env, AGENT_DASHBOARD_SUPERVISED: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (!stopping && code === 75) {
      update();
      start();
    } else process.exit(code ?? 0);
  });
}

function run(command, args) {
  // No terminal prompts: a credential prompt would hang the restart with nobody watching.
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.status === 0;
}
function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function pnpm(args) {
  // pnpm sets npm_execpath to its own script, which runs without a shell; plain `pnpm` is a .cmd shim on Windows.
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) return /\.c?js$/.test(execPath) ? run(process.execPath, [execPath, ...args]) : run(execPath, args);
  console.warn(`[restart] pnpm not found (start the dashboard through pnpm); skipped pnpm ${args.join(" ")}`);
  return false;
}

// A confirmed restart first fast-forwards the dashboard checkout so the new process runs the latest code.
function update() {
  if (process.env.AGENT_DASHBOARD_UPDATE_ON_RESTART === "0") return;
  const before = git(["rev-parse", "HEAD"]);
  if (!before) return console.warn("[restart] not a Git checkout; restarting without updating");
  console.log("[restart] pulling the latest version…");
  if (!run("git", ["pull", "--ff-only"])) return console.warn("[restart] git pull failed; restarting the current version");
  const after = git(["rev-parse", "HEAD"]);
  if (!after || after === before) return console.log("[restart] already up to date");
  const changed = (git(["diff", "--name-only", before, after]) ?? "").split("\n");
  if (changed.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(file)) && !pnpm(["install", "--frozen-lockfile"]))
    console.warn("[restart] pnpm install failed");
  // Vite serves the web app in development; otherwise the server serves the built bundle.
  if (!process.env.AGENT_DASHBOARD_DEV && !pnpm(["build"])) console.warn("[restart] web build failed; the previous bundle stays in place");
}

function stop() {
  stopping = true;
  child?.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
start();
