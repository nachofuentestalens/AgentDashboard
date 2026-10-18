import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexParser, DEFAULT_COORDINATOR_CONFIG, parseClaudeLine, type CoordinatorConfig, type CoordinatorView, type QuotaReading } from "@ad/shared";
import type { App } from "../src/app.ts";
import {
  decide,
  estimateWindow,
  limitWindowFromError,
  nextWeeklyReset,
  providerHolds,
  providerLevel,
  windowLevel,
  type CoordinatorInput,
  type ProviderState,
} from "../src/coordinator.ts";
import { plan, type QueuedRun, type SchedulerState } from "../src/scheduler.ts";
import { parseClaudeUsage, readCodexUsage } from "../src/usage.ts";
import { api, newProject, newTask, runFinished, testApp } from "./helpers.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const config = (over: Partial<CoordinatorConfig> = {}): CoordinatorConfig => ({ ...DEFAULT_COORDINATOR_CONFIG, ...over });
const plan0 = DEFAULT_COORDINATOR_CONFIG.plans.claude;
const reading = (over: Partial<QuotaReading> = {}): QuotaReading => ({
  provider: "claude",
  window: "session",
  usedPercent: 40,
  resetsAt: iso(NOW + 2 * HOUR),
  rejected: false,
  source: "cli",
  at: iso(NOW - HOUR),
  ...over,
});

describe("usage estimates", () => {
  it("uses a reading, adds tokens since it against a cap, and resets after its window", () => {
    const tokensSince = () => 50_000;
    const base = { window: "session" as const, plan: plan0, now: NOW, tokensSince };
    expect(estimateWindow({ ...base, reading: reading() })).toMatchObject({ usedPercent: 40, source: "cli" });
    expect(estimateWindow({ ...base, reading: reading(), plan: { ...plan0, sessionTokenCap: 1_000_000 } })).toMatchObject({
      usedPercent: 45,
      source: "estimate",
    });
    expect(estimateWindow({ ...base, reading: reading({ rejected: true, usedPercent: null }) })).toMatchObject({ usedPercent: 100 });
    expect(estimateWindow({ ...base, reading: reading({ resetsAt: iso(NOW - HOUR) }) })).toMatchObject({ usedPercent: 0, source: "reset", resetsAt: null });
    expect(estimateWindow({ ...base, reading: null })).toMatchObject({ usedPercent: null, source: "none" });
    expect(estimateWindow({ ...base, reading: null, plan: { ...plan0, sessionTokenCap: 100_000 } })).toMatchObject({ usedPercent: 50, source: "estimate" });
  });

  it("keeps a weekly window's cadence after it resets", () => {
    const past = reading({ window: "weekly", resetsAt: iso(NOW - HOUR) });
    const view = estimateWindow({ window: "weekly", reading: past, plan: plan0, now: NOW, tokensSince: () => 0 });
    expect(view.resetsAt).toBe(iso(NOW - HOUR + 7 * 24 * HOUR));
  });

  it("finds the next weekly reset of a plan", () => {
    const next = nextWeeklyReset({ ...plan0, weeklyResetDay: 3, weeklyResetHour: 9 }, NOW);
    const d = new Date(next);
    expect([d.getDay(), d.getHours()]).toEqual([3, 9]);
    expect(next).toBeGreaterThan(NOW);
    expect(next - NOW).toBeLessThanOrEqual(7 * 24 * HOUR);
  });
});

describe("levels", () => {
  const level = (used: number | null, over: Partial<CoordinatorConfig> = {}, resetsIn = 3 * HOUR, window: "session" | "weekly" = "session") =>
    windowLevel({ window, usedPercent: used, source: "cli", resetsAt: iso(NOW + resetsIn), readingAt: null }, config(over), NOW).level;

  it.each([
    [null, "unknown"],
    [10, "ok"],
    [66, "conserve"],
    [80, "reserve"],
    [100, "exhausted"],
  ] as const)("session %s%% used is %s (reserve 20, band 15)", (used, expected) => {
    expect(level(used)).toBe(expected);
  });

  it("stops conserving in a session's last half hour, but keeps the reserve", () => {
    expect(level(70, {}, 20 * 60_000)).toBe("ok");
    expect(level(85, {}, 20 * 60_000)).toBe("reserve");
  });

  it("conserves a week that runs ahead of an even pace", () => {
    // One day into the week: pace = 85 * 1/7 + 10 ≈ 22%.
    expect(level(15, {}, 6 * 24 * HOUR, "weekly")).toBe("ok");
    expect(level(30, {}, 6 * 24 * HOUR, "weekly")).toBe("conserve");
    // Late in the week the same usage is fine.
    expect(level(30, {}, 24 * HOUR, "weekly")).toBe("ok");
  });

  it("takes the worse window for the provider and names it", () => {
    const w = (window: "session" | "weekly", used: number) =>
      windowLevel({ window, usedPercent: used, source: "cli", resetsAt: iso(NOW + 3 * HOUR), readingAt: null }, config(), NOW);
    const p = providerLevel("claude", w("session", 10), w("weekly", 90), config(), NOW);
    expect(p.level).toBe("reserve");
    expect(p.reason).toMatch(/^Weekly usage 90%/);
  });
});

