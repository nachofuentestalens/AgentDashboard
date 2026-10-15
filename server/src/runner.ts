import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  createCodexParser,
  finalText,
  parseClaudeLine,
  PROVIDERS,
  MODEL_PRESETS,
  type ModelOption,
  resolveChoice,
  type AgentEvent,
  type Choice,
  type Effort,
  type Message,
  type Provider,
  type Run,
  type StampedEvent,
  type Task,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import { buildArgs, CLAUDE_CLI, resolveLauncher, systemPrompt, type Launcher } from "./claude.ts";
import { buildCodexArgs, CODEX_CLI } from "./codex.ts";
import { listDocs } from "./docs.ts";
import { HttpError } from "./http.ts";
import { editRules, type EditRules } from "./folders.ts";
import { roleSystemPrompt, studioContext } from "./prompts.ts";
import { EFFORT_COST_GUESS, plan, type QueuedRun, type SchedulerState } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { efficiencyInstructions, extractHandoff, HANDOFF_REQUEST, totalTokens } from "./efficiency.ts";
import { modelRoutingInstructions, parseModelReview, validateModelReview } from "./model-routing.ts";

export class RunnerError extends HttpError {}

export interface Notice {
  level: "info" | "warn";
  text: string;
}

// What the studio does with a finished reply (its task, proposal and question blocks).
export interface ReplyHandler {
  afterReply(task: Task, run: Run, reply: string): { notices: Notice[]; waiting: boolean };
}

interface ActiveRun {
  runId: string;
  taskId: string;
  child: ChildProcess | null;
  stopRequested: boolean;
  agentId: string | null;
  departmentId: string | null;
  canEdit: boolean;
  checkpointReason?: string;
  // Expected cost, charged to the department while the run goes (see the scheduler).
  estimateUsd: number;
}

const STDERR_TAIL_CHARS = 4000;
// How much of the earlier conversation a task carries over when it changes provider.
const HISTORY_CHARS = 8_000;
const providerName = (p: Provider) => PROVIDERS.find((x) => x.id === p)!.label;
const DAY_MS = 24 * 60 * 60 * 1000;
// Budgets use a sliding 24-hour window, so a held run may become startable just by waiting.
const RECHECK_MS = 60_000;

