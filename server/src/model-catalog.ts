import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { MODEL_PRESETS, type ModelCatalog, type ModelOption } from "@ad/shared";
import { resolveLauncher, type Launcher } from "./claude.ts";
import { CODEX_CLI } from "./codex.ts";

// Query metadata only: never create a thread or send a model prompt.
export function discoverCodexModels(launcher: Launcher, timeoutMs = 15_000): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.prefix, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let requestId = 1;
    let bytes = 0;
    const models: ModelOption[] = [];
    const cursors = new Set<string>();
    const lines = readline.createInterface({ input: child.stdout });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      // EOF lets npm CLI wrappers reap their app-server child cleanly.
      const kill = setTimeout(() => child.kill(), 1000);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), timeoutMs);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    const list = (cursor?: string) =>
      send({ id: ++requestId, method: "model/list", params: { limit: 20, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    child.on("error", () => finish(new Error("Could not start Codex for model discovery.")));
    child.on("close", () => finish(new Error("Codex exited before returning its model catalog.")));
    child.stdin.on("error", () => finish(new Error("Could not communicate with Codex for model discovery.")));
    // Drain diagnostics without logging potentially sensitive CLI configuration.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error("Codex model catalog exceeded the size limit."));
    });
    lines.on("line", (line) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || message.id !== requestId) return;
      if (message.error) return finish(new Error("Codex rejected the model catalog request. Check its installation and sign-in."));
      if (requestId === 1) {
        send({ method: "initialized" });
        list();
        return;
      }
      if (!Array.isArray(message.result?.data)) return finish(new Error("Codex returned an invalid model catalog."));
      for (const item of message.result.data) {
        if (!item || item.hidden === true || typeof item.model !== "string" || !/^[A-Za-z0-9._\-[\]]{1,64}$/.test(item.model)) continue;
        if (models.some((model) => model.id === item.model)) continue;
        models.push({ id: item.model, label: typeof item.displayName === "string" ? item.displayName.slice(0, 120) : item.model });
        if (models.length === 5) return finish();
      }
      const cursor = message.result.nextCursor;
      if (typeof cursor === "string" && cursor && !cursors.has(cursor) && cursors.size < 10) {
        cursors.add(cursor);
        list(cursor);
      } else if (models.length) finish();
      else finish(new Error("Codex returned no visible models. Check its installation and sign-in."));
    });
    send({ id: requestId, method: "initialize", params: { clientInfo: { name: "agent_dashboard", title: "AgentDashboard", version: "1.0.0" } } });
  });
}

export async function loadModelCatalog(dataDir: string, configuredPath: string, launcher?: Launcher): Promise<ModelCatalog> {
  const cacheFile = path.join(dataDir, "codex-models.json");
  const checkedAt = new Date().toISOString();
  try {
    const models = await discoverCodexModels(launcher ?? resolveLauncher(configuredPath, process.env, CODEX_CLI));
    // An unwritable cache should not hide a successfully discovered catalog.
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(models));
    } catch {
      /* Keep the in-memory result. */
    }
    return { presets: { ...MODEL_PRESETS, codex: models }, codex: { source: "cli", checkedAt, error: null } };
  } catch {
    let models: ModelOption[] = [];
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Array.isArray(saved))
        models = saved.filter((m) => m && typeof m.id === "string" && /^[A-Za-z0-9._\-[\]]{1,64}$/.test(m.id) && typeof m.label === "string").slice(0, 5);
    } catch {
      /* No prior catalog: the CLI-default option still works. */
    }
    return {
      presets: { ...MODEL_PRESETS, codex: models },
      codex: {
        source: models.length ? "cache" : "unavailable",
        checkedAt,
        error: `Could not refresh Codex models. ${models.length ? "Showing the last saved list." : "Use CLI default or a custom model ID."} Check the Codex path and sign-in, then restart the server.`,
      },
    };
  }
}