const state = (level: ProviderState["level"], usedPercent = 30, resetsIn = 3 * HOUR): ProviderState => ({
  level,
  reason: `${level} reason`,
  session: { window: "session", usedPercent, source: "cli", resetsAt: iso(NOW + resetsIn), readingAt: null, level, paceLimitPct: null },
});

const input = (over: Partial<CoordinatorInput> = {}): CoordinatorInput => ({
  now: NOW,
  config: config({ mode: "auto" }),
  providers: new Map([
    ["claude", state("ok")],
    ["codex", state("unknown")],
  ]),
  running: [],
  queued: [],
  paused: [],
  backlog: [],
  ...over,
});
const types = (i: CoordinatorInput) => decide(i).map((a) => `${a.type}:${a.taskId}${a.to ? `>${a.to}` : ""}`);
const ref = (taskId: string, priority = 5, provider: "claude" | "codex" = "claude") => ({ taskId, title: taskId, provider, priority });

describe("decisions", () => {
  it("pauses role work inside the reserve, but not emergencies or forced runs", () => {
    const running = [
      { ...ref("a"), runId: "r1", emergency: false, forced: false },
      { ...ref("b"), runId: "r2", emergency: true, forced: false },
      { ...ref("c"), runId: "r3", emergency: false, forced: true },
    ];
    expect(types(input({ running, providers: new Map([["claude", state("reserve")]]) }))).toEqual(["pause:a"]);
    expect(types(input({ running }))).toEqual([]);
    expect(types(input({ running, providers: new Map([["claude", state("reserve")]]), config: config({ mode: "auto", pauseRunning: false }) }))).toEqual([]);
  });

  it("resumes paused work when there is room, and only important work while conserving", () => {
    const paused = [
      { ...ref("low", 3), runId: "r1", resumable: true },
      { ...ref("high", 9), runId: "r2", resumable: true },
      { ...ref("busy", 9), runId: "r3", resumable: false },
    ];
    expect(types(input({ paused }))).toEqual(["resume:low", "resume:high"]);
    expect(types(input({ paused, providers: new Map([["claude", state("conserve")]]) }))).toEqual(["resume:high"]);
    expect(types(input({ paused, providers: new Map([["claude", state("reserve")]]) }))).toEqual([]);
  });

  it("moves held work to a provider known to have room", () => {
    const queued = [{ ...ref("q"), runId: "r1", emergency: false, forced: false, work: true }];
    const held = new Map<"claude" | "codex", ProviderState>([
      ["claude", state("reserve")],
      ["codex", state("ok")],
    ]);
    expect(types(input({ queued, providers: held, config: config({ mode: "auto", switchProvider: true }) }))).toEqual(["switch:q>codex"]);
    expect(types(input({ queued, providers: held }))).toEqual([]);
    held.set("codex", state("unknown"));
    expect(types(input({ queued, providers: held, config: config({ mode: "auto", switchProvider: true }) }))).toEqual([]);
  });

  it("starts backlog work only when a session would reset with room unused", () => {
    const backlog = [ref("top", 8), ref("other", 4, "codex")];
    const fill = config({ mode: "auto", fillIdle: true });
    expect(types(input({ backlog, config: fill, providers: new Map([["claude", state("ok", 30, HOUR)]]) }))).toEqual(["start:top"]);
    // Far from the reset, or too little room above the reserve.
    expect(types(input({ backlog, config: fill, providers: new Map([["claude", state("ok", 30, 4 * HOUR)]]) }))).toEqual([]);
    expect(types(input({ backlog, config: fill, providers: new Map([["claude", state("ok", 60, HOUR)]]) }))).toEqual([]);
    // Work already waiting for the provider uses the room first.
    const queued = [{ ...ref("q"), runId: "r1", emergency: false, forced: false, work: true }];
    expect(types(input({ backlog, queued, config: fill, providers: new Map([["claude", state("ok", 30, HOUR)]]) }))).toEqual([]);
  });

  it("decides nothing when off", () => {
    const running = [{ ...ref("a"), runId: "r1", emergency: false, forced: false }];
    expect(types(input({ running, config: config({ mode: "off" }), providers: new Map([["claude", state("exhausted")]]) }))).toEqual([]);
  });

  it("holds queued work in auto mode only", () => {
    const states = new Map<"claude" | "codex", ProviderState>([
      ["claude", state("conserve")],
      ["codex", state("exhausted")],
    ]);
    const holds = providerHolds(states, config({ mode: "auto" }));
    expect(holds.get("claude")).toMatchObject({ minPriority: 7 });
    expect(holds.get("codex")).toMatchObject({ minPriority: null });
    expect(holds.get("codex")!.reason).toMatch(/^Coordinator:/);
    expect(providerHolds(states, config({ mode: "advise" })).size).toBe(0);
  });

  it("reads limit failures", () => {
    expect(limitWindowFromError("Claude AI usage limit reached|1760000000")).toBe("session");
    expect(limitWindowFromError("You've hit your weekly limit")).toBe("weekly");
    expect(limitWindowFromError("Simulated failure.")).toBeNull();
  });
});

