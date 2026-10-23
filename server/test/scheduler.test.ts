import { describe, expect, it } from "vitest";
import { plan, type QueuedRun, type SchedulerState } from "../src/scheduler.ts";

const q = (runId: string, over: Partial<QueuedRun> = {}): QueuedRun => ({
  runId,
  projectId: "p",
  roleId: "prog",
  roleName: "Programmer",
  departmentId: "eng",
  canEdit: false,
  priority: 5,
  emergency: false,
  forced: false,
  queuedAt: `2026-01-01T00:00:0${runId.length}Z`,
  estimateUsd: 0.1,
  ...over,
});

const state = (over: Partial<SchedulerState> = {}): SchedulerState => ({
  maxConcurrent: { claude: 3, codex: 3 },
  budgetUsd: null,
  spendUsd: 0,
  departments: new Map([
    ["eng", { name: "Engineering", weight: 5, budgetUsd: null, spendUsd: 0 }],
    ["des", { name: "Design", weight: 3, budgetUsd: null, spendUsd: 0 }],
  ]),
  freeAgents: new Map([
    ["prog", ["a1", "a2", "a3"]],
    ["designer", ["d1", "d2"]],
  ]),
  staffedRoles: new Set(["prog", "designer"]),
  frozenProjects: new Set(),
  active: [],
  queued: [],
  ...over,
});

const started = (s: SchedulerState) => plan(s).start.map((x) => x.runId);

