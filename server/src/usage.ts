import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, QuotaReading } from "@ad/shared";

export type UsageReading = Pick<QuotaReading, "window" | "usedPercent" | "resetsAt">;
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

// Codex limits arrive with its runs' token counts (shared/src/parser.ts), so it has no fetcher.
export function providerUsageFetcher(fetchImpl: typeof fetch = fetch): UsageFetcher {
  return async (provider) => (provider === "claude" ? fetchClaudeUsage(fetchImpl) : null);
}
