import {
  PROVIDERS,
  type CoordinatorAction,
  type CoordinatorConfig,
  type Effort,
  type ProviderLimits,
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
// Keep enough room for a useful work session above the owner's reserve.
export const FILL_MIN_HEADROOM_PCT = 25;

const label = (p: Provider) => PROVIDERS.find((x) => x.id === p)!.label;
const round = (n: number) => Math.round(n);
const RANK: Record<QuotaLevel, number> = { unknown: 0, ok: 1, conserve: 2, reserve: 3, exhausted: 4 };

export interface RunCoordinator {
  // Called before each scheduling pass: applies automatic decisions and returns the provider holds.
  beforeSchedule(): Map<Provider, ProviderHold>;
  selectAutomaticProvider?(current: Provider, effort: Effort, loads: Map<Provider, number>, limits: ProviderLimits, priority: number): Provider;
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
  weekly?: QuotaWindowView;
  // Include owner chats in load, even though automation never changes them.
  running?: number;
  queued?: number;
  maxConcurrent?: number;
}

// Percentages are comparable quota headroom, not token or price estimates. The tighter known
// window limits a long run; only prefer an earlier reset when capacity is within ten points.
export function selectProvider(
  current: Provider,
  effort: Effort | undefined,
  providers: Map<Provider, ProviderState>,
  config: CoordinatorConfig,
  now: number,
  loads: Map<Provider, number>,
  eligible: (provider: Provider) => boolean = () => true,
  priority = 0,
): Provider {
  const capacity = (p: Provider) => {
    const s = providers.get(p)!;
    return Math.max(
      0,
      Math.min(
        100 - config.sessionReservePct - (s.session.usedPercent ?? 100),
        s.weekly?.usedPercent == null ? 100 : 100 - config.weeklyReservePct - s.weekly.usedPercent,
      ),
    );
  };
  const reset = (p: Provider) => {
    const s = providers.get(p)!;
    const window =
      s.weekly?.usedPercent != null && 100 - config.weeklyReservePct - s.weekly.usedPercent < 100 - config.sessionReservePct - (s.session.usedPercent ?? 100)
        ? s.weekly
        : s.session;
    const time = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    return Number.isFinite(time) && time > now ? time : null;
  };
  const large = effort === "high" || effort === "xhigh" || effort === "max";
  const candidates = PROVIDERS.map(({ id }) => id).filter(
    (p) =>
      eligible(p) &&
      (loads.get(p) ?? 0) < (providers.get(p)?.maxConcurrent ?? Infinity) &&
      (providers.get(p)?.level === "ok" || (providers.get(p)?.level === "conserve" && priority >= config.conservePriority)) &&
      capacity(p) > 0,
  );
  if (!candidates.length) return current;
  const score = (p: Provider) => capacity(p) / (large ? 1 : 1 + (loads.get(p) ?? 0));
  const peak = Math.max(...candidates.map(score));
  const similar = candidates.filter((p) => peak - score(p) <= 10);
  const best = similar.reduce(
    (a, b) => {
      const ar = reset(a),
        br = reset(b);
      if (ar !== null && br !== null && Math.abs(ar - br) >= HOUR) return ar < br ? a : b;
      return score(b) > score(a) ? b : score(b) < score(a) ? a : (loads.get(b) ?? 0) < (loads.get(a) ?? 0) ? b : a;
    },
    similar.includes(current) ? current : similar[0]!,
  );
  return best;
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
  // Work in a project with start-next automation enabled.
  automatic?: boolean;
  effort?: Effort;
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

  const loads = new Map(
    PROVIDERS.map(({ id }) => [
      id,
      (providers.get(id)?.running ?? input.running.filter((r) => r.provider === id).length) +
        (providers.get(id)?.queued ?? input.queued.filter((q) => q.provider === id).length),
    ]),
  );
  const room = (p: Provider) => Math.max(0, 100 - config.sessionReservePct - (providers.get(p)?.session.usedPercent ?? 100));
  const bestProvider = (task: TaskRef, eligible?: (p: Provider) => boolean) =>
    selectProvider(task.provider, task.effort, providers, config, input.now, loads, eligible, task.priority);

  {
    for (const q of input.queued) {
      if (q.forced || q.emergency || !q.work) continue;
      // Exclude this candidate from load so reevaluating the queue cannot bounce it back.
      loads.set(q.provider, Math.max(0, (loads.get(q.provider) ?? 0) - 1));
      const automatic = q.automatic;
      // Only to a provider known to have room, never into an unknown one.
      const other = automatic
        ? bestProvider(q)
        : config.switchProvider && !allows(q.provider, q.priority)
          ? PROVIDERS.map((x) => x.id).find((p) => p !== q.provider && level(p) === "ok")
          : undefined;
      const target = other ?? q.provider;
      loads.set(target, (loads.get(target) ?? 0) + 1);
      if (target !== q.provider)
        act(
          "switch",
          q,
          q.runId,
          automatic
            ? `${label(target)} is preferred by remaining session/weekly capacity, reset timing, task effort and assigned load. The agent reviews task complexity and selects a model before implementation.`
            : `${label(q.provider)} is held (${reason(q.provider)}); ${label(target)} has room.`,
          target,
        );
    }
  }

  if (config.fillIdle) {
    const selected = new Set<string>();
    const available = (p: Provider, task: TaskRef) =>
      (level(p) === "ok" || (!!task.automatic && level(p) === "conserve" && task.priority >= config.conservePriority)) &&
      room(p) >= FILL_MIN_HEADROOM_PCT &&
      !selected.has(p) &&
      !input.queued.some((q) => (actions.find((a) => a.type === "switch" && a.runId === q.runId)?.to ?? q.provider) === p);
    for (const next of input.backlog) {
      const provider = next.automatic ? bestProvider(next, (p) => available(p, next)) : next.provider;
      if (!available(provider, next)) continue;
      selected.add(provider);
      loads.set(provider, (loads.get(provider) ?? 0) + 1);
      act(
        "start",
        next,
        null,
        `${label(provider)} has available compute; selected using remaining capacity, reset timing, task effort and load.`,
        provider === next.provider ? null : provider,
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
