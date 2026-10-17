import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  createCodexParser,
  finalText,
  parseClaudeLine,
  parseReplyBlocks,
  PROVIDERS,
  MODEL_PRESETS,
  type ModelOption,
  resolveChoice,
  type AgentEvent,
  type Choice,
  type Effort,
  type Message,
  type Provider,
  type Role,
  type Run,
  type StampedEvent,
  type Task,
  type ReplyBlock,
  type TaskAction,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import { buildArgs, CLAUDE_CLI, resolveLauncher, systemPrompt, type Launcher } from "./claude.ts";
import { buildCodexArgs, CODEX_CLI } from "./codex.ts";
import { listDocs } from "./docs.ts";
import { HttpError } from "./http.ts";
import { editRules, type EditRules } from "./folders.ts";
import { COMMIT_ID, git, workChanges } from "./git.ts";
import { reviewPrompt, roleSystemPrompt, studioContext } from "./prompts.ts";
import { limitWindowFromError, type RunCoordinator } from "./coordinator.ts";
import { EFFORT_COST_GUESS, plan, type ProviderHold, type QueuedRun, type SchedulerState } from "./scheduler.ts";
import { nextStage, type StageEvent } from "./stages.ts";
import type { Store } from "./store.ts";
import { efficiencyInstructions, extractHandoff, HANDOFF_REQUEST, totalTokens } from "./efficiency.ts";
import { modelRoutingInstructions, parseModelReview, validateModelReview } from "./model-routing.ts";
import { Workspaces } from "./workspaces.ts";
import { Github } from "./github.ts";
import { baselineBlocker } from "./readiness.ts";

export class RunnerError extends HttpError {}

export interface Notice {
  level: "info" | "warn";
  text: string;
}

export interface ReplyOutcome {
  notices: Notice[];
  waiting: boolean;
  // The role task's last step block, null without one.
  step: Extract<ReplyBlock, { type: "step" }> | null;
  // The steps still to do, including the one this reply finishes, when the agent gave a plan.
  plan: string[] | null;
}

// What the studio does with a finished reply (its task, proposal, question and step blocks).
export interface ReplyHandler {
  afterReply(task: Task, run: Run, reply: string): ReplyOutcome;
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
// Hands-off delivery sends review findings back this many times in a row before the owner decides.
const AUTO_FIX_ROUNDS = 3;

// Starts agent processes (Claude Code or Codex) for tasks, records what they stream and settles each run's outcome.
// A plain chat runs at once. A role's task is queued, and the scheduler starts it when one of the
// role's agents is free and the compute rules allow. One run per task at a time.
export class Runner {
  modelOptions: Record<Provider, readonly ModelOption[]> = MODEL_PRESETS;
  private readonly contextFingerprints = new Map<string, string>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly runsDir: string;
  private readonly promptsDir: string;
  private readonly workspaces: Workspaces;
  private readonly github: Github;
  private readonly workspaceBusy = new Set<string>();
  private readonly deliveryBusy = new Set<string>();
  // Projects with a reviewed task waiting for hands-off delivery: their queued work holds until it lands.
  private readonly deliveryPending = new Set<string>();
  // taskId:checkpoint pairs whose automatic delivery failed; the owner takes over until the checkpoint changes.
  private readonly deliveryFailed = new Set<string>();
  private tickPending = false;
  private tickAgain = false;
  private closed = false;
  private readonly recheck: NodeJS.Timeout;
  replies: ReplyHandler | null = null;
  coordinator: RunCoordinator | null = null;
  deliver: ((projectId: string, taskId: string) => Promise<void>) | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    dataDir: string,
    // Tests inject launchers; the app resolves them from Settings on every run.
    private readonly launcherOverride: Partial<Record<Provider, Launcher>> = {},
  ) {
    this.runsDir = path.join(dataDir, "runs");
    this.promptsDir = path.join(dataDir, "prompts");
    this.workspaces = new Workspaces(store, path.join(dataDir, "worktrees"), () => !this.closed);
    this.github = new Github(store, this.workspaces, () => !this.closed);
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
    if (this.workspaceBusy.has(taskId)) return true;
    for (const a of this.active.values()) if (a.taskId === taskId) return true;
    return false;
  }

  activeCount(): number {
    return this.active.size;
  }

  isProjectBusy(projectId: string): boolean {
    return this.deliveryBusy.has(projectId);
  }

