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

const { providerUsageFetcher } = await import("./usage.ts");
const { telegramConfig, telegramSender } = await import("./notify.ts");
const telegram = telegramConfig(process.env, dataDir);
const app = await buildApp({
  restart: process.env.AGENT_DASHBOARD_SUPERVISED ? () => void shutdown(75) : undefined,
  dataDir,
  webDir: process.env.AGENT_DASHBOARD_DEV ? undefined : webDir,
  logger: true,
  // Demo mode and e2e run the fake agent and must not read the owner's real usage.
  usage: process.env.AGENT_DASHBOARD_FAKE_CLAUDE ? undefined : providerUsageFetcher(),
  trustedHosts: process.env.AGENT_DASHBOARD_TRUSTED_HOSTS?.split(","),
  // Demo mode must not message the owner about the fake agent.
  notify: telegram && !process.env.AGENT_DASHBOARD_FAKE_CLAUDE ? telegramSender(telegram) : undefined,
});

// Loopback only, on purpose: the API starts processes and has no authentication.
await app.fastify.listen({ host: HOST, port });
console.log(`\n  AgentDashboard: http://${HOST}:${port}\n  Data: ${dataDir}\n`);

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(code);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
