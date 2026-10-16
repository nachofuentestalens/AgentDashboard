import type { FastifyInstance } from "fastify";
import {
  applyCoordinatorBody,
  coordinatorConfigBody,
  DEFAULT_COORDINATOR_CONFIG,
  PROVIDERS,
  quotaReadingBody,
  type CoordinatorAction,
  type CoordinatorConfig,
  type CoordinatorLogEntry,
  type CoordinatorView,
  type Provider,
  type ProviderQuotaView,
  type QuotaReading,
  type QuotaWindow,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import {
  decide,
  estimateWindow,
  nextWeeklyReset,
  providerHolds,
  providerLevel,
  windowLevel,
  type CoordinatorInput,
  type ProviderState,
  type RunCoordinator,
} from "./coordinator.ts";
import { HttpError, parse } from "./http.ts";
import type { Runner } from "./runner.ts";
import type { ProviderHold } from "./scheduler.ts";
import type { Store } from "./store.ts";

const CONFIG_KEY = "coordinator.config";
const READINGS_KEY = "coordinator.readings";
const PAUSED_KEY = "coordinator.paused";
const LOG_SIZE = 50;
// An automatic decision is not retried for this long, so a stop that takes a moment or a start
// that fails does not repeat on every scheduling pass.
const COOLDOWN_MS = 5 * 60_000;

type Readings = Partial<Record<`${Provider}:${QuotaWindow}`, QuotaReading>>;
type Paused = Record<string, { runId: string }>;

// The project coordinator: watches each provider's session and weekly usage, holds queued work
// that would eat into the owner's reserve, and pauses, resumes, starts or moves tasks. In advise
// mode it only lists those decisions. The rules are in coordinator.ts.
export class Coordinator implements RunCoordinator {
  private readonly log: CoordinatorLogEntry[] = [];
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly runner: Runner,
    private readonly clock: () => number = Date.now,
  ) {
    runner.coordinator = this;
  }

  config(): CoordinatorConfig {
    const saved = this.store.getStateJson<Partial<CoordinatorConfig>>(CONFIG_KEY) ?? {};
    const plans = { ...DEFAULT_COORDINATOR_CONFIG.plans };
    for (const p of PROVIDERS) plans[p.id] = { ...plans[p.id], ...saved.plans?.[p.id] };
    return { ...DEFAULT_COORDINATOR_CONFIG, ...saved, plans };
  }

  setConfig(config: CoordinatorConfig): CoordinatorView {
    this.store.setStateJson(CONFIG_KEY, config);
    this.changed();
    this.runner.tick();
    return this.view();
  }

  private readings(): Readings {
    return this.store.getStateJson<Readings>(READINGS_KEY) ?? {};
  }

  observe(input: Omit<QuotaReading, "at">): void {
    const now = this.clock();
    const readings = this.readings();
    const key = `${input.provider}:${input.window}` as const;
    const previous = readings[key];
    const plan = this.config().plans[input.provider];
    let { usedPercent, resetsAt } = input;
    // A failed run names no reset: assume the window it hit lasts a full window from now.
    if (input.source === "error" && !resetsAt)
      resetsAt = new Date(input.window === "session" ? now + plan.sessionHours * 3_600_000 : nextWeeklyReset(plan, now)).toISOString();
    // Some reports carry only the reset time; keep the last percentage of the same window.
    if (usedPercent === null && previous && previous.resetsAt === resetsAt) usedPercent = previous.usedPercent;
    readings[key] = { ...input, usedPercent, resetsAt, at: new Date(now).toISOString() };
    this.store.setStateJson(READINGS_KEY, readings);
    this.changed();
    this.runner.tick();
  }

  private paused(): Paused {
    return this.store.getStateJson<Paused>(PAUSED_KEY) ?? {};
  }

  private providerStates(config: CoordinatorConfig, now: number): ProviderQuotaView[] {
    const readings = this.readings();
    const running = this.runner.activeRuns().flatMap((a) => this.store.getRun(a.runId) ?? []);
    const queued = this.store.runsWithStatus("queued");
    return PROVIDERS.map(({ id: provider }) => {
      const tokensSince = (ms: number) => this.store.providerTokensSince(provider, new Date(ms).toISOString());
      const window = (w: QuotaWindow) =>
        windowLevel(estimateWindow({ window: w, reading: readings[`${provider}:${w}`] ?? null, plan: config.plans[provider], now, tokensSince }), config, now);
      const session = window("session");
      const weekly = window("weekly");
      return {
        provider,
        ...providerLevel(provider, session, weekly, config, now),
        session,
        weekly,
        running: running.filter((r) => this.runner.runProvider(r) === provider).length,
        queued: queued.filter((r) => this.runner.runProvider(r) === provider).length,
      };
    });
  }

  // Everything the rules look at, from the database and the runner.
  private input(config: CoordinatorConfig, providers: ProviderQuotaView[], now: number): CoordinatorInput {
    const ref = (taskId: string) => {
      const task = this.store.getTask(taskId);
      return task ? { task, ref: { taskId, title: task.title, provider: this.runner.taskProvider(task), priority: task.priority } } : null;
    };
    const running: CoordinatorInput["running"] = [];
    for (const a of this.runner.activeRuns()) {
      const run = this.store.getRun(a.runId);
      const t = run && ref(run.taskId);
      if (!run || !t?.task.roleId) continue;
      running.push({ ...t.ref, provider: this.runner.runProvider(run), runId: run.id, emergency: t.task.emergency, forced: run.forced });
    }
    const queued: CoordinatorInput["queued"] = [];
    for (const run of this.store.runsWithStatus("queued")) {
      const t = ref(run.taskId);
      if (!t) continue;
      queued.push({ ...t.ref, provider: this.runner.runProvider(run), runId: run.id, emergency: t.task.emergency, forced: run.forced, work: run.purpose === "work" });
    }
    // A paused task the owner resumed, restarted or deleted is no longer the coordinator's.
    const pausedState = this.paused();
    const paused: CoordinatorInput["paused"] = [];
    let pruned = false;
    for (const [taskId, { runId }] of Object.entries(pausedState)) {
      const t = ref(taskId);
      const latest = t ? this.store.listRuns(taskId).at(-1) : null;
      if (!t || latest?.id !== runId) {
        delete pausedState[taskId];
        pruned = true;
        continue;
      }
      const idle = !this.runner.isTaskRunning(taskId) && t.task.status !== "queued";
      paused.push({ ...t.ref, runId, resumable: idle && latest.status === "stopped" });
    }
    if (pruned) this.store.setStateJson(PAUSED_KEY, pausedState);
    const staffed = new Set(
      this.store
        .listAgents()
        .filter((a) => !a.paused)
        .map((a) => a.roleId),
    );
    const backlog = this.store
      .listProjects()
      .flatMap((p) => this.store.backlogTasks(p.id))
      .filter((t) => t.roleId && staffed.has(t.roleId) && !t.emergency)
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
      .map((t) => ({ taskId: t.id, title: t.title, provider: this.runner.taskProvider(t), priority: t.priority }));
    const states = new Map<Provider, ProviderState>(providers.map((p) => [p.provider, p]));
    return { now, config, providers: states, running, queued, paused, backlog };
  }

  private snapshot() {
    const now = this.clock();
    const config = this.config();
    const providers = this.providerStates(config, now);
    const input = this.input(config, providers, now);
    return { config, providers, input, actions: decide(input) };
  }

  beforeSchedule(): Map<Provider, ProviderHold> {
    const { config, input, actions } = this.snapshot();
    if (config.mode === "auto") {
      const now = this.clock();
      for (const action of actions) {
        if ((this.cooldown.get(action.key) ?? 0) > now) continue;
        this.cooldown.set(action.key, now + COOLDOWN_MS);
        void this.apply(action, "coordinator");
      }
    }
    return providerHolds(input.providers, config);
  }

  view(): CoordinatorView {
    const { config, providers, input, actions } = this.snapshot();
    return {
      config,
      providers,
      recommendations: actions,
      paused: input.paused.map((p) => ({ taskId: p.taskId, title: p.title, provider: p.provider })),
      log: [...this.log].reverse(),
    };
  }

  // The owner applies a listed decision. It must still be one the rules make now.
  async applyByKey(key: string): Promise<CoordinatorView> {
    const action = this.snapshot().actions.find((a) => a.key === key);
    if (!action) throw new HttpError("That decision no longer applies. The list has been refreshed.", 409);
    const entry = await this.apply(action, "owner");
    if (entry.error) throw new HttpError(entry.error, 409);
    return this.view();
  }

  private async apply(action: CoordinatorAction, by: CoordinatorLogEntry["by"]): Promise<CoordinatorLogEntry> {
    let error: string | null = null;
    try {
      switch (action.type) {
        case "pause": {
          if (!this.runner.stop(action.runId!, `Paused by the coordinator: ${action.reason} It resumes when there is room again.`))
            throw new Error("The run already ended.");
          this.store.setStateJson(PAUSED_KEY, { ...this.paused(), [action.taskId]: { runId: action.runId! } });
          break;
        }
        case "resume": {
          const paused = this.paused();
          delete paused[action.taskId];
          this.store.setStateJson(PAUSED_KEY, paused);
          await this.runner.retry(action.runId!);
          break;
        }
        case "start":
          this.runner.stageAction(action.taskId, { action: "start" });
          break;
        case "switch": {
          // The task's own model and effort belong to the old provider; the role's or project's apply.
          const task = this.store.updateTask(action.taskId, { provider: action.to, model: null, effort: null });
          if (task) this.bus.publish({ type: "task_updated", task });
          this.runner.tick();
          break;
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    const entry: CoordinatorLogEntry = { at: new Date(this.clock()).toISOString(), by, action, error };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.changed();
    return entry;
  }

  private changed() {
    this.bus.publish({ type: "coordinator_changed" });
  }
}

export function registerCoordinatorRoutes(app: FastifyInstance, coordinator: Coordinator) {
  app.get("/api/coordinator", async () => coordinator.view());

  app.put("/api/coordinator/config", async (request, reply) => {
    const body = parse(coordinatorConfigBody, request.body, reply);
    if (!body) return;
    return coordinator.setConfig(body);
  });

  app.post("/api/coordinator/readings", async (request, reply) => {
    const body = parse(quotaReadingBody, request.body, reply);
    if (!body) return;
    coordinator.observe({ ...body, rejected: body.usedPercent >= 100, source: "owner" });
    return coordinator.view();
  });

  app.post("/api/coordinator/apply", async (request, reply) => {
    const body = parse(applyCoordinatorBody, request.body, reply);
    if (!body) return;
    return coordinator.applyByKey(body.key);
  });
}