describe("scheduler holds", () => {
  const q = (runId: string, priority: number, over: Partial<QueuedRun> = {}): QueuedRun => ({
    runId,
    projectId: "p",
    roleId: "prog",
    roleName: "Programmer",
    departmentId: "eng",
    canEdit: false,
    priority,
    emergency: false,
    forced: false,
    queuedAt: "2026-01-01T00:00:00Z",
    estimateUsd: 0.1,
    provider: "claude",
    ...over,
  });
  const s = (queued: QueuedRun[], minPriority: number | null): SchedulerState => ({
    maxConcurrent: { claude: 5, codex: 5 },
    budgetUsd: null,
    spendUsd: 0,
    departments: new Map([["eng", { name: "Engineering", weight: 5, budgetUsd: null, spendUsd: 0 }]]),
    freeAgents: new Map([["prog", ["a1", "a2", "a3", "a4"]]]),
    staffedRoles: new Set(["prog"]),
    frozenProjects: new Set(),
    active: [],
    queued,
    providerHolds: new Map([["claude", { minPriority, reason: "Coordinator: held" }]]),
  });

  it("starts only what the hold lets through", () => {
    const queued = [q("low", 3), q("high", 8), q("forced", 1, { forced: true }), q("urgent", 1, { emergency: true }), q("codex", 1, { provider: "codex" })];
    expect(
      plan(s(queued, 7))
        .start.map((x) => x.runId)
        .sort(),
    ).toEqual(["codex", "forced", "high", "urgent"]);
    const all = plan(s(queued, null));
    expect(all.start.map((x) => x.runId).sort()).toEqual(["codex", "forced", "urgent"]);
    expect(all.waiting.get("high")).toBe("Coordinator: held");
  });
});

describe("provider reports", () => {
  it("parses Claude's rate limit events", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.42, resetsAt: 1_800_000_000 },
    });
    expect(parseClaudeLine(line)).toEqual([{ kind: "rate_limit", window: "weekly", usedPercent: 42, resetsAt: iso(1_800_000_000_000), rejected: false }]);
    expect(parseClaudeLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "overage" } }))).toEqual([]);
  });

  it("parses Codex rate limits wherever they sit", () => {
    const parse = createCodexParser();
    const line = JSON.stringify({
      type: "token_count",
      info: {
        rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1_800_000_000 }, secondary: { used_percent: 1, window_minutes: 10080 } },
      },
    });
    expect(parse(line)).toEqual([
      { kind: "rate_limit", window: "session", usedPercent: 12, resetsAt: iso(1_800_000_000_000), rejected: false },
      { kind: "rate_limit", window: "weekly", usedPercent: 1, resetsAt: null, rejected: false },
    ]);
  });
});

