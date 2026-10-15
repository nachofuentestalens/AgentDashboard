import os from "node:os";
import path from "node:path";

// Where the app keeps its database and run logs. Never inside a project repo, so agents working
// in a repo cannot read or rewrite the dashboard's own records.
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AGENT_DASHBOARD_DATA) return path.resolve(env.AGENT_DASHBOARD_DATA);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "AgentDashboard");
  }
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "agent-dashboard");
}
