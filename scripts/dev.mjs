// Starts the API server (restarts on change) and the Vite dev server together.
// `pnpm dev` uses your real Claude Code; `pnpm dev:demo` uses the free fake agent and a separate data folder.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo = process.argv.includes("--demo");
const env = { ...process.env, AGENT_DASHBOARD_DEV: "1" };
if (demo) {
  env.AGENT_DASHBOARD_FAKE_CLAUDE = "1";
  env.AGENT_DASHBOARD_DATA ??= path.join(root, ".data", "demo");
}

const colors = { server: "\x1b[35m", web: "\x1b[36m" };
const children = [];

function run(name, args) {
  // pnpm is a .cmd on Windows, which needs a shell; the arguments here are fixed.
  const child = spawn("pnpm", args, { cwd: root, env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const forward = (stream, out) => stream.on("data", (chunk) => out.write(chunk.toString().replace(/^(?=.)/gm, prefix)));
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown();
  });
  children.push(child);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("server", ["--filter", "@ad/server", "dev"]);
run("web", ["--filter", "@ad/web", "dev"]);
console.log(`\n  Open http://127.0.0.1:5173${demo ? "  (demo mode: fake agent, data in .data/demo)" : ""}\n`);
