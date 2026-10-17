import {
  PROVIDERS,
  type CoordinatorAction,
  type CoordinatorConfig,
  type Provider,
  type ProviderPlan,
  type QuotaLevel,
  type QuotaReading,
  type QuotaWindow,
  type QuotaWindowView,
} from "@ad/shared";
import type { ProviderHold } from "./scheduler.ts";

// The coordinator's decisions are pure functions of a snapshot, like the scheduler's, so the rules
// can be tested as tables. coordination.ts builds the snapshot and applies what comes out.
// See docs/COORDINATOR.md.

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
// In a session's last half hour what is left resets unused anyway, so conserving stops (the reserve stays).
export const LAST_CALL_MS = 30 * 60_000;
// fillIdle starts backlog work only this close to a session reset, and only with this much room above the reserve.
export const FILL_WINDOW_MS = 2 * HOUR;
export const FILL_MIN_HEADROOM_PCT = 25;

const label = (p: Provider) => PROVIDERS.find((x) => x.id === p)!.label;
const round = (n: number) => Math.round(n);
const RANK: Record<QuotaLevel, number> = { unknown: 0, ok: 1, conserve: 2, reserve: 3, exhausted: 4 };

export interface RunCoordinator {
  // Called before each scheduling pass: applies automatic decisions and returns the provider holds.
  beforeSchedule(): Map<Provider, ProviderHold>;
  observe(reading: Omit<QuotaReading, "at">): void;
  // Re-reads the providers' usage APIs; without force, skipped right after a read.
  refreshUsage(force?: boolean): Promise<void>;
}

// The next local weekly reset of a plan, strictly after now.
export function nextWeeklyReset(plan: ProviderPlan, now: number): number {
  const d = new Date(now);
  d.setHours(plan.weeklyResetHour, 0, 0, 0);
  d.setDate(d.getDate() + ((plan.weeklyResetDay - d.getDay() + 7) % 7));
  if (d.getTime() <= now) d.setDate(d.getDate() + 7);
  return d.getTime();
}

export interface WindowInput {
  window: QuotaWindow;
  reading: QuotaReading | null;
  plan: ProviderPlan;
  now: number;
  // Reported tokens of the dashboard's runs on this provider since a time.
  tokensSince: (ms: number) => number;
}

// How much of a window is used. A reading is the truth when it was taken; tokens the dashboard
// spent since then are added when the owner gave a cap to scale them by. Use outside the dashboard
// only shows up in the next reading.
export function estimateWindow({ window, reading, plan, now, tokensSince }: WindowInput): Omit<QuotaWindowView, "level" | "paceLimitPct"> {
  const cap = window === "session" ? plan.sessionTokenCap : plan.weeklyTokenCap;
  const length = window === "session" ? plan.sessionHours * HOUR : WEEK;
  const planReset = window === "weekly" ? nextWeeklyReset(plan, now) : null;
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const pct = (tokens: number) => (cap ? (tokens / cap) * 100 : 0);
  const readingReset = reading?.resetsAt ? Date.parse(reading.resetsAt) : null;

  if (reading && (readingReset === null || readingReset > now)) {
    let used = reading.rejected ? 100 : reading.usedPercent;
    let source: QuotaWindowView["source"] = reading.source;
    if (used === null && cap) {
      used = pct(tokensSince(now - length));
      source = "estimate";
    } else if (used !== null && cap && !reading.rejected) {
      const extra = pct(tokensSince(Date.parse(reading.at)));
      if (extra > 0) {
        used += extra;
        source = "estimate";
      }
    }
    return { window, usedPercent: used === null ? null : Math.min(100, used), source, resetsAt: iso(readingReset ?? planReset), readingAt: reading.at };
  }
  if (reading && readingReset !== null) {
    // The window reset after the reading. A weekly window keeps the provider's cadence; a session
    // window only starts again with the next use, so its reset is unknown.
    let next: number | null = null;
    if (window === "weekly") for (next = readingReset; next <= now; next += WEEK);
    return { window, usedPercent: Math.min(100, pct(tokensSince(readingReset))), source: "reset", resetsAt: iso(next), readingAt: reading.at };
  }
  if (cap) {
    const start = planReset !== null ? planReset - WEEK : now - length;
    return { window, usedPercent: Math.min(100, pct(tokensSince(start))), source: "estimate", resetsAt: iso(planReset), readingAt: null };
  }
  return { window, usedPercent: null, source: "none", resetsAt: iso(planReset), readingAt: null };
}

