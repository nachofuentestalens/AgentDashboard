import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexRateLimits, type Provider, type QuotaReading } from "@ad/shared";

// `observedAt`: when the source saw these numbers, for sources that can be older than a later reading.
export type UsageReading = Pick<QuotaReading, "window" | "usedPercent" | "resetsAt"> & { observedAt?: string };
// Reads a provider's current limits. Throws with a message for the owner when it cannot.
export type UsageFetcher = (provider: Provider) => Promise<UsageReading[] | null>;

// The endpoint Claude Code's own `/usage` reads. The CLI's stream only reports the five-hour
// window's reset time (a percentage only near the limit, the week not at all), so this is the
// source for both windows' use and resets.
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// `utilization` here is already a percentage (42 means 42%), unlike the stream's fraction.
export function parseClaudeUsage(body: unknown): UsageReading[] {
  if (!isObject(body)) return [];
  const out: UsageReading[] = [];
  for (const [key, window] of [
    ["five_hour", "session"],
    ["seven_day", "weekly"],
  ] as const) {
    const w = body[key];
    if (!isObject(w)) continue;
    const used = typeof w.utilization === "number" && Number.isFinite(w.utilization) && w.utilization >= 0 ? Math.min(100, w.utilization) : null;
    const reset = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    out.push({ window, usedPercent: used, resetsAt: Number.isNaN(reset) ? null : new Date(reset).toISOString() });
  }
  return out;
}

function claudeCredentialsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
}

// Uses the CLI's own sign-in. The token is never refreshed here: that would rotate the refresh
// token under the CLI. An expired one is renewed by the next Claude run.
async function fetchClaudeUsage(fetchImpl: typeof fetch): Promise<UsageReading[]> {
  let oauth: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeCredentialsPath(), "utf8")) as unknown;
    oauth = isObject(parsed) && isObject(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
  } catch {
    oauth = undefined;
  }
  const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
  if (!token) throw new Error("No Claude sign-in found. Run `claude` and log in with your subscription to read usage.");
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= Date.now()) throw new Error("The Claude sign-in has expired; the next Claude run renews it.");
  const res = await fetchImpl(CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Claude rejected the sign-in; the next Claude run renews it.");
  if (!res.ok) throw new Error(`Claude usage request failed (HTTP ${res.status}).`);
  const readings = parseClaudeUsage(await res.json());
  if (!readings.length) throw new Error("Claude's usage response had no limit windows.");
  return readings;
}

function codexSessionsDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

// A rollout line's `token_count` limits, or null. Other limit ids (per-model pools) are not the plan's windows.
export function parseCodexRolloutLine(line: string): UsageReading[] | null {
  if (!line.includes('"rate_limits"')) return null;
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  const payload = isObject(data.payload) ? data.payload : data;
  const limits = payload.rate_limits;
  if (!isObject(limits) || (typeof limits.limit_id === "string" && limits.limit_id !== "codex")) return null;
  const at = typeof data.timestamp === "string" ? Date.parse(data.timestamp) : NaN;
  // Older CLIs give `resets_in_seconds`, relative to when the line was written.
  const events = codexRateLimits(payload, Number.isNaN(at) ? Date.now() : at);
  const readings = events.flatMap((e) => (e.kind === "rate_limit" ? [{ window: e.window, usedPercent: e.usedPercent, resetsAt: e.resetsAt }] : []));
  if (!readings.length) return null;
  const observedAt = Number.isNaN(at) ? undefined : new Date(at).toISOString();
  return readings.map((r) => ({ ...r, observedAt }));
}

// The newest rollout files, from the latest YYYY/MM/DD folders.
function recentRollouts(root: string, limit: number): string[] {
  const dirsDesc = (dir: string) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a));
  const files: string[] = [];
  outer: for (const y of dirsDesc(root))
    for (const m of dirsDesc(path.join(root, y)))
      for (const d of dirsDesc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        for (const f of fs.readdirSync(dir)) if (f.startsWith("rollout-") && f.endsWith(".jsonl")) files.push(path.join(dir, f));
        if (files.length >= limit) break outer;
      }
  return files
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.f);
}

// The last `bytes` of a file: rollouts grow to megabytes, and the latest limits are near the end.
function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// `codex exec --json` does not print its limits, but every Codex session (the dashboard's and the
// owner's own) writes them to its rollout file with each token count. The newest one is the reading.
export function readCodexUsage(root = codexSessionsDir()): UsageReading[] {
  if (!fs.existsSync(root)) throw new Error("No Codex sessions found. Run `codex` once to read its usage.");
  for (const file of recentRollouts(root, 20)) {
    const lines = readTail(file, 512 * 1024).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const readings = parseCodexRolloutLine(lines[i]!);
      if (readings) return readings;
    }
  }
  throw new Error("No recent Codex session reported its limits yet.");
}

export function providerUsageFetcher(fetchImpl: typeof fetch = fetch): UsageFetcher {
  return async (provider) => (provider === "claude" ? fetchClaudeUsage(fetchImpl) : readCodexUsage());
}
