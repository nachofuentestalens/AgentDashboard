// Keep the launcher alive across owner-confirmed restarts, including on Windows.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const server = new URL("../server/", import.meta.url);
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
    if (!stopping && code === 75) start();
    else process.exit(code ?? 0);
  });
}
function stop() {
  stopping = true;
  child?.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
start();