  async deliveryOperation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (this.isProjectBusy(projectId)) throw new RunnerError("A delivery operation is already running for this project.", 409);
    if (this.store.listTasks(projectId).some((t) => this.isTaskRunning(t.id)))
      throw new RunnerError("Wait for this project's running agents and checkpoint operations before changing its baseline.", 409);
    this.deliveryBusy.add(projectId);
    try {
      return await operation();
    } finally {
      this.deliveryBusy.delete(projectId);
      this.bus.publish({ type: "studio_changed", projectId });
      this.tick();
    }
  }

  async verifyWorkspaceSnapshot(taskId: string): Promise<void> {
    const w = this.store.getWorkspace(taskId);
    if (!w) throw new RunnerError("Task workspace not found.", 404);
    await this.workspaces.verify(w);
    const head = await git(w.path, ["rev-parse", "HEAD"]);
    const dirty = await git(w.path, ["status", "--porcelain"]);
    if (!head.ok || head.stdout !== w.checkpointCommit || !dirty.ok || dirty.stdout)
      throw new RunnerError("Save and approve a fresh checkpoint before integrating. The task worktree changed.", 409);
  }

  private stagePatch(roleId: Task["roleId"], stage: Task["stage"], event: StageEvent): Partial<Pick<Task, "stage">> {
    if (!roleId || !stage) return {};
    const transition = nextStage(stage, event);
    // A refused transition keeps the existing stage without interrupting run cleanup.
    return transition.error ? {} : { stage: transition.stage };
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
  // auto: the dashboard continues on its own, which counts against the project's step limit.
  send(taskId: string, text: string, auto = false): { message: Message; run: Run } {
    let task = this.requireIdleTask(taskId);
    if (task.canEdit && this.store.getWorkspace(taskId)?.mergeCommit)
      throw new RunnerError("This task has been merged. Start a new task for follow-up changes.", 409);
    if (task.stage === "closed") throw new RunnerError("This task is closed. Reopen it before sending a message.", 409);
    this.checkBudget(task);
    // The owner stepped in, so automatic continuation starts counting again.
    if (!auto && task.autoContinues > 0) task = this.store.updateTask(task.id, { autoContinues: 0 })!;
    if (task.autoCompact && task.handoff && task.handoffRunId === this.store.listRuns(taskId).at(-1)?.id) {
      task = this.compact(taskId, task.handoff);
    }
    // Any reply answers an open question.
    if (task.question) task = this.store.updateTask(task.id, { question: null })!;
    const message = this.store.addMessage({ taskId, role: "user", text, runId: null });
    const run = task.roleId ? this.enqueue(task, message, null) : this.startNow(task, message, text);
    return { message, run };
  }

  // The owner moves a role task through its stages. Moves that start work send a message, and the
  // run start applies the stage change; the others only change the stage.
  stageAction(taskId: string, action: Exclude<TaskAction, { action: "review" }>, deliveryApproval = false): Task {
    if (deliveryApproval && action.action !== "approve") throw new RunnerError("Delivery may only approve the reviewed task.", 400);
    const task = this.requireIdleTask(taskId, deliveryApproval);
    if (!task.roleId || !task.stage) throw new RunnerError("Only a role's task has stages. Use Mark done for a chat.", 400);
    const check = nextStage(task.stage, action.action);
    // Start is also how a run resumes in progress work, but as an owner move it begins backlog work.
    if (check.error || (action.action === "start" && task.stage !== "backlog")) throw new RunnerError(check.error ?? "Start is only for backlog tasks.", 409);

    switch (action.action) {
      case "start":
      case "continue": {
        const text =
          action.text ??
          (task.nextStep
            ? `Continue with: ${task.nextStep}`
            : action.action === "start"
              ? `Start on this task: ${task.title}`
              : "Continue with the next step.");
        this.send(task.id, text);
        return this.store.getTask(task.id)!;
      }
      case "fix": {
        const findings =
          this.store
            .listTaskReviews(task.id)
            .filter((r) => r.verdict === "changes")
            .at(-1)?.findings ?? [];
        const text = action.text ?? ["Address these review findings:", ...findings.map((f) => `- ${f}`)].join("\n");
        this.send(task.id, text);
        return this.store.getTask(task.id)!;
      }
      case "request_changes":
        this.store.addTaskReview({ taskId: task.id, runId: null, reviewer: "owner", verdict: "changes", findings: [action.text] });
        break;
      case "approve": {
        const open = this.store.openChildTasks(task.id);
        if (open.length && !action.force)
          throw new RunnerError(`Delegated work is still open: ${open.map((t) => t.title).join(", ")}. Approve anyway to continue.`, 409);
        this.store.addTaskReview({ taskId: task.id, runId: null, reviewer: "owner", verdict: "approved", findings: [] });
        const workspace = this.store.getWorkspace(task.id);
        if (workspace) this.store.saveWorkspace({ ...workspace, approvedCommit: workspace.checkpointCommit });
        break;
      }
    }
    // Closing answers nothing: the open question goes away with it.
    const updated = this.store.updateTask(task.id, { stage: check.stage, autoContinues: 0, ...(check.stage === "closed" ? { question: null } : {}) })!;
    this.publishTask(updated);
    this.bus.publish({ type: "inbox_changed" });
    this.bus.publish({ type: "studio_changed", projectId: updated.projectId });
    this.tick();
    return updated;
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
      // Name the exact limit and the value to beat: raising the wrong one leaves the task blocked.
      const hit: string[] = [];
      if (current.tokenBudget !== null && usage.tokens >= current.tokenBudget)
        hit.push(`token allowance (${usage.tokens.toLocaleString("en-US")} used of ${current.tokenBudget.toLocaleString("en-US")})`);
      if (current.toolBudget !== null && usage.toolCalls >= current.toolBudget)
        hit.push(`tool-call allowance (${usage.toolCalls} used of ${current.toolBudget})`);
      if (hit.length) {
        const where = current.id === task.id ? "this task" : `the parent task "${current.title}" (open that task to change it)`;
        return `Usage checkpoint reached: the ${hit.join(" and the ")} of ${where}. Open "Context & usage" above the conversation, set that allowance above current usage (or clear it for unlimited), click "Save usage controls", then send a message or Retry. A compact handoff does not reset usage.`;
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
  async retry(runId: string): Promise<Run> {
    const previous = this.store.getRun(runId);
    if (!previous) throw new RunnerError("Run not found.", 404);
    if (previous.status === "running" || previous.status === "queued" || previous.status === "succeeded")
      throw new RunnerError("Only a failed, stopped or interrupted run can be retried.", 409);
    const latest = this.store.listRuns(previous.taskId).at(-1);
    if (latest?.id !== previous.id) throw new RunnerError("Only the latest run of a task can be retried.", 409);
    // A review starts over with the same reviewer and a fresh diff.
    if (previous.purpose === "review") {
      await this.startReview(previous.taskId, previous.roleId ?? undefined);
      return this.store.listRuns(previous.taskId).at(-1)!;
    }
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
  // reason: recorded as the run's error, for stops the owner did not make.
  stop(runId: string, reason?: string): boolean {
    const active = this.active.get(runId);
    if (active) {
      active.stopRequested = true;
      if (reason) active.checkpointReason = reason;
      if (active.child?.pid) killTree(active.child);
      return true;
    }
    const run = this.store.getRun(runId);
    if (run?.status !== "queued") return false;
    const finished = this.store.finishRun(runId, { status: "stopped", error: reason ?? "Stopped by you." });
    if (finished) this.bus.publish({ type: "run_updated", run: finished });
    this.publishTask(this.store.updateTask(run.taskId, { status: "idle", ...this.reviewCancelled(run) }));
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

  async checkpointTask(taskId: string) {
    this.requireIdleTask(taskId);
    if (!this.store.getWorkspace(taskId)) throw new RunnerError("This task has no isolated worktree yet.", 409);
    this.workspaceBusy.add(taskId);
    try {
      const workspace = await this.workspaces.checkpoint(taskId, "Owner checkpoint");
      if (workspace?.error) throw new RunnerError(workspace.error, 409);
      return await this.github.publish(taskId);
    } finally {
      this.workspaceBusy.delete(taskId);
    }
  }

  async publishWorkspace(taskId: string) {
    this.requireIdleTask(taskId);
    if (!this.store.getWorkspace(taskId)) throw new RunnerError("This task has no worktree yet.", 409);
    this.workspaceBusy.add(taskId);
    try {
      const workspace = await this.github.publish(taskId);
      if (workspace?.publishError || workspace?.error) throw new RunnerError(workspace.publishError ?? workspace.error!, 409);
      return workspace;
    } finally {
      this.workspaceBusy.delete(taskId);
    }
  }

  async mergeWorkspace(taskId: string) {
    const task = this.requireIdleTask(taskId);
    if (task.roleId && task.stage !== "approved") throw new RunnerError("Approve this task before merging its pull request.", 409);
    const workspace = this.store.getWorkspace(taskId);
    if (task.roleId && (!workspace?.approvedCommit || workspace.approvedCommit !== workspace.checkpointCommit))
      throw new RunnerError("The checkpoint changed since approval. Return the task to review and approve the current changes before merging.", 409);
    this.workspaceBusy.add(taskId);
    try {
      return await this.github.merge(taskId);
    } catch (error) {
      throw new RunnerError((error as Error).message, 409);
    } finally {
      this.workspaceBusy.delete(taskId);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.recheck);
    this.contextFingerprints.clear();
    this.stopAll();
  }

  // Runs a scheduling pass soon. Calls in the same turn of the event loop share one pass.
  tick(): void {
    if (this.closed) return;
    if (this.tickPending) {
      this.tickAgain = true;
      return;
    }
    this.tickPending = true;
    setImmediate(async () => {
      try {
        if (this.closed) return;
        await this.deliverReviewed();
        if (this.closed) return;
        this.startIdleBacklog();
        let holds = new Map<Provider, ProviderHold>();
        try {
          holds = this.coordinator?.beforeSchedule() ?? holds;
        } catch (error) {
          // A coordinator fault must never stop the queue; it runs as if the coordinator were off.
          console.error("Coordinator pass failed:", error);
        }
        await this.schedule(holds);
      } catch (error) {
        console.error("Scheduling pass failed; queued work remains held:", error);
      } finally {
        this.tickPending = false;
        if (this.tickAgain) {
          this.tickAgain = false;
          this.tick();
        }
      }
    });
  }

  // The provider a task's next work run would use.
  taskProvider(task: Task): Provider {
    return this.choice(task).provider;
  }

  // The provider a queued or running run uses (a review uses its reviewer's choice).
  runProvider(run: Run): Provider {
    const task = this.store.getTask(run.taskId);
    return task ? this.choice(this.actorTask(task, run)).provider : run.provider;
  }

  // Hands-off delivery: a task whose agent review passed on its current checkpoint is approved and
  // integrated as the owner would, once no agent runs in its project (the baseline must hold still).
  // Queued work in that project waits so the moment comes; a failure hands the task to the owner.
  private async deliverReviewed(): Promise<void> {
    this.deliveryPending.clear();
    for (const project of this.store.listProjects()) {
      if (!project.autoApprove || !this.deliver || this.isProjectBusy(project.id) || this.store.deliveryPaused(project.id)) continue;
      const tasks = this.store.listTasks(project.id);
      const key = (task: Task) => `${task.id}:${this.store.getWorkspace(task.id)?.checkpointCommit ?? ""}`;
      const ready = tasks.filter(
        (t) =>
          t.roleId &&
          t.stage === "needs_review" &&
          t.status === "idle" &&
          !(t.stepState === "done" && t.nextStep) &&
          !this.deliveryFailed.has(key(t)) &&
          this.passedOnCheckpoint(t),
      );
      if (ready.length === 0) continue;
      this.deliveryPending.add(project.id);
      if (tasks.some((t) => this.isTaskRunning(t.id))) continue;
      for (const task of ready) {
        try {
          await this.deliver(project.id, task.id);
          this.note(task.id, "info", "Approved and integrated automatically after the passed agent review (project setting).");
        } catch (error) {
          this.deliveryFailed.add(key(task));
          this.note(task.id, "warn", `Automatic approval stopped: ${(error as Error).message} Approve or integrate this task yourself.`);
        }
        if (this.closed) return;
      }
      this.deliveryPending.delete(project.id);
    }
  }

  // A notice after the fact goes on the task's latest finished run, so it shows in the transcript.
  private note(taskId: string, level: "info" | "warn", text: string): void {
    const run = this.store.listRuns(taskId).at(-1);
    if (!run || this.active.has(run.id)) return;
    const stamped: StampedEvent = {
      seq: (this.readEvents(run.id).at(-1)?.seq ?? -1) + 1,
      at: new Date().toISOString(),
      event: { kind: "notice", level, text },
    };
    fs.appendFileSync(this.eventsFile(run.id), JSON.stringify(stamped) + "\n");
    this.bus.publish({ type: "run_event", runId: run.id, taskId, stamped });
  }

  // Projects that opt in: a staffed role with nothing queued or running starts its top backlog
  // task, as the owner's Start would.
  private startIdleBacklog(): void {
    const projects = this.store.listProjects().filter((p) => p.startNextWhenIdle);
    if (projects.length === 0) return;
    const busy = new Set([...this.store.runsWithStatus("queued"), ...this.store.runsWithStatus("running")].map((r) => r.roleId));
    const staffed = new Set(
      this.store
        .listAgents()
        .filter((a) => !a.paused)
        .map((a) => a.roleId),
    );
    for (const project of projects) {
      if (this.isProjectBusy(project.id) || this.deliveryPending.has(project.id) || this.store.deliveryPaused(project.id)) continue;
      for (const task of this.store.backlogTasks(project.id)) {
        if (!task.roleId || busy.has(task.roleId) || !staffed.has(task.roleId) || this.store.dependencyBlocker(task)) continue;
        busy.add(task.roleId);
        try {
          this.stageAction(task.id, { action: "start" });
        } catch {
          // A budget or a removed role holds it; the owner sees the task still in the backlog.
        }
      }
    }
  }

  private requireIdleTask(taskId: string, deliveryApproval = false): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new RunnerError("Task not found.", 404);
    if (this.isProjectBusy(task.projectId) && !deliveryApproval) throw new RunnerError("Wait for the project's delivery operation to finish.", 409);
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

  // roleId: the role whose agent runs it, the task's own except for reviews.
  private enqueue(task: Task, message: Message, prompt: string | null, purpose: Run["purpose"] = "work", roleId = task.roleId): Run {
    const role = this.store.getRole(roleId!);
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
    // Queued work already belongs to the agent, so the board shows it as in progress.
    const stage =
      purpose === "work"
        ? this.stagePatch(task.roleId, task.stage, "start")
        : purpose === "review"
          ? this.stagePatch(task.roleId, task.stage, "review_start")
          : {};
    this.publishTask(this.store.updateTask(task.id, { status: "queued", ...stage }));
    // A step that was waiting for review leaves the inbox.
    if (stage.stage && stage.stage !== task.stage) this.bus.publish({ type: "inbox_changed" });
    if (purpose === "work" && task.roleId && !task.baseCommit) void this.recordBaseCommit(task);
    this.tick();
    return run;
  }

  // Reviews diff the work against the commit it started from.
  private async recordBaseCommit(task: Task) {
    const project = this.store.getProject(task.projectId);
    if (!project) return;
    const head = await git(project.repoPath, ["rev-parse", "HEAD"]);
    if (this.closed || !head.ok || !COMMIT_ID.test(head.stdout)) return;
    if (this.store.getTask(task.id)?.baseCommit === null) this.store.updateTask(task.id, { baseCommit: head.stdout });
  }

  // A review run works as the reviewer role: read-only, with that role's model choice, in a fresh
  // session of its own. The task's session and model choice stay the author's.
  private actorTask(task: Task, run: Pick<Run, "purpose" | "roleId">): Task {
    if (run.purpose !== "review") return task;
    return {
      ...task,
      roleId: run.roleId,
      provider: null,
      model: null,
      effort: null,
      canEdit: false,
      sessionId: null,
      sessionStarted: false,
      sessionProvider: null,
      handoff: null,
    };
  }

  // First match wins: the one-off choice, the task's reviewer, the role's default, the role itself.
  // Only the owner sets these; a reviewer outside the project is ignored.
  private resolveReviewer(task: Task, roleId?: string): Role {
    const inProject = (id: string | null | undefined) => {
      const role = id ? this.store.getRole(id) : null;
      return role?.projectId === task.projectId ? role : null;
    };
    if (roleId) {
      const chosen = inProject(roleId);
      if (!chosen) throw new RunnerError("The reviewer must be a role in this project.", 400);
      return chosen;
    }
    const author = inProject(task.roleId);
    const reviewer = inProject(task.reviewerRoleId) ?? inProject(author?.reviewerRoleId) ?? author;
    if (!reviewer) throw new RunnerError("This task's role no longer exists.", 409);
    return reviewer;
  }

  // The owner asks an agent to review the finished step. The prompt is the server's: the request,
  // the step summary and the diff since the task began.
  async startReview(taskId: string, roleId?: string): Promise<Task> {
    const check = (task: Task) => {
      if (!task.roleId || !task.stage) throw new RunnerError("Only a role's task can be reviewed.", 400);
      const move = nextStage(task.stage, "review_start");
      if (move.error) throw new RunnerError(move.error, 409);
    };
    const before = this.requireIdleTask(taskId);
    check(before);
    this.checkBudget(before);
    const reviewer = this.resolveReviewer(before, roleId);
    const project = this.store.getProject(before.projectId);
    if (!project) throw new RunnerError("Project not found.", 404);
    const workspace = this.store.getWorkspace(taskId);
    if (workspace) await this.workspaces.verify(workspace);
    const changes = await workChanges(workspace?.path ?? project.repoPath, workspace?.baseCommit ?? before.baseCommit);
    // Things may have moved while git ran.
    const task = this.requireIdleTask(taskId);
    check(task);
    const request = this.store.listMessages(task.id).find((m) => m.role === "user")?.text ?? task.title;
    const prompt = reviewPrompt({ title: task.title, request, summary: task.stepSummary, ...changes });
    const message = this.store.addMessage({ taskId, role: "user", text: `Review requested from ${reviewer.name}.`, runId: null });
    this.enqueue(task, message, prompt, "review", reviewer.id);
    return this.store.getTask(taskId)!;
  }

  // Records a finished review run's verdict and returns the stage it leads to. reply is null when
  // the run did not succeed. Only the owner approves: a pass goes back to needs_review.
  private reviewVerdict(run: Run, reply: string | null, record: (event: AgentEvent) => void): Partial<Pick<Task, "stage">> {
    const task = this.store.getTask(run.taskId);
    if (!task) return {};
    const verdict = reply === null ? undefined : parseReplyBlocks(reply).findLast((b) => b.type === "review");
    if (!verdict || verdict.type !== "review") {
      if (reply !== null)
        record({ kind: "notice", level: "warn", text: "The review ended without a valid review block. The step goes back to you unreviewed." });
      return this.stagePatch(task.roleId, task.stage, "review_cancel");
    }
    // Review runs are read-only, so the checkpoint now is the one the reviewer read.
    const commit = this.store.getWorkspace(task.id)?.checkpointCommit ?? null;
    this.store.addTaskReview({ taskId: task.id, runId: run.id, reviewer: run.roleId ?? "agent", verdict: verdict.verdict, findings: verdict.findings, commit });
    const count = `${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`;
    record({ kind: "notice", level: "info", text: `Agent review: ${verdict.verdict === "pass" ? "passed" : "changes requested"} (${count}).` });
    return this.stagePatch(task.roleId, task.stage, verdict.verdict === "pass" ? "review_pass" : "review_changes");
  }

  // The latest review is an agent's pass on exactly the task's current checkpoint.
  private passedOnCheckpoint(task: Task): boolean {
    const last = this.store.listTaskReviews(task.id).at(-1);
    const checkpoint = this.store.getWorkspace(task.id)?.checkpointCommit ?? null;
    return !!last?.runId && last.verdict === "pass" && (last.commit ?? null) === checkpoint;
  }

  // The project's opt-in automation after a step or a review ends: ask for a review, continue after
  // a passed one up to the project's step limit, or (hands-off delivery) send the findings back to
  // the author. Approval itself happens in deliverReviewed.
  // ended: the work run that finished a step, or the review run that gave a verdict.
  private automate(taskId: string, ended: Run, record: (event: AgentEvent) => void): void {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : null;
    if (!task || !project || task.status !== "idle") return;
    try {
      if (ended.purpose === "review" && task.stage === "changes_requested") {
        const review = this.store.listTaskReviews(task.id).at(-1);
        if (!project.autoApprove || review?.runId !== ended.id || task.autoContinues >= AUTO_FIX_ROUNDS) return;
        this.store.updateTask(task.id, { autoContinues: task.autoContinues + 1 });
        record({
          kind: "notice",
          level: "info",
          text: `Sending the findings back to the author automatically (${task.autoContinues + 1} of ${AUTO_FIX_ROUNDS}).`,
        });
        this.send(task.id, ["Address these review findings:", ...review.findings.map((f) => `- ${f}`)].join("\n"), true);
        return;
      }
      if (task.stage !== "needs_review") return;
      if (ended.purpose === "review") {
        const passed = this.store.listTaskReviews(task.id).at(-1);
        if (passed?.runId !== ended.id || passed.verdict !== "pass") return;
        if (task.stepState !== "done" || !task.nextStep || task.autoContinues >= project.autoContinueSteps) return;
        this.store.updateTask(task.id, { autoContinues: task.autoContinues + 1 });
        record({
          kind: "notice",
          level: "info",
          text: `Continuing automatically (${task.autoContinues + 1} of ${project.autoContinueSteps}): ${task.nextStep}`,
        });
        this.send(task.id, `Continue with: ${task.nextStep}`, true);
      } else if (project.autoReview) {
        // A reply that changed no files (a status question, say) keeps the earlier passed review.
        if (this.store.getWorkspace(task.id) && this.passedOnCheckpoint(task)) {
          record({ kind: "notice", level: "info", text: "No changes since the passed agent review, so it is not reviewed again." });
          return;
        }
        record({ kind: "notice", level: "info", text: "Asking for an agent review automatically (project setting)." });
        this.startReview(task.id).catch((error: Error) => record({ kind: "notice", level: "warn", text: `Automatic review did not start: ${error.message}` }));
      }
    } catch (error) {
      record({ kind: "notice", level: "warn", text: `Automation stopped: ${(error as Error).message}` });
    }
  }

  // A review that ends without a verdict hands the work back to the owner.
  private reviewCancelled(run: Pick<Run, "purpose" | "taskId">): Partial<Pick<Task, "stage">> {
    if (run.purpose !== "review") return {};
    const task = this.store.getTask(run.taskId);
    return task ? this.stagePatch(task.roleId, task.stage, "review_cancel") : {};
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
  private async schedule(holds: Map<Provider, ProviderHold>): Promise<void> {
    const readiness = new Map<string, string | null>();
    for (const run of this.store.runsWithStatus("queued")) {
      const task = this.store.getTask(run.taskId);
      const project = task && this.store.getProject(task.projectId);
      if (task && project && run.purpose === "work") {
        if (this.isProjectBusy(project.id)) {
          readiness.set(run.id, "Baseline: a delivery operation is running.");
          continue;
        }
        if (this.deliveryPending.has(project.id)) {
          readiness.set(run.id, "Baseline: waiting for running agents to finish so a reviewed task can be approved and integrated.");
          continue;
        }
        if (this.store.deliveryPaused(project.id)) {
          readiness.set(run.id, "Baseline: delivery is paused for recovery. Review the imported outcomes, then enable delivery automation.");
          continue;
        }
        const baseline = this.store.projectBaseline(project.id);
        this.workspaceBusy.add(task.id);
        try {
          if (baseline && baseline.repoPath !== project.repoPath) throw new Error("The managed baseline belongs to the project's original repository.");
          if (baseline && !this.store.dependencyBlocker(task) && this.store.getWorkspace(task.id)) await this.workspaces.refresh(task.id);
          const w = this.store.getWorkspace(task.id);
          readiness.set(run.id, await baselineBlocker(this.store, task, w?.path ?? project.repoPath, w ? "HEAD" : (baseline?.commit ?? "HEAD")));
        } catch (error) {
          readiness.set(run.id, `Baseline: ${(error as Error).message}`);
        } finally {
          this.workspaceBusy.delete(task.id);
        }
      }
    }
    if (this.closed) return;
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
        if (task) this.publishTask(this.store.updateTask(task.id, { status: "idle", ...this.reviewCancelled(run) }));
        continue;
      }
      if (this.isProjectBusy(task.projectId) || this.deliveryPending.has(task.projectId)) continue;
      // New arrivals during asynchronous Git checks wait for the next pass.
      if (run.purpose === "work" && !readiness.has(run.id)) continue;
      const { effort, provider } = this.choice(this.actorTask(task, run));
      queued.push({
        provider,
        runId: run.id,
        dependencyBlocker: run.purpose === "work" ? (this.store.dependencyBlocker(task) ?? readiness.get(run.id)) : null,
        projectId: task.projectId,
        roleId: role.id,
        roleName: role.name,
        departmentId: role.departmentId,
        // Handoff and review runs only read, so they do not hold the department's writer slot.
        canEdit: run.purpose === "work" && task.canEdit && role.canEdit,
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
      providerHolds: holds,
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
  private roleContext(task: Task, agentId: string | null, firstTurn: boolean, runId: string, provider: Provider, readOnly = false, repoPath?: string) {
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
    const docs = listDocs(repoPath ?? project.repoPath, departments);
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
    try {
      return this.launchRun(runId, agentId);
    } catch (error) {
      // Setup can fail before a child exists. Retain a retryable run and release its slot.
      const active = this.active.get(runId);
      if (active?.child?.pid) killTree(active.child);
      this.active.delete(runId);
      const failed = this.store.finishRun(runId, { status: "failed", error: (error as Error).message })!;
      try {
        this.publishTask(this.store.updateTask(failed.taskId, { status: "failed", ...this.reviewCancelled(failed) }));
      } catch {
        this.publishTask(this.store.setTaskStatus(failed.taskId, "failed"));
      }
      this.bus.publish({ type: "run_updated", run: failed });
      this.tick();
      return failed;
    }
  }

  private launchRun(runId: string, agentId: string | null): Run {
    const queuedRun = this.store.getRun(runId)!;
    const task = this.store.getTask(queuedRun.taskId)!;
    const blocked = this.budgetReason(task);
    if (blocked) {
      const held = this.store.finishRun(runId, { status: "stopped", error: blocked })!;
      this.bus.publish({ type: "run_updated", run: held });
      this.publishTask(this.store.updateTask(task.id, { status: "idle", ...this.reviewCancelled(queuedRun) }));
      return held;
    }
    const project = this.store.getProject(task.projectId);
    if (!project) throw new RunnerError("Project not found.", 404);

    const reviewing = queuedRun.purpose === "review";
    const actor = this.actorTask(task, queuedRun);
    const { provider, model, effort, roleCanEdit } = this.choice(actor);
    const cli = provider === "codex" ? CODEX_CLI : CLAUDE_CLI;
    const canEdit = actor.canEdit && roleCanEdit && queuedRun.purpose === "work";
    if (canEdit && this.store.getWorkspace(task.id)?.mergeCommit) throw new RunnerError("This task was merged. Create a new task for follow-up work.", 409);
    const role = actor.roleId ? this.store.getRole(actor.roleId) : null;
    // A session belongs to one provider. After a switch the conversation so far goes into the
    // prompt of a new session instead.
    const needsWorktree = canEdit || (!!task.roleId && !!this.store.projectBaseline(project.id) && queuedRun.purpose === "work");
    const movingToWorktree = needsWorktree && !this.store.getWorkspace(task.id);
    const switched = actor.sessionStarted && ((actor.sessionProvider !== null && actor.sessionProvider !== provider) || movingToWorktree);
    const resume = actor.sessionStarted && actor.sessionId !== null && !switched;
    // Claude takes the id we choose; Codex picks one and reports it in its first event.
    const sessionId = resume ? actor.sessionId! : provider === "claude" ? randomUUID() : null;

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
    this.publishTask(
      this.store.updateTask(task.id, {
        status: "running",
        // The reviewer's session and agent are its own; the task keeps the author's.
        ...(reviewing ? {} : { sessionId: sessionId ?? task.sessionId, agentId: agentId ?? task.agentId }),
        ...(movingToWorktree ? { sessionStarted: false, sessionProvider: null } : {}),
        ...(queuedRun.purpose === "work" ? this.stagePatch(task.roleId, task.stage, "start") : {}),
      }),
    );
    this.bus.publish({ type: "run_updated", run });

    const message = this.store.getMessage(run.messageId);
    let prompt = this.store.runPrompt(run.id) ?? message?.text ?? "";
    if (switched) prompt = `${this.conversationSoFar(task.id, run.messageId)}${prompt}`;
    if (!resume && actor.handoff) prompt = `<compact-handoff>\n${actor.handoff}\n</compact-handoff>\n\n${prompt}`;

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
      if (event.kind === "rate_limit") {
        const { kind: _, ...reading } = event;
        this.coordinator?.observe({ provider, ...reading, source: "cli" });
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

    const settle = async (exitError: string | null) => {
      if (settled) return;
      settled = true;
      if (promptFile) fs.rmSync(promptFile, { force: true });
      // The app is shutting down and its database is closing: the next start marks this run
      // interrupted, which is what happened.
      if (this.closed) return;
      let checkpointError: string | null = null;
      if (canEdit) {
        const saved = await this.workspaces.checkpoint(task.id, active.stopRequested ? "Paused work" : "End of agent run");
        checkpointError = saved?.error ?? null;
        if (this.closed) return;
        if (saved)
          record({
            kind: "notice",
            level: saved.error ? "warn" : "info",
            text: saved.error ?? `Saved local checkpoint ${saved.checkpointCommit?.slice(0, 8)} on ${saved.branch}.`,
          });
      }
      let status = active.stopRequested
        ? ("stopped" as const)
        : checkpointError
          ? ("failed" as const)
          : result
            ? result.isError
              ? ("failed" as const)
              : ("succeeded" as const)
            : ("failed" as const);
      let error =
        status === "stopped"
          ? (active.checkpointReason ?? "Stopped by you.")
          : status === "failed"
            ? checkpointError || (result?.isError ? result.text : null) || exitError || stderrTail.trim() || `${cli.name} exited without a result.`
            : null;
      const reply = (result && !result.isError ? result.text : "") || finalText(events);
      if (reply.trim()) this.store.addMessage({ taskId: task.id, role: "assistant", text: reply, runId: run.id });
      // A review's reply is advice about the work, never a handoff of the author's session.
      if (reviewing) {
        // Nothing to carry over.
      } else if (status === "succeeded") {
        const handoff = extractHandoff(reply);
        // A failed handoff preparation keeps the summary the owner may already have written.
        if (handoff || run.purpose !== "handoff") this.store.updateTask(task.id, { handoff, handoffRunId: handoff ? run.id : null });
        if (run.purpose === "handoff" && !handoff)
          record({
            kind: "notice",
            level: "warn",
            text: "No valid handoff was returned. The existing session is unchanged. The reply is in the handoff editor under Context & usage; edit it and choose Use compact handoff.",
          });
      } else {
        this.store.updateTask(task.id, { handoffRunId: null });
      }
      if (canEdit && !checkpointError) {
        const published = await this.github.publish(task.id);
        if (this.closed) return;
        if (published?.publishError) record({ kind: "notice", level: "warn", text: published.publishError });
        else if (published?.pullRequestUrl) record({ kind: "notice", level: "info", text: `Saved on GitHub: ${published.pullRequestUrl}` });
      }
      this.active.delete(run.id);
      if (active.stopRequested) {
        status = "stopped";
        error = active.checkpointReason ?? "Stopped by you.";
      }
      const finished = this.store.finishRun(run.id, {
        status,
        usage: result?.usage,
        costUsd: result?.costUsd,
        error,
        sessionId: result?.sessionId ?? sessionId,
      });
      const limited = status === "failed" ? limitWindowFromError(error) : null;
      if (limited) this.coordinator?.observe({ provider, window: limited, usedPercent: 100, resetsAt: null, rejected: true, source: "error" });
      void this.coordinator?.refreshUsage(false);
      const routingText = [...events.flatMap((e) => (e.kind === "text" ? [e.text] : [])), reply].join("\n");
      const review = run.purpose === "work" ? parseModelReview(routingText) : null;
      const requestedSwitch = status === "succeeded" && review?.action === "switch";
      if (status === "succeeded" && run.purpose === "work" && !reviewNoticed && !review)
        record({ kind: "notice", level: "warn", text: "The agent did not return the required model assessment. Settings were not changed." });
      let waiting = false;
      let step: ReplyOutcome["step"] = null;
      let plan: ReplyOutcome["plan"] = null;
      if (status === "succeeded" && !requestedSwitch && run.purpose === "work" && this.replies && !this.closed) {
        try {
          const outcome = this.replies.afterReply(this.store.getTask(task.id) ?? task, run, reply);
          for (const notice of outcome.notices) record({ kind: "notice", ...notice });
          waiting = outcome.waiting;
          step = outcome.step;
          plan = outcome.plan;
        } catch (error) {
          record({ kind: "notice", level: "warn", text: `The dashboard could not act on this reply: ${(error as Error).message}` });
        }
      }
      if (finished) this.bus.publish({ type: "run_updated", run: finished });
      const checkpoint = this.budgetReason(this.store.getTask(task.id) ?? task);
      if (checkpoint) record({ kind: "notice", level: "warn", text: checkpoint });
      // A role task's step needs review once its agent finished without asking anything; a model
      // switch or handoff continues the same step. A chat just waits for the owner's next message.
      const latest = this.store.getTask(task.id);
      const hasHandoff = latest?.handoffRunId === run.id;
      const reported = status === "succeeded" && task.roleId && run.purpose === "work" && !requestedSwitch;
      const finishedStep = reported && !hasHandoff && !waiting && step?.state !== "partial";
      const next = status === "failed" ? "failed" : waiting ? "waiting" : "idle";
      // The plan lists what is left including the step this reply finishes, so it goes in first.
      if (reported && plan) this.store.replanTask(task.id, plan);
      if (finishedStep) this.store.finishActiveStep(task.id, step?.summary || null, run.id);
      const verdict = reviewing ? this.reviewVerdict(run, status === "succeeded" ? reply : null, record) : {};
      this.publishTask(
        this.store.updateTask(task.id, {
          status: next,
          // Without a step block the old summary would describe an earlier turn.
          ...(reported ? { stepState: step?.state ?? null, stepSummary: step?.summary || null, nextStep: step?.next ?? null } : {}),
          ...(finishedStep ? this.stagePatch(task.roleId, latest?.stage ?? null, "run_succeeded") : {}),
          ...verdict,
        }),
      );
      // The finished step or the review's verdict now shows in the owner's inbox.
      if (finishedStep || reviewing) this.bus.publish({ type: "inbox_changed" });
      if (finishedStep || reviewing) this.automate(task.id, run, record);
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
        text: movingToWorktree
          ? "Starting a fresh session in an isolated task worktree with recent conversation context."
          : `Switched from ${providerName(task.sessionProvider!)} to ${providerName(provider)}: a new session starts with up to 8,000 characters of recent conversation.`,
      });

    const startAgent = async () => {
      let workspace = this.store.getWorkspace(task.id);
      if (needsWorktree) workspace = await this.workspaces.ensure(task.id, project.repoPath, (text) => record({ kind: "notice", level: "warn", text }));
      else if (workspace) await this.workspaces.verify(workspace);
      if (this.closed) return;
      if (active.stopRequested) {
        await settle(null);
        return;
      }
      const repoPath = workspace?.path ?? project.repoPath;
      if (run.purpose === "work") {
        const blocked = await baselineBlocker(this.store, this.store.getTask(task.id)!, repoPath);
        if (blocked) throw new Error(blocked);
      }
      if (workspace) {
        record({ kind: "notice", level: "info", text: `Isolated worktree: ${workspace.path} (${workspace.branch}). The project checkout is unchanged.` });
        prompt +=
          "\n\nMake repository changes only in this task's isolated worktree. Keep its assigned branch. The dashboard saves local WIP commits after runs; do not switch branches, merge into the live checkout, or remove the worktree. Dependencies may need installing in this separate folder. External tools and services may be used when required by the owner's request.";
      }
      let launcher: Launcher;
      let args: string[];
      let input = prompt;
      let cwd = repoPath;
      try {
        const settings = this.store.getSettings();
        launcher =
          this.launcherOverride[provider] ??
          (provider === "codex" ? resolveLauncher(settings.codexPath, process.env, CODEX_CLI) : resolveLauncher(settings.claudePath));
        if (!fs.existsSync(repoPath)) throw new Error(`The project folder does not exist: ${repoPath}`);
        const ctx = role ? this.roleContext(actor, agentId, !resume, run.id, provider, run.purpose !== "work", repoPath) : null;
        if (ctx) {
          promptFile = ctx.file;
          input = `${ctx.preface}\n${prompt}`;
        }
        const fullAccess = canEdit && !task.roleId && run.purpose === "work";
        if (provider === "claude") {
          args = buildArgs({
            model: model!,
            effort,
            sessionId: sessionId!,
            resume,
            canEdit,
            fullAccess,
            allowedTools: ctx?.allowedTools ?? project.allowedTools,
            systemPrompt: systemPrompt(project.name, canEdit, fullAccess),
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
            cwd = path.join(repoPath, ...first!.split("/"));
            fs.mkdirSync(cwd, { recursive: true });
            roots = rest.map((f) => path.join(repoPath, ...f.split("/")));
            const up = first!
              .split("/")
              .map(() => "..")
              .join("/");
            where = `\n\nYour working directory is \`${first}/\` inside the repository; the repository root is \`${up}\`. Only your department's folders are writable.`;
          }
          if (!resume || fullAccess)
            input = `<instructions>\n${ctx ? ctx.systemText : systemPrompt(project.name, canEdit, fullAccess)}${where}\n</instructions>\n\n${input}`;
          args = buildCodexArgs({
            model,
            effort,
            resumeId: resume ? sessionId : null,
            sandbox: fullAccess ? "danger-full-access" : canEdit ? "workspace-write" : "read-only",
            writableRoots: roots,
          });
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
          if (event.kind === "init" && !reviewing) {
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
    };
    void startAgent().catch((error: Error) => {
      if (this.closed) return;
      record({ kind: "error", message: error.message });
      void settle(error.message);
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