// Starts agent processes (Claude Code or Codex) for tasks, records what they stream and settles each run's outcome.
// A plain chat runs at once. A role's task is queued, and the scheduler starts it when one of the
// role's agents is free and the compute rules allow. One run per task at a time.
export class Runner {
  modelOptions: Record<Provider, readonly ModelOption[]> = MODEL_PRESETS;
  private readonly contextFingerprints = new Map<string, string>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly runsDir: string;
  private readonly promptsDir: string;
  private tickPending = false;
  private closed = false;
  private readonly recheck: NodeJS.Timeout;
  replies: ReplyHandler | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    dataDir: string,
    // Tests inject launchers; the app resolves them from Settings on every run.
    private readonly launcherOverride: Partial<Record<Provider, Launcher>> = {},
  ) {
    this.runsDir = path.join(dataDir, "runs");
    this.promptsDir = path.join(dataDir, "prompts");
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.promptsDir, { recursive: true });
    for (const run of this.store.runsNeedingToolCounts()) {
      const ids = new Set(this.readEvents(run.id).flatMap(({ event }) => (event.kind === "tool_use" ? [event.id] : [])));
      this.store.setToolCalls(run.id, ids.size);
    }
    this.recheck = setInterval(() => this.tick(), RECHECK_MS);
    this.recheck.unref();
  }

  isTaskRunning(taskId: string): boolean {
    for (const a of this.active.values()) if (a.taskId === taskId) return true;
    return false;
  }

  activeCount(): number {
    return this.active.size;
  }

  activeRuns(): { runId: string; taskId: string; agentId: string | null; departmentId: string | null; canEdit: boolean }[] {
    return [...this.active.values()].map(({ runId, taskId, agentId, departmentId, canEdit }) => ({ runId, taskId, agentId, departmentId, canEdit }));
  }

  eventsFile(runId: string): string {
    return path.join(this.runsDir, `${runId}.jsonl`);
  }

  readEvents(runId: string): StampedEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(this.eventsFile(runId), "utf8");
    } catch {
      return [];
    }
    const events: StampedEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as StampedEvent);
      } catch {
        // A line cut short by a crash; the rest of the file is still good.
      }
    }
    return events;
  }

  // Adds the user's message to the conversation and starts the agent on it, or queues it.
  send(taskId: string, text: string): { message: Message; run: Run } {
    let task = this.requireIdleTask(taskId);
    this.checkBudget(task);
    if (task.autoCompact && task.handoff && task.handoffRunId === this.store.listRuns(taskId).at(-1)?.id) {
      task = this.compact(taskId, task.handoff);
    }
    // Any reply answers an open question.
    if (task.question) task = this.store.updateTask(task.id, { question: null })!;
    const message = this.store.addMessage({ taskId, role: "user", text, runId: null });
    const run = task.roleId ? this.enqueue(task, message, null) : this.startNow(task, message, text);
    return { message, run };
  }

  usageSummary(taskId: string) {
    const runs = this.store.taskTreeRuns(taskId);
    return {
      tokens: runs.reduce((n, r) => n + totalTokens(r.usage), 0),
      toolCalls: runs.reduce((n, r) => n + r.toolCalls, 0),
      runs: runs.length,
      unreportedRuns: runs.filter((r) => r.status !== "queued" && totalTokens(r.usage) === 0).length,
    };
  }

  remainingAllowance(task: Task): { tokens: number | null; tools: number | null } {
    let tokens = Infinity;
    let tools = Infinity;
    let current: Task | null = task;
    while (current) {
      const usage = this.usageSummary(current.id);
      if (current.tokenBudget !== null) tokens = Math.min(tokens, current.tokenBudget - usage.tokens);
      if (current.toolBudget !== null) tools = Math.min(tools, current.toolBudget - usage.toolCalls);
      current = current.parentTaskId ? this.store.getTask(current.parentTaskId) : null;
    }
    return { tokens: tokens === Infinity ? null : Math.max(0, tokens), tools: tools === Infinity ? null : Math.max(0, tools) };
  }

  budgetReason(task: Task): string | null {
    let current: Task | null = task;
    while (current) {
      const usage = this.usageSummary(current.id);
      if ((current.tokenBudget !== null && usage.tokens >= current.tokenBudget) || (current.toolBudget !== null && usage.toolCalls >= current.toolBudget)) {
        return `Usage checkpoint reached for "${current.title}". Review the work and raise its task allowance to continue; a compact handoff does not reset usage.`;
      }
      current = current.parentTaskId ? this.store.getTask(current.parentTaskId) : null;
    }
    return null;
  }

  private checkBudget(task: Task) {
    const reason = this.budgetReason(task);
    if (reason) throw new RunnerError(reason, 409);
  }

  compact(taskId: string, summary: string): Task {
    this.requireIdleTask(taskId);
    if (!summary.trim() || summary.length > 6000) throw new RunnerError("A handoff must contain 1–6,000 characters.", 400);
    const task = this.store.updateTask(taskId, { handoff: summary.trim(), handoffRunId: null, sessionId: null, sessionStarted: false, sessionProvider: null })!;
    this.contextFingerprints.delete(taskId);
    this.publishTask(task);
    return task;
  }

  prepareHandoff(taskId: string): { message: Message; run: Run } {
    const task = this.requireIdleTask(taskId);
    this.checkBudget(task);
    if (!task.sessionStarted) throw new RunnerError("There is no active session to summarize. Enter a handoff manually instead.", 409);
    if (task.sessionProvider !== this.choice(task).provider)
      throw new RunnerError("Select the current session's provider to prepare its handoff, or enter a summary manually.", 409);
    const message = this.store.addMessage({ taskId, role: "user", text: HANDOFF_REQUEST, runId: null });
    const run = task.roleId ? this.enqueue(task, message, HANDOFF_REQUEST, "handoff") : this.startNow(task, message, HANDOFF_REQUEST, "handoff");
    return { message, run };
  }

  // Runs the message of a run that did not finish again, as a new run.
  retry(runId: string): Run {
    const previous = this.store.getRun(runId);
    if (!previous) throw new RunnerError("Run not found.", 404);
    if (previous.status === "running" || previous.status === "queued" || previous.status === "succeeded")
      throw new RunnerError("Only a failed, stopped or interrupted run can be retried.", 409);
    const latest = this.store.listRuns(previous.taskId).at(-1);
    if (latest?.id !== previous.id) throw new RunnerError("Only the latest run of a task can be retried.", 409);
    const task = this.requireIdleTask(previous.taskId);
    this.checkBudget(task);
    const message = this.store.getMessage(previous.messageId);
    if (!message) throw new RunnerError("The message of that run no longer exists.", 404);
    // A resumed session may already hold the first attempt's copy of the message.
    const prompt = task.sessionStarted
      ? `(Your previous attempt at this did not finish: ${previous.error ?? previous.status}. Please try again.)\n\n${message.text}`
      : message.text;
    return task.roleId ? this.enqueue(task, message, prompt, previous.purpose) : this.startNow(task, message, prompt, previous.purpose);
  }

  // Stops an active run, or takes a queued one out of the queue.
  stop(runId: string): boolean {
    const active = this.active.get(runId);
    if (active) {
      active.stopRequested = true;
      if (active.child?.pid) killTree(active.child);
      return true;
    }
    const run = this.store.getRun(runId);
    if (run?.status !== "queued") return false;
    const finished = this.store.finishRun(runId, { status: "stopped", error: "Stopped by you." });
    if (finished) this.bus.publish({ type: "run_updated", run: finished });
    this.publishTask(this.store.updateTask(run.taskId, { status: "idle" }));
    this.tick();
    return true;
  }

  // The owner lets a queued run past its budget or an open emergency.
  force(runId: string): Run {
    const run = this.store.getRun(runId);
    if (run?.status !== "queued") throw new RunnerError("Only a queued run can be run anyway.", 409);
    const forced = this.store.forceRun(runId)!;
    this.bus.publish({ type: "run_updated", run: forced });
    this.tick();
    return forced;
  }

  stopAll(): void {
    for (const runId of this.active.keys()) this.stop(runId);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.recheck);
    this.contextFingerprints.clear();
    this.stopAll();
  }

  // Runs a scheduling pass soon. Calls in the same turn of the event loop share one pass.
  tick(): void {
    if (this.tickPending || this.closed) return;
    this.tickPending = true;
    setImmediate(() => {
      this.tickPending = false;
      if (!this.closed) this.schedule();
    });
  }

  private requireIdleTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new RunnerError("Task not found.", 404);
    if (this.isTaskRunning(taskId)) throw new RunnerError("An agent is already working on this task. Wait for it or stop it first.", 409);
    if (task.status === "queued") throw new RunnerError("This task is already queued for an agent. Wait for it or stop it first.", 409);
    return task;
  }

  // Provider, model and effort for a run: the task's, else its role's, else the project's.
  private choice(task: Task): Choice & { roleCanEdit: boolean } {
    const project = this.store.getProject(task.projectId);
    const role = task.roleId ? this.store.getRole(task.roleId) : null;
    const choice = resolveChoice([
      { provider: task.provider, model: task.model, effort: task.effort },
      { provider: role?.provider ?? null, model: role?.model ?? null, effort: role?.effort ?? null },
      { provider: project?.defaultProvider ?? null, model: project?.defaultModel || null, effort: project?.defaultEffort ?? null },
    ]);
    return { ...choice, roleCanEdit: role ? role.canEdit : true };
  }

  private enqueue(task: Task, message: Message, prompt: string | null, purpose: Run["purpose"] = "work"): Run {
    const role = this.store.getRole(task.roleId!);
    if (!role) throw new RunnerError("This task's role no longer exists.", 409);
    const { provider, model, effort } = this.choice(task);
    const run = this.store.createRun({
      taskId: task.id,
      messageId: message.id,
      provider,
      model: model ?? "",
      effort,
      sessionId: task.sessionId,
      status: "queued",
      roleId: role.id,
      departmentId: role.departmentId,
      prompt,
    });
    this.store.setRunPurpose(run.id, purpose);
    run.purpose = purpose;
    this.bus.publish({ type: "run_updated", run });
    this.publishTask(this.store.updateTask(task.id, { status: "queued" }));
    this.tick();
    return run;
  }

  private startNow(task: Task, message: Message, prompt: string, purpose: Run["purpose"] = "work"): Run {
    const project = this.store.getProject(task.projectId);
    if (!project) throw new RunnerError("Project not found.", 404);
    const { provider, model, effort } = this.choice(task);
    const run = this.store.createRun({
      taskId: task.id,
      messageId: message.id,
      provider,
      model: model ?? "",
      effort,
      sessionId: task.sessionId,
      status: "running",
      prompt: prompt === message.text ? null : prompt,
    });
    this.store.setRunPurpose(run.id, purpose);
    return this.launch(run.id, null);
  }

  // One scheduling pass: start what may start, and tell queued runs why they wait.
  private schedule(): void {
    const queuedRuns = this.store.runsWithStatus("queued");
    if (queuedRuns.length === 0) return;

    const settings = this.store.getSettings();
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const departments = this.store.listDepartments();
    const roles = new Map(this.store.listRoles().map((r) => [r.id, r]));
    const costs = this.store.costByRoleEffort();
    const estimate = (roleId: string | null, effort: Effort) => (roleId ? costs.get(roleId)?.[effort]?.avgUsd : undefined) ?? EFFORT_COST_GUESS[effort];

    const deptSpend = this.store.departmentSpendSince(since);
    let spend = this.store.totalSpendSince(since);
    for (const a of this.active.values()) {
      spend += a.estimateUsd;
      if (a.departmentId) deptSpend.set(a.departmentId, (deptSpend.get(a.departmentId) ?? 0) + a.estimateUsd);
    }

    const busy = new Set([...this.active.values()].map((a) => a.agentId).filter(Boolean));
    const freeAgents = new Map<string, string[]>();
    const staffedRoles = new Set<string>();
    for (const agent of this.store.listAgents()) {
      if (agent.paused) continue;
      staffedRoles.add(agent.roleId);
      if (!busy.has(agent.id)) freeAgents.set(agent.roleId, [...(freeAgents.get(agent.roleId) ?? []), agent.id]);
    }

    const queued: QueuedRun[] = [];
    for (const run of queuedRuns) {
      const task = this.store.getTask(run.taskId);
      const role = run.roleId ? roles.get(run.roleId) : undefined;
      if (!task || !role) {
        const finished = this.store.finishRun(run.id, { status: "stopped", error: "The role of this task was removed before an agent picked it up." });
        if (finished) this.bus.publish({ type: "run_updated", run: finished });
        if (task) this.publishTask(this.store.updateTask(task.id, { status: "idle" }));
        continue;
      }
      const { effort } = this.choice(task);
      queued.push({
        runId: run.id,
        projectId: task.projectId,
        roleId: role.id,
        roleName: role.name,
        departmentId: role.departmentId,
        canEdit: task.canEdit && role.canEdit,
        priority: task.priority,
        emergency: task.emergency,
        forced: run.forced,
        queuedAt: run.startedAt,
        estimateUsd: estimate(role.id, effort),
      });
    }

    const state: SchedulerState = {
      maxConcurrent: settings.maxConcurrentRuns,
      budgetUsd: settings.dailyBudgetUsd,
      spendUsd: spend,
      departments: new Map(departments.map((d) => [d.id, { name: d.name, weight: d.weight, budgetUsd: d.dailyBudgetUsd, spendUsd: deptSpend.get(d.id) ?? 0 }])),
      freeAgents,
      staffedRoles,
      frozenProjects: new Set(this.store.openEmergencies().map((t) => t.projectId)),
      active: [...this.active.values()].map((a) => ({ runId: a.runId, departmentId: a.departmentId, canEdit: a.canEdit })),
      queued,
    };
    const result = plan(state);

    for (const { runId, agentId } of result.start) {
      try {
        this.launch(runId, agentId);
      } catch (error) {
        const finished = this.store.finishRun(runId, { status: "failed", error: (error as Error).message });
        if (finished) this.bus.publish({ type: "run_updated", run: finished });
      }
    }
    for (const [runId, reason] of result.waiting) {
      const run = queuedRuns.find((r) => r.id === runId);
      if (run && run.waitReason !== reason) {
        const updated = this.store.setWaitReason(runId, reason);
        if (updated) this.bus.publish({ type: "run_updated", run: updated });
      }
    }
  }

  // Role context for a run: the preamble (text, and a file for Claude), the stdin preface and the
  // edit rules.
  private roleContext(task: Task, agentId: string | null, firstTurn: boolean, runId: string, provider: Provider, readOnly = false) {
    const role = task.roleId ? this.store.getRole(task.roleId) : null;
    const project = this.store.getProject(task.projectId);
    if (!role || !project) return null;
    const departments = this.store.listDepartments(project.id);
    const department = departments.find((d) => d.id === role.departmentId);
    if (!department) return null;
    const agentName = (agentId && this.store.agentName(agentId)) || role.name;
    const systemText = roleSystemPrompt({ projectName: project.name, department, departments, role: readOnly ? { ...role, canEdit: false } : role, agentName });
    let file: string | null = null;
    if (provider === "claude") {
      file = path.join(this.promptsDir, `${runId}.md`);
      fs.writeFileSync(file, systemText);
    }
    const docs = listDocs(project.repoPath, departments);
    // Provide paths, not document bodies. The agent reads only what the current task needs.
    const contextDocs: { path: string; content: string }[] = [];
    const fromRole = task.createdByRoleId ? (this.store.getRole(task.createdByRoleId)?.name ?? "another role") : null;
    const roles = this.store.listRoles(project.id);
    const fingerprint = createHash("sha256").update(JSON.stringify({ departments, roles, docs })).digest("hex");
    const includeCatalog = firstTurn || this.contextFingerprints.get(task.id) !== fingerprint;
    this.contextFingerprints.set(task.id, fingerprint);
    const preface =
      studioContext({ departments, roles, docs, contextDocs, task, fromRole, firstTurn, includeCatalog }) +
      (firstTurn && role.contextDocs.length ? `\nRelevant reference paths (read as needed): ${role.contextDocs.join(", ")}\n` : "");
    const rules: EditRules = editRules(department, departments);
    return { file, systemText, preface, rules, department, allowedTools: role.allowedTools ?? project.allowedTools };
  }

  private launch(runId: string, agentId: string | null): Run {
    const queuedRun = this.store.getRun(runId)!;
    const task = this.store.getTask(queuedRun.taskId)!;
    const blocked = this.budgetReason(task);
    if (blocked) {
      const held = this.store.finishRun(runId, { status: "stopped", error: blocked })!;
      this.bus.publish({ type: "run_updated", run: held });
      this.publishTask(this.store.updateTask(task.id, { status: "idle" }));
      return held;
    }
    const project = this.store.getProject(task.projectId);
    if (!project) throw new RunnerError("Project not found.", 404);

    const { provider, model, effort, roleCanEdit } = this.choice(task);
    const cli = provider === "codex" ? CODEX_CLI : CLAUDE_CLI;
    const canEdit = task.canEdit && roleCanEdit && queuedRun.purpose !== "handoff";
    const role = task.roleId ? this.store.getRole(task.roleId) : null;
    // A session belongs to one provider. After a switch the conversation so far goes into the
    // prompt of a new session instead.
    const switched = task.sessionStarted && task.sessionProvider !== null && task.sessionProvider !== provider;
    const resume = task.sessionStarted && task.sessionId !== null && !switched;
    // Claude takes the id we choose; Codex picks one and reports it in its first event.
    const sessionId = resume ? task.sessionId! : provider === "claude" ? randomUUID() : null;

    const run = this.store.startRun(runId, {
      provider,
      model: model ?? "",
      effort,
      sessionId,
      agentId,
      departmentId: role?.departmentId ?? null,
    })!;
    const costs = role ? this.store.costByRoleEffort().get(role.id) : undefined;
    const active: ActiveRun = {
      runId: run.id,
      taskId: task.id,
      child: null,
      stopRequested: false,
      agentId,
      departmentId: role?.departmentId ?? null,
      canEdit,
      estimateUsd: costs?.[effort]?.avgUsd ?? EFFORT_COST_GUESS[effort],
    };
    this.active.set(run.id, active);
    this.publishTask(this.store.updateTask(task.id, { status: "running", sessionId: sessionId ?? task.sessionId, agentId: agentId ?? task.agentId }));
    this.bus.publish({ type: "run_updated", run });

    const message = this.store.getMessage(run.messageId);
    let prompt = this.store.runPrompt(run.id) ?? message?.text ?? "";
    if (switched) prompt = `${this.conversationSoFar(task.id, run.messageId)}${prompt}`;
    if (!resume && task.handoff) prompt = `<compact-handoff>\n${task.handoff}\n</compact-handoff>\n\n${prompt}`;

    let seq = 0;
    const events: AgentEvent[] = [];
    let result: Extract<AgentEvent, { kind: "result" }> | null = null;
    let stderrTail = "";
    let settled = false;
    let promptFile: string | null = null;
    let switchCount = this.store
      .listRuns(task.id)
      .filter((r) => r.messageId === run.messageId && this.store.runPrompt(r.id)?.startsWith("<model-continuation>")).length;
    let reviewNoticed = false;
    const pendingTools = new Set<string>();
    const seenTools = new Set<string>();

    const record = (event: AgentEvent) => {
      const stamped: StampedEvent = { seq: seq++, at: new Date().toISOString(), event };
      events.push(event);
      // Written before it is published, so a client that loads the file after a push sees it.
      fs.appendFileSync(this.eventsFile(run.id), JSON.stringify(stamped) + "\n");
      this.bus.publish({ type: "run_event", runId: run.id, taskId: task.id, stamped });
      if (event.kind === "text" && run.purpose === "work") {
        const review = parseModelReview(event.text);
        if (review) {
          reviewNoticed = true;
          const invalid = validateModelReview(review, provider, [...this.modelOptions[provider]], { provider, model, effort });
          record({
            kind: "notice",
            level: invalid ? "warn" : "info",
            text: invalid ?? `Task assessment: ${review.complexity}. Recommended ${review.model ?? "CLI default"} / ${review.effort}: ${review.reason}`,
          });
        }
      }
      if (event.kind === "tool_use" && !seenTools.has(event.id)) {
        seenTools.add(event.id);
        pendingTools.add(event.id);
        this.store.setToolCalls(run.id, seenTools.size);
        const updated = this.store.getRun(run.id);
        if (updated) this.bus.publish({ type: "run_updated", run: updated });
      }
      if (event.kind === "tool_result") pendingTools.delete(event.toolUseId);
      if (event.kind === "tool_result" && pendingTools.size === 0 && !active.stopRequested) {
        const reason = this.budgetReason(this.store.getTask(task.id) ?? task);
        if (reason) {
          active.checkpointReason = reason;
          record({ kind: "notice", level: "warn", text: reason + " Stopping after reported tool completion. A handoff may need to be entered manually." });
          this.stop(run.id);
        }
      }
    };

    const settle = (exitError: string | null) => {
      if (settled) return;
      settled = true;
      this.active.delete(run.id);
      if (promptFile) fs.rmSync(promptFile, { force: true });
      // The app is shutting down and its database is closing: the next start marks this run
      // interrupted, which is what happened.
      if (this.closed) return;
      const status = active.stopRequested ? "stopped" : result ? (result.isError ? "failed" : "succeeded") : "failed";
      const error =
        status === "stopped"
          ? (active.checkpointReason ?? "Stopped by you.")
          : status === "failed"
            ? (result?.isError ? result.text : null) || exitError || stderrTail.trim() || `${cli.name} exited without a result.`
            : null;
      const reply = (result && !result.isError ? result.text : "") || finalText(events);
      if (reply.trim()) this.store.addMessage({ taskId: task.id, role: "assistant", text: reply, runId: run.id });
      if (status === "succeeded") {
        const handoff = extractHandoff(reply);
        this.store.updateTask(task.id, { handoff, handoffRunId: handoff ? run.id : null });
        if (run.purpose === "handoff" && !handoff)
          record({
            kind: "notice",
            level: "warn",
            text: "No valid handoff was returned. The existing session is unchanged; enter or edit a summary manually.",
          });
      } else {
        this.store.updateTask(task.id, { handoffRunId: null });
      }
      const finished = this.store.finishRun(run.id, {
        status,
        usage: result?.usage,
        costUsd: result?.costUsd,
        error,
        sessionId: result?.sessionId ?? sessionId,
      });
      const routingText = [...events.flatMap((e) => (e.kind === "text" ? [e.text] : [])), reply].join("\n");
      const review = run.purpose === "work" ? parseModelReview(routingText) : null;
      const requestedSwitch = status === "succeeded" && review?.action === "switch";
      if (status === "succeeded" && run.purpose === "work" && !reviewNoticed && !review)
        record({ kind: "notice", level: "warn", text: "The agent did not return the required model assessment. Settings were not changed." });
      let waiting = false;
      if (status === "succeeded" && !requestedSwitch && run.purpose !== "handoff" && this.replies && !this.closed) {
        try {
          const outcome = this.replies.afterReply(this.store.getTask(task.id) ?? task, run, reply);
          for (const notice of outcome.notices) record({ kind: "notice", ...notice });
          waiting = outcome.waiting;
        } catch (error) {
          record({ kind: "notice", level: "warn", text: `The dashboard could not act on this reply: ${(error as Error).message}` });
        }
      }
      if (finished) this.bus.publish({ type: "run_updated", run: finished });
      const checkpoint = this.budgetReason(this.store.getTask(task.id) ?? task);
      if (checkpoint) record({ kind: "notice", level: "warn", text: checkpoint });
      // A role's task is done once its agent finished without asking anything; a chat waits for
      // the owner's next message.
      const hasHandoff = this.store.getTask(task.id)?.handoffRunId === run.id;
      const next =
        status === "failed"
          ? "failed"
          : waiting
            ? "waiting"
            : status === "succeeded" && task.roleId && run.purpose !== "handoff" && !hasHandoff
              ? "done"
              : "idle";
      this.publishTask(this.store.updateTask(task.id, { status: next }));
      if (requestedSwitch) {
        const currentTask = this.store.getTask(task.id)!;
        const currentChoice = this.choice(currentTask);
        const handoff = extractHandoff(reply);
        const invalid =
          validateModelReview(review, provider, [...this.modelOptions[provider]], { provider, model, effort }) ??
          (switchCount >= 3 ? "Automatic switch limit reached for this message. Review the next step before sending another message." : null) ??
          (currentChoice.provider !== provider || currentChoice.model !== model || currentChoice.effort !== effort
            ? "Settings changed while this run was active; the agent recommendation was not applied."
            : null) ??
          (!handoff ? "A model switch requires a valid compact handoff in the final reply." : null) ??
          this.budgetReason(currentTask);
        if (invalid) {
          record({ kind: "notice", level: "warn", text: `Model switch paused: ${invalid}` });
          this.publishTask(this.store.updateTask(task.id, { status: "idle" }));
        } else {
          try {
            const updated = this.store.updateTask(task.id, {
              provider,
              model: review.model,
              effort: review.effort,
              handoff,
              handoffRunId: null,
              sessionId: null,
              sessionStarted: false,
              sessionProvider: null,
              status: "idle",
            })!;
            this.contextFingerprints.delete(task.id);
            this.publishTask(updated);
            record({
              kind: "notice",
              level: "info",
              text: `Switching to ${review.model ?? "CLI default"} / ${review.effort} for: ${review.nextStep}. Usage allowance is unchanged.`,
            });
            const original = this.store.getMessage(run.messageId)!;
            const continuation = `<model-continuation>\nOriginal owner request:\n${original.text}\n\nNext step:\n${review.nextStep}\n</model-continuation>`;
            if (task.roleId) this.enqueue(updated, original, continuation);
            else this.startNow(updated, original, continuation);
          } catch (error) {
            record({ kind: "notice", level: "warn", text: `Could not continue after model switch: ${(error as Error).message}` });
          }
        }
      }
      this.tick();
    };

    if (switched)
      record({
        kind: "notice",
        level: "info",
        text: `Switched from ${providerName(task.sessionProvider!)} to ${providerName(provider)}: a new session starts with up to 8,000 characters of recent conversation.`,
      });

    let launcher: Launcher;
    let args: string[];
    let input = prompt;
    let cwd = project.repoPath;
    try {
      const settings = this.store.getSettings();
      launcher =
        this.launcherOverride[provider] ??
        (provider === "codex" ? resolveLauncher(settings.codexPath, process.env, CODEX_CLI) : resolveLauncher(settings.claudePath));
      if (!fs.existsSync(project.repoPath)) throw new Error(`The project folder does not exist: ${project.repoPath}`);
      const ctx = role ? this.roleContext(task, agentId, !resume, run.id, provider, run.purpose === "handoff") : null;
      if (ctx) {
        promptFile = ctx.file;
        input = `${ctx.preface}\n${prompt}`;
      }
      if (provider === "claude") {
        args = buildArgs({
          model: model!,
          effort,
          sessionId: sessionId!,
          resume,
          canEdit,
          allowedTools: ctx?.allowedTools ?? project.allowedTools,
          systemPrompt: systemPrompt(project.name, canEdit),
          systemPromptFile: ctx?.file ?? undefined,
          editRules: ctx?.rules ?? null,
        });
      } else {
        // Codex has no system prompt option that takes a file, so its instructions open the first
        // message. Its sandbox makes the working directory writable, so a department confined to
        // folders works from its first folder, with the others as extra writable roots.
        const confined = canEdit && ctx && !ctx.department.folders.includes(".");
        let where = "";
        let roots: string[] = [];
        if (confined) {
          const [first, ...rest] = ctx.department.folders;
          cwd = path.join(project.repoPath, ...first!.split("/"));
          fs.mkdirSync(cwd, { recursive: true });
          roots = rest.map((f) => path.join(project.repoPath, ...f.split("/")));
          const up = first!
            .split("/")
            .map(() => "..")
            .join("/");
          where = `\n\nYour working directory is \`${first}/\` inside the repository; the repository root is \`${up}\`. Only your department's folders are writable.`;
        }
        if (!resume) input = `<instructions>\n${ctx ? ctx.systemText : systemPrompt(project.name, canEdit)}${where}\n</instructions>\n\n${input}`;
        args = buildCodexArgs({ model, effort, resumeId: resume ? sessionId : null, sandbox: canEdit ? "workspace-write" : "read-only", writableRoots: roots });
      }
      const allowance = this.remainingAllowance(task);
      input += `\n\n${efficiencyInstructions(allowance.tokens, allowance.tools)}`;
      if (run.purpose === "work") input += `\n\n${modelRoutingInstructions({ provider, model, effort }, [...this.modelOptions[provider]], switchCount)}`;
    } catch (error) {
      record({ kind: "error", message: (error as Error).message });
      settle((error as Error).message);
      return this.store.getRun(run.id)!;
    }

    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX so Stop can end the agent's children too.
      detached: process.platform !== "win32",
    });
    active.child = child;

    child.on("error", (error) => {
      record({ kind: "error", message: `Could not start ${cli.name} (${launcher.display}): ${error.message}` });
      settle(error.message);
    });

    child.stdin?.on("error", () => {
      // The process exited before reading its prompt; the exit handler reports why.
    });
    child.stdin?.end(input);

    const parse = provider === "codex" ? createCodexParser() : parseClaudeLine;
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      // Output still draining after shutdown has no database to go to.
      if (this.closed) return;
      for (const event of parse(line)) {
        // The session now exists: later messages resume it, with this provider.
        if (event.kind === "init") {
          const id = event.sessionId || sessionId;
          if (!task.sessionStarted || task.sessionId !== id || task.sessionProvider !== provider) {
            this.publishTask(this.store.updateTask(task.id, { sessionStarted: true, sessionId: id, sessionProvider: provider }));
            Object.assign(task, { sessionStarted: true, sessionId: id, sessionProvider: provider });
          }
        }
        if (event.kind === "result") result = event;
        record(event);
      }
    });

    readline.createInterface({ input: child.stderr! }).on("line", (line) => {
      if (this.closed) return;
      stderrTail = (stderrTail + line + "\n").slice(-STDERR_TAIL_CHARS);
      if (line.trim()) record({ kind: "stderr", text: line });
    });

    child.on("close", (code, signal) => {
      settle(code === 0 ? null : `${cli.name} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`);
    });

    return this.store.getRun(run.id)!;
  }

  // The messages before this one, newest last, cut from the start to fit.
  private conversationSoFar(taskId: string, beforeMessageId: string): string {
    const messages = this.store.listMessages(taskId);
    const end = messages.findIndex((m) => m.id === beforeMessageId);
    const earlier = (end < 0 ? messages : messages.slice(0, end)).map((m) => `${m.role === "user" ? "Owner" : "Agent"}: ${m.text}`).join("\n\n");
    if (!earlier) return "";
    const text =
      earlier.length > HISTORY_CHARS
        ? `[Older conversation omitted to limit tokens; consult project files for details.]\n${earlier.slice(-HISTORY_CHARS)}`
        : earlier;
    return `<conversation-so-far>\nThis conversation started with another agent. What was said so far:\n\n${text}\n</conversation-so-far>\n\n`;
  }

  private publishTask(task: Task | null) {
    if (task) this.bus.publish({ type: "task_updated", task });
  }
}

function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // Some Windows hosts deny or stall taskkill. Still terminate the agent itself.
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill();
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 3000).unref();
}
