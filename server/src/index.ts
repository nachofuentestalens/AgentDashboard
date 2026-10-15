import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./paths.ts";

// node:sqlite works without a flag from 22.13.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`AgentDashboard needs Node.js 22.13 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}

// Loaded after the check, since it imports node:sqlite.
const { buildApp } = await import("./app.ts");

const HOST = "127.0.0.1";
const port = Number(process.env.AGENT_DASHBOARD_PORT ?? 5190);
const dataDir = resolveDataDir();
const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = await buildApp({ dataDir, webDir: process.env.AGENT_DASHBOARD_DEV ? undefined : webDir, logger: true });

// Loopback only, on purpose: the API starts processes and has no authentication.
await app.fastify.listen({ host: HOST, port });
console.log(`\n  AgentDashboard: http://${HOST}:${port}\n  Data: ${dataDir}\n`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