export function windowLevel(view: Omit<QuotaWindowView, "level" | "paceLimitPct">, config: CoordinatorConfig, now: number): QuotaWindowView {
  const ceiling = 100 - (view.window === "session" ? config.sessionReservePct : config.weeklyReservePct);
  let pace: number | null = null;
  if (view.window === "weekly" && view.resetsAt) {
    const elapsed = Math.min(1, Math.max(0, 1 - (Date.parse(view.resetsAt) - now) / WEEK));
    pace = Math.min(ceiling, ceiling * elapsed + config.weeklyBurstPct);
  }
  const used = view.usedPercent;
  const lastCall = view.window === "session" && view.resetsAt !== null && Date.parse(view.resetsAt) - now <= LAST_CALL_MS;
  const level: QuotaLevel =
    used === null
      ? "unknown"
      : used >= 100
        ? "exhausted"
        : used >= ceiling
          ? "reserve"
          : !lastCall && (used >= ceiling - config.conserveMarginPct || (pace !== null && used > pace))
            ? "conserve"
            : "ok";
  return { ...view, level, paceLimitPct: pace };
}

export function until(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const h = Math.floor(minutes / 60);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

// The provider's level is its worse window; the reason names that window.
export function providerLevel(provider: Provider, session: QuotaWindowView, weekly: QuotaWindowView, config: CoordinatorConfig, now: number) {
  const worst = RANK[weekly.level] > RANK[session.level] ? weekly : session;
  const name = worst.window === "session" ? "Session" : "Weekly";
  const resets = worst.resetsAt ? `; resets in ${until(worst.resetsAt, now)}` : "";
  const used = round(worst.usedPercent ?? 0);
  const reserve = worst.window === "session" ? config.sessionReservePct : config.weeklyReservePct;
  const reason = {
    unknown: `No usage reading for ${label(provider)} yet. Enter one from its usage page, or set token caps.`,
    ok: `${name} usage ${used}%: room to work${resets}.`,
    conserve:
      worst.paceLimitPct !== null && used > worst.paceLimitPct
        ? `Weekly usage ${used}% is ahead of an even pace (${round(worst.paceLimitPct)}% by now); only priority ${config.conservePriority}+ starts${resets}.`
        : `${name} usage ${used}% is close to your ${reserve}% reserve; only priority ${config.conservePriority}+ starts${resets}.`,
    reserve: `${name} usage ${used}% reached the ${reserve}% reserve kept for you; agents wait${resets}.`,
    exhausted: `${name} limit reached${resets}.`,
  }[worst.level];
  return { level: worst.level, reason };
}

export interface ProviderState {
  level: QuotaLevel;
  reason: string;
  session: QuotaWindowView;
}

// What the scheduler holds back per provider. Only in auto mode: in advise mode the owner decides.
export function providerHolds(states: Map<Provider, ProviderState>, config: CoordinatorConfig): Map<Provider, ProviderHold> {
  const holds = new Map<Provider, ProviderHold>();
  if (config.mode !== "auto") return holds;
  for (const [provider, s] of states) {
    if (s.level === "conserve") holds.set(provider, { minPriority: config.conservePriority, reason: `Coordinator: ${label(provider)}: ${s.reason}` });
    else if (s.level === "reserve" || s.level === "exhausted")
      holds.set(provider, { minPriority: null, reason: `Coordinator: ${label(provider)}: ${s.reason}` });
  }
  return holds;
}

interface TaskRef {
  taskId: string;
  title: string;
  provider: Provider;
  priority: number;
}

export interface CoordinatorInput {
  now: number;
  config: CoordinatorConfig;
  providers: Map<Provider, ProviderState>;
  // Role runs only: plain chats are the owner's own use and never touched.
  running: (TaskRef & { runId: string; emergency: boolean; forced: boolean })[];
  queued: (TaskRef & { runId: string; emergency: boolean; forced: boolean; work: boolean })[];
  // Tasks the coordinator paused; resumable when the paused run is still their latest and idle.
  paused: (TaskRef & { runId: string; resumable: boolean })[];
  // Idle backlog tasks of staffed roles, highest priority first.
  backlog: TaskRef[];
}

export function decide(input: CoordinatorInput): CoordinatorAction[] {
  const { config, providers } = input;
  if (config.mode === "off") return [];
  const level = (p: Provider) => providers.get(p)?.level ?? "unknown";
  const reason = (p: Provider) => providers.get(p)?.reason ?? "";
  const allows = (p: Provider, priority: number) => {
    const l = level(p);
    return l === "ok" || l === "unknown" || (l === "conserve" && priority >= config.conservePriority);
  };
  const stopped = (p: Provider) => level(p) === "reserve" || level(p) === "exhausted";
  const actions: CoordinatorAction[] = [];
  const act = (type: CoordinatorAction["type"], t: TaskRef, runId: string | null, why: string, to: Provider | null = null) =>
    actions.push({
      key: `${type}:${runId ?? t.taskId}${to ? `:${to}` : ""}`,
      type,
      taskId: t.taskId,
      taskTitle: t.title,
      runId,
      provider: t.provider,
      to,
      reason: why,
    });

  if (config.pauseRunning) for (const r of input.running) if (stopped(r.provider) && !r.emergency && !r.forced) act("pause", r, r.runId, reason(r.provider));

  if (config.resumePaused)
    for (const p of input.paused) if (p.resumable && allows(p.provider, p.priority)) act("resume", p, p.runId, `${label(p.provider)} has room again.`);

  if (config.switchProvider) {
    for (const q of input.queued) {
      if (q.forced || q.emergency || !q.work || allows(q.provider, q.priority)) continue;
      // Only to a provider known to have room, never into an unknown one.
      const other = PROVIDERS.map((x) => x.id).find((p) => p !== q.provider && level(p) === "ok");
      if (other) act("switch", q, q.runId, `${label(q.provider)} is held (${reason(q.provider)}); ${label(other)} has room.`, other);
    }
  }

  if (config.fillIdle) {
    for (const [provider, s] of providers) {
      if (s.level !== "ok" || !s.session.resetsAt || s.session.usedPercent === null) continue;
      const left = Date.parse(s.session.resetsAt) - input.now;
      const headroom = 100 - config.sessionReservePct - s.session.usedPercent;
      if (left > FILL_WINDOW_MS || headroom < FILL_MIN_HEADROOM_PCT) continue;
      if (input.queued.some((q) => q.provider === provider)) continue;
      const next = input.backlog.find((t) => t.provider === provider);
      if (next)
        act(
          "start",
          next,
          null,
          `${round(headroom)}% of the ${label(provider)} session above your reserve resets unused in ${until(s.session.resetsAt, input.now)}.`,
        );
    }
  }
  return actions;
}

// A run that failed on a provider limit tells us that window is spent.
export function limitWindowFromError(text: string | null): QuotaWindow | null {
  if (!text || !/usage limit|rate limit|limit reached|hit your (\w+ )?limit|out of (extra )?usage|quota exceeded|too many requests/i.test(text)) return null;
  return /week/i.test(text) ? "weekly" : "session";
}