describe("scheduler", () => {
  it.each([
    {
      name: "higher priority first within a department",
      s: state({ maxConcurrent: { claude: 1, codex: 1 }, queued: [q("low", { priority: 2 }), q("high", { priority: 9 }), q("mid", { priority: 5 })] }),
      start: ["high"],
    },
    {
      name: "each provider has its own slots",
      s: state({
        maxConcurrent: { claude: 1, codex: 1 },
        active: [{ runId: "busy", departmentId: "eng", canEdit: false, provider: "claude" }],
        queued: [q("cl", { provider: "claude", priority: 9 }), q("cx", { provider: "codex" }), q("cx2", { provider: "codex" })],
      }),
      start: ["cx"],
    },
    {
      name: "older first at equal priority",
      s: state({
        maxConcurrent: { claude: 1, codex: 1 },
        queued: [q("bb", { queuedAt: "2026-01-02T00:00:00Z" }), q("aa", { queuedAt: "2026-01-01T00:00:00Z" })],
      }),
      start: ["aa"],
    },
    {
      name: "the department that spent least per weight goes next, whatever the priority",
      s: state({
        maxConcurrent: { claude: 1, codex: 1 },
        departments: new Map([
          ["eng", { name: "Engineering", weight: 5, budgetUsd: null, spendUsd: 5 }], // 1.0 per weight
          ["des", { name: "Design", weight: 3, budgetUsd: null, spendUsd: 1.5 }], // 0.5 per weight
        ]),
        queued: [q("eng", { priority: 10 }), q("des", { roleId: "designer", departmentId: "des", priority: 1 })],
      }),
      start: ["des"],
    },
    {
      name: "one writer per department; readers run alongside",
      s: state({
        active: [{ runId: "w", departmentId: "eng", canEdit: true }],
        queued: [q("write", { canEdit: true, priority: 9 }), q("read", { canEdit: false, priority: 1 })],
      }),
      start: ["read"],
    },
    {
      name: "two queued writers of one department: only the first starts",
      s: state({ queued: [q("w1", { canEdit: true, priority: 9 }), q("w2", { canEdit: true, priority: 8 })] }),
      start: ["w1"],
    },
    {
      name: "an emergency skips the full slots and the queue",
      s: state({
        maxConcurrent: { claude: 1, codex: 1 },
        active: [{ runId: "x", departmentId: null, canEdit: false }],
        queued: [q("normal", { priority: 10 }), q("fire", { emergency: true, priority: 0 })],
      }),
      start: ["fire"],
    },
    {
      name: "a frozen project starts only its emergencies and forced runs",
      s: state({ frozenProjects: new Set(["p"]), queued: [q("normal"), q("forced", { forced: true }), q("fire", { emergency: true })] }),
      start: ["fire", "forced"],
    },
    {
      name: "a paused project starts only forced runs, not even emergencies; other projects go on",
      s: state({
        pausedProviders: new Map([["p", new Set(["claude", "codex"] as const)]]),
        queued: [q("normal"), q("forced", { forced: true }), q("fire", { emergency: true }), q("other", { projectId: "p2" })],
      }),
      start: ["other", "forced"],
    },
    {
      name: "a provider paused in a project holds only that provider's runs there",
      s: state({
        pausedProviders: new Map([["p", new Set(["codex"] as const)]]),
        queued: [
          q("codex", { provider: "codex" }),
          q("claude", { provider: "claude" }),
          q("forcedcodex", { provider: "codex", forced: true }),
          q("othercodex", { provider: "codex", projectId: "p2" }),
        ],
      }),
      start: ["othercodex", "forcedcodex", "claude"],
    },
    {
      name: "a department over budget waits; others go on",
      s: state({
        departments: new Map([
          ["eng", { name: "Engineering", weight: 5, budgetUsd: 1, spendUsd: 1.2 }],
          ["des", { name: "Design", weight: 3, budgetUsd: null, spendUsd: 0 }],
        ]),
        queued: [q("eng"), q("des", { roleId: "designer", departmentId: "des" })],
      }),
      start: ["des"],
    },
    {
      name: "the global budget holds everything but emergencies",
      s: state({ budgetUsd: 2, spendUsd: 2, queued: [q("normal"), q("fire", { emergency: true })] }),
      start: ["fire"],
    },
    {
      name: "a role needs a free agent",
      s: state({ freeAgents: new Map([["prog", ["a1"]]]), queued: [q("one"), q("two")] }),
      start: ["one"],
    },
  ])("$name", ({ s, start }) => {
    expect(started(s)).toEqual(start);
  });

  it("explains why runs wait", () => {
    const result = plan(
      state({
        maxConcurrent: { claude: 1, codex: 1 },
        staffedRoles: new Set(["prog"]),
        departments: new Map([
          ["eng", { name: "Engineering", weight: 5, budgetUsd: 1, spendUsd: 2 }],
          ["des", { name: "Design", weight: 3, budgetUsd: null, spendUsd: 0 }],
        ]),
        queued: [q("budget"), q("nobody", { roleId: "designer", roleName: "Designer", departmentId: "des" })],
      }),
    );
    expect(result.start).toEqual([]);
    expect(result.waiting.get("budget")).toMatch(/Engineering reached its daily budget \(\$2\.00 of \$1\.00\)/);
    expect(result.waiting.get("nobody")).toMatch(/No Designer agent/);
    const paused = (providers: ("claude" | "codex")[]) => new Map([["p", new Set(providers)]]);
    expect(plan(state({ pausedProviders: paused(["claude", "codex"]), queued: [q("held")] })).waiting.get("held")).toMatch(/project is paused/);
    expect(plan(state({ pausedProviders: paused(["claude"]), queued: [q("held")] })).waiting.get("held")).toMatch(/^Claude work in this project is paused/);
  });

  it("assigns distinct free agents and charges estimates as it goes", () => {
    const result = plan(
      state({
        maxConcurrent: { claude: 5, codex: 5 },
        departments: new Map([["eng", { name: "Engineering", weight: 5, budgetUsd: 0.25, spendUsd: 0 }]]),
        queued: [q("r1", { estimateUsd: 0.2 }), q("r2", { estimateUsd: 0.2 }), q("r3", { estimateUsd: 0.2 })],
      }),
    );
    expect(result.start).toEqual([
      { runId: "r1", agentId: "a1" },
      { runId: "r2", agentId: "a2" },
    ]);
    expect(result.waiting.get("r3")).toMatch(/daily budget/);
  });
});