describe("coordinator API", () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it("records CLI readings from runs and the owner's readings, and saves the policy", async () => {
    const app = await testApp();
    apps.push(app);
    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "[ratelimit:92] hello" });
    await runFinished(app, app.store.listRuns(task.id).at(-1)!.id);

    let view = (await api<CoordinatorView>(app, "GET", "/api/coordinator")).body;
    const claude = view.providers.find((p) => p.provider === "claude")!;
    expect(claude.session).toMatchObject({ usedPercent: 92, source: "cli", level: "reserve" });
    expect(claude.level).toBe("reserve");

    view = (await api<CoordinatorView>(app, "POST", "/api/coordinator/readings", { provider: "codex", window: "weekly", usedPercent: 30, resetsAt: null }))
      .body;
    expect(view.providers.find((p) => p.provider === "codex")!.weekly).toMatchObject({ usedPercent: 30, source: "owner" });

    const saved = await api<CoordinatorView>(app, "PUT", "/api/coordinator/config", { ...view.config, mode: "auto", sessionReservePct: 5 });
    expect(saved.body.config).toMatchObject({ mode: "auto", sessionReservePct: 5 });
    expect((await api(app, "PUT", "/api/coordinator/config", { ...view.config, mode: "always" })).status).toBe(400);
    expect((await api(app, "POST", "/api/coordinator/apply", { key: "pause:nothing" })).status).toBe(409);
  });

  it("reads both windows from the usage API, and a reset-only CLI report keeps the percentage", async () => {
    const session = new Date(Date.now() + 3_600_000 - 57).toISOString();
    const weekly = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const app = await testApp(undefined, {
      usage: async (provider) =>
        provider === "claude"
          ? [
              { window: "session", usedPercent: 37, resetsAt: session },
              { window: "weekly", usedPercent: 64, resetsAt: weekly },
            ]
          : null,
    });
    apps.push(app);
    let view = (await api<CoordinatorView>(app, "POST", "/api/coordinator/refresh")).body;
    let claude = view.providers.find((p) => p.provider === "claude")!;
    expect(claude.session).toMatchObject({ usedPercent: 37, source: "api", resetsAt: session });
    expect(claude.weekly).toMatchObject({ usedPercent: 64, source: "api", resetsAt: weekly });
    expect(claude.usageCheck).toMatchObject({ error: null });
    expect(view.providers.find((p) => p.provider === "codex")!.usageCheck).toBeNull();

    const projectId = await newProject(app);
    const task = await newTask(app, projectId, { message: "[ratelimit:reset] hello" });
    await runFinished(app, app.store.listRuns(task.id).at(-1)!.id);
    view = (await api<CoordinatorView>(app, "GET", "/api/coordinator")).body;
    claude = view.providers.find((p) => p.provider === "claude")!;
    expect(claude.session).toMatchObject({ usedPercent: 37, source: "api", resetsAt: session });
  });

  it("shows why the usage API could not be read", async () => {
    const app = await testApp(undefined, {
      usage: async () => {
        throw new Error("No Claude sign-in found.");
      },
    });
    apps.push(app);
    const view = (await api<CoordinatorView>(app, "POST", "/api/coordinator/refresh")).body;
    expect(view.providers.find((p) => p.provider === "claude")!.usageCheck).toMatchObject({ error: "No Claude sign-in found." });
  });
});

describe("usage API", () => {
  it("reads utilization as a percentage and normalises reset times", () => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 0.5, resets_at: "2026-10-17T10:59:59.943648+00:00" },
        seven_day: { utilization: 35, resets_at: null },
        seven_day_opus: { utilization: 1, resets_at: null },
      }),
    ).toEqual([
      { window: "session", usedPercent: 0.5, resetsAt: "2026-10-17T10:59:59.943Z" },
      { window: "weekly", usedPercent: 35, resetsAt: null },
    ]);
    expect(parseClaudeUsage({ error: "nope" })).toEqual([]);
  });

  it("reads Codex limits from its newest session rollout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sessions-"));
    try {
      const line = (ts: string, limits: unknown) =>
        JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } });
      const dir = path.join(root, "2026", "10", "17");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "rollout-a.jsonl"),
        [
          line("2026-10-17T10:00:00Z", {
            limit_id: "codex",
            primary: { used_percent: 83, window_minutes: 300, resets_at: 1792200777 },
            secondary: { used_percent: 13, window_minutes: 10080, resets_in_seconds: 3600 },
          }),
          line("2026-10-17T10:01:00Z", { limit_id: "other_model", primary: { used_percent: 1, window_minutes: 300 } }),
          line("2026-10-17T10:02:00Z", null),
          "",
        ].join("\n"),
      );
      expect(readCodexUsage(root)).toEqual([
        { window: "session", usedPercent: 83, resetsAt: new Date(1792200777 * 1000).toISOString(), observedAt: "2026-10-17T10:00:00.000Z" },
        { window: "weekly", usedPercent: 13, resetsAt: "2026-10-17T11:00:00.000Z", observedAt: "2026-10-17T10:00:00.000Z" },
      ]);
      expect(() => readCodexUsage(path.join(root, "missing"))).toThrow(/No Codex sessions/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
