import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { commitSummary } from "./commit-summary.ts";
import path from "node:path";
import readline from "node:readline";
import {
  createCodexParser,
  finalText,
  effortFor,
  parseClaudeLine,
  parseReplyBlocks,
  PROVIDERS,
  providerPaused,
  MODEL_PRESETS,
  type ModelOption,
  type ModelHold,
  resolveChoice,
  type AgentEvent,
  type Choice,
  type Effort,
  type Message,
  type Project,
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
import { buildCodexArgs, CODEX_CLI, npmCacheDir } from "./codex.ts";
import { listDocs } from "./docs.ts";
import { HttpError } from "./http.ts";
import { editRules, type EditRules } from "./folders.ts";
import { COMMIT_ID, git, workChanges } from "./git.ts";
import { reviewPrompt, roleSystemPrompt, studioContext } from "./prompts.ts";
import { limitWindowFromError, type RunCoordinator } from "./coordinator.ts";
import { EFFORT_COST_GUESS, plan, type ProviderHold, type QueuedRun, type SchedulerState } from "./scheduler.ts";
import { nextStage, type StageEvent } from "./stages.ts";
import type { AutoContinueState, Store } from "./store.ts";
import { efficiencyInstructions, extractHandoff, HANDOFF_REQUEST, totalTokens } from "./efficiency.ts";
import { modelRoutingInstructions, parseModelReview, validateModelReview } from "./model-routing.ts";
import { Workspaces } from "./workspaces.ts";
import { WorkspaceCleanup } from "./workspace-cleanup.ts";
import { Github } from "./github.ts";
import { baselineBlocker, dependencyBlockedQueue } from "./readiness.ts";

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
  provider: Provider;
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
  restartHeld = false;

  restartBusy(): boolean {
    return this.active.size > 0 || this.workspaceBusy.size > 0 || this.deliveryBusy.size > 0 || this.tickPending;
  }

  prepareRestartHandoff(taskId: string): Run {
    const task = this.store.getTask(taskId);
    if (!this.restartHeld || !task || this.isTaskRunning(taskId)) throw new RunnerError("Task is not ready for a restart handoff.", 409);
    this.checkBudget(task);
    if (task.sessionProvider && task.sessionProvider !== this.choice(task).provider)
      throw new RunnerError("Restore the task's current session provider before preparing its restart handoff.", 409);
    const text = `The owner requested a server restart. Your worktree and provider session will be preserved. Save a restart handoff now so work can continue after restart.\n\n${HANDOFF_REQUEST}`;
    const message = this.store.addMessage({ taskId, role: "user", text, runId: null });
    return this.startNow(task, message, text, "handoff");
  }

  async saveRestartCheckpoint(taskId: string): Promise<void> {
    const saved = await this.workspaces.checkpoint(taskId, "Server restart");
    if (saved?.error) throw new RunnerError(saved.error, 409);
  }

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
  // Suppress repeated delivery failures until the reviewed work or its integration context changes.
  private readonly deliveryFailed = new Map<string, string>();
  // taskId → the last run automate() acted on, so the catch-up pass never repeats it.
  private readonly automatedRuns = new Map<string, string>();
  // taskId:checkpoint:baseline → whether the checkpoint is an ancestor of that baseline.
  private readonly integratedCache = new Map<string, boolean>();
  // commit:path → whether that commit contains the path (commits are immutable).
  private readonly fileCache = new Map<string, boolean>();
  private tickPending = false;
  private tickAgain = false;
  private syncingGithub = false;
  private closed = false;
  private readonly recheck: NodeJS.Timeout;
  replies: ReplyHandler | null = null;
  coordinator: RunCoordinator | null = null;
  // Resolves to a warning when the work landed but a follow-up such as GitHub publication did not.
  deliver: ((projectId: string, taskId: string) => Promise<string | null>) | null = null;

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
    this.recheck = setInterval(() => {
      this.tick();
      void this.syncGithubMerges();
    }, RECHECK_MS);
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
    if (this.restartHeld) throw new RunnerError("Server restart requested; cancel it before starting delivery.", 409);
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

  activeRuns(): { runId: string; taskId: string; agentId: string | null; departmentId: string | null; canEdit: boolean; provider: Provider }[] {
    return [...this.active.values()].map(({ runId, taskId, agentId, departmentId, canEdit, provider }) => ({
      runId,
      taskId,
      agentId,
      departmentId,
      canEdit,
      provider,
    }));
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
  // reviewer: who decided, "owner" or the inbox steward's role id.
  stageAction(taskId: string, action: Exclude<TaskAction, { action: "review" }>, deliveryApproval = false, reviewer = "owner"): Task {
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
        this.store.addTaskReview({ taskId: task.id, runId: null, reviewer, verdict: "changes", findings: [action.text] });
        break;
      case "approve": {
        const open = this.store.openChildTasks(task.id);
        if (open.length && !action.force)
          throw new RunnerError(`Delegated work is still open: ${open.map((t) => t.title).join(", ")}. Approve anyway to continue.`, 409);
        this.store.addTaskReview({ taskId: task.id, runId: null, reviewer, verdict: "approved", findings: [] });
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

  modelHolds(): ModelHold[] {
    return this.store.getStateJson<ModelHold[]>("models.holds") ?? [];
  }

  private modelHeld(provider: Provider, model: string | null): boolean {
    return this.modelHolds().some((hold) => hold.provider === provider && hold.model === (model ?? ""));
  }

  setModelHold(provider: Provider, model: string, paused: boolean): ModelHold[] {
    const holds = this.modelHolds().filter((hold) => hold.provider !== provider || hold.model !== model);
    if (paused) holds.push({ provider, model });
    this.store.setStateJson("models.holds", holds);
    if (paused) {
      const stopped = this.store.getStateJson<string[]>("models.pausedRuns") ?? [];
      for (const run of this.store.runsWithStatus("running")) {
        if (run.provider === provider && run.model === model && this.stop(run.id, "Model paused by you.")) stopped.push(run.id);
      }
      this.store.setStateJson("models.pausedRuns", [...new Set(stopped)]);
    }
    this.tick();
    return holds;
  }

  private async resumeModelRuns(): Promise<void> {
    for (const id of this.store.getStateJson<string[]>("models.pausedRuns") ?? []) {
      const run = this.store.getRun(id);
      if (run && (run.status === "running" || this.modelHeld(run.provider, run.model))) continue;
      const remaining = (this.store.getStateJson<string[]>("models.pausedRuns") ?? []).filter((value) => value !== id);
      this.store.setStateJson("models.pausedRuns", remaining);
      if (!run || this.store.listRuns(run.taskId).at(-1)?.id !== id || !["stopped", "interrupted"].includes(run.status)) continue;
      try {
        await this.retry(id);
      } catch (error) {
        // Budget or workflow changes can require the owner's attention before retrying.
        console.warn("Could not resume paused model run:", (error as Error).message);
      }
    }
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

  previewWorkspaceCleanup(taskId: string) {
    const task = this.store.getTask(taskId);
    return new WorkspaceCleanup(this.store, this.workspaces).preview(taskId, this.isTaskRunning(taskId) || !!(task && this.isProjectBusy(task.projectId)));
  }

  async cleanupWorkspace(taskId: string) {
    const task = this.requireIdleTask(taskId);
    return this.deliveryOperation(task.projectId, async () => {
      this.workspaceBusy.add(taskId);
      try {
        return await new WorkspaceCleanup(this.store, this.workspaces).remove(taskId);
      } catch (error) {
        throw new RunnerError((error as Error).message, 409);
      } finally {
        this.workspaceBusy.delete(taskId);
      }
    });
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

  private automaticMergeReady(task: Task): boolean {
    const w = this.store.getWorkspace(task.id);
    if (!w?.checkpointCommit || w.error || w.publishedCommit !== w.checkpointCommit) return false;
    if (!["idle", "done"].includes(task.status) || task.question || task.nextStep) return false;
    const runs = this.store.listRuns(task.id);
    if (runs.some((r) => r.status === "queued" || r.status === "running")) return false;
    if (task.roleId && (task.stage === "approved" || task.stage === "closed")) return w.approvedCommit === w.checkpointCommit;
    if (task.roleId && (task.stage !== "needs_review" || task.stepState !== "complete")) return false;
    const latest = runs.at(-1);
    if (latest?.purpose === "review" && (latest.status !== "succeeded" || !this.passedOnCheckpoint(task))) return false;
    if (task.roleId && this.store.getProject(task.projectId)?.autoReview && !this.passedOnCheckpoint(task)) return false;
    const ready = this.store.getStateJson<{ runId: string; checkpoint: string }>(`automatic-merge.${task.id}`);
    const work = runs.findLast((r) => r.purpose === "work");
    if (ready) return ready.checkpoint === w.checkpointCommit && ready.runId === work?.id && work.status === "succeeded";
    // Recover older completed PRs only when their checkpoint was saved during the successful run.
    if (!work || work.status !== "succeeded" || !work.endedAt || !w.checkpointAt || w.checkpointAt < work.startedAt || w.checkpointAt > work.endedAt)
      return false;
    const reply = this.store.listMessages(task.id).findLast((m) => m.runId === work.id && m.role === "assistant")?.text;
    if (!reply || !commitSummary(reply) || extractHandoff(reply) || parseModelReview(reply)?.action === "switch") return false;
    if (parseReplyBlocks(reply).some((b) => b.type === "question" || (b.type === "step" && (b.state !== "complete" || !!b.next)))) return false;
    return !task.roleId || task.stepState === "complete";
  }

  async syncGithubMerges(): Promise<void> {
    if (this.closed || this.restartHeld || this.syncingGithub) return;
    this.syncingGithub = true;
    try {
      for (const w of this.store.workspacesAwaitingMerge()) {
        if (this.closed || this.restartHeld) break;
        const task = this.store.getTask(w.taskId);
        if (!task || this.isTaskRunning(w.taskId) || this.isProjectBusy(task.projectId)) continue;
        // Share the publication lock so a pending push cannot overwrite the observed merge.
        this.workspaceBusy.add(w.taskId);
        try {
          if (await this.github.syncMerge(w.taskId)) this.publishTask(this.store.getTask(w.taskId));
          else if (!this.closed && !this.restartHeld && this.automaticMergeReady(task)) {
            const before = this.store.getWorkspace(w.taskId)?.publishError;
            try {
              await this.github.merge(w.taskId);
              if (!this.closed) this.note(w.taskId, "info", "Merged automatically on GitHub after successful checks. The live checkout is unchanged.");
            } catch (error) {
              // Retry on the next pass without spending model tokens or repeating the same notice.
              if (!this.closed && before !== (error as Error).message) this.note(w.taskId, "warn", `Automatic merge waiting: ${(error as Error).message}`);
            }
            if (!this.closed) this.publishTask(this.store.getTask(w.taskId));
          }
        } finally {
          this.workspaceBusy.delete(w.taskId);
        }
      }
    } finally {
      this.syncingGithub = false;
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
    if (this.closed || this.restartHeld) return;
    if (this.tickPending) {
      this.tickAgain = true;
      return;
    }
    this.tickPending = true;
    setImmediate(async () => {
      try {
        if (this.closed || this.restartHeld) return;
        await this.resumeModelRuns();
        await this.deliverReviewed();
        if (this.closed || this.restartHeld) return;
        this.catchUpAutomation();
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

  taskEffort(task: Task): Effort {
    return this.choice(task).effort;
  }

  // The provider a queued or running run uses (a review uses its reviewer's choice).
  runProvider(run: Run): Provider {
    const task = this.store.getTask(run.taskId);
    return task ? this.choice(this.actorTask(task, run)).provider : run.provider;
  }

  // Hands-off delivery: a task whose agent review passed on its current checkpoint is approved and
  // integrated as the owner would, once no agent runs in its project (the baseline must hold still).
  // Queued work in that project waits so the moment comes; a failure hands the task to the owner.
  // Pausing a project holds agent compute, not this: integration starts no runs, so finished work still lands.
  private async deliverReviewed(): Promise<void> {
    this.deliveryPending.clear();
    for (const project of this.store.listProjects()) {
      if (!project.autoApprove || !this.deliver || this.isProjectBusy(project.id) || this.store.deliveryPaused(project.id)) continue;
      const tasks = this.store.listTasks(project.id);
      const key = (task: Task) =>
        JSON.stringify([
          this.store.getWorkspace(task.id)?.checkpointCommit ?? "",
          this.store.projectBaseline(project.id)?.commit ?? "",
          this.store.listTaskReviews(task.id).at(-1)?.id ?? "",
          this.store.openChildTasks(task.id).map((child) => child.id),
          this.store.dependencyBlocker(task),
        ]);
      const ready: Task[] = [];
      for (const t of tasks)
        if (
          t.roleId &&
          t.stage === "needs_review" &&
          t.status === "idle" &&
          !(t.stepState === "done" && t.nextStep) &&
          !this.store.dependencyBlocker(t) &&
          this.deliveryFailed.get(t.id) !== key(t) &&
          this.passedOnCheckpoint(t) &&
          (await this.blockingChildren(t)).length === 0
        )
          ready.push(t);
      ready.push(...(await this.approvedOutsideBaseline(project.id, tasks)).filter((t) => this.deliveryFailed.get(t.id) !== key(t)));
      if (ready.length === 0) continue;
      this.deliveryPending.add(project.id);
      if (tasks.some((t) => this.isTaskRunning(t.id))) continue;
      for (const task of ready) {
        if (this.closed || this.restartHeld) return;
        const attempted = key(task);
        try {
          const warning = await this.deliver(project.id, task.id);
          this.deliveryFailed.delete(task.id);
          this.note(task.id, "info", "Approved and integrated automatically after the passed agent review (project setting).");
          if (warning) this.note(task.id, "warn", warning);
        } catch (error) {
          this.deliveryFailed.set(task.id, attempted);
          this.note(task.id, "warn", `Automatic approval stopped: ${(error as Error).message} Approve or integrate this task yourself.`);
        }
        if (this.closed) return;
      }
      this.deliveryPending.delete(project.id);
    }
  }

  // A plain approval satisfies the dependency graph but leaves the checkpoint outside the baseline,
  // so successors would wait on readiness forever. Integrate those an open task still needs.
  private async approvedOutsideBaseline<T extends Task>(projectId: string, tasks: T[]): Promise<T[]> {
    const baseline = this.store.projectBaseline(projectId);
    if (!baseline) return [];
    const open = tasks.filter((t) => t.stage !== "approved" && t.stage !== "closed");
    const needed = new Set(open.flatMap((t) => t.dependencyIds));
    for (const child of open) {
      const parent = child.parentTaskId ? tasks.find((t) => t.id === child.parentTaskId) : undefined;
      if (parent?.stage === "approved" && (await this.awaitsTaskInputs(child, parent))) needed.add(parent.id);
    }
    const missing: T[] = [];
    for (const task of tasks) {
      const w = this.store.getWorkspace(task.id);
      if (!needed.has(task.id) || task.stage !== "approved" || task.status !== "idle" || !w?.checkpointCommit || w.error) continue;
      if (w.approvedCommit !== w.checkpointCommit || !this.store.taskApproved(task)) continue;
      const key = `${task.id}:${w.checkpointCommit}:${baseline.commit}`;
      let present = this.integratedCache.get(key);
      if (present === undefined) {
        present = (await git(baseline.repoPath, ["merge-base", "--is-ancestor", w.checkpointCommit, baseline.commit])).ok;
        this.integratedCache.set(key, present);
      }
      if (!present) missing.push(task);
    }
    return missing;
  }

  // Delegated work that holds a task's hands-off delivery. Follow-ups such as defect fixes filed
  // from the task's own report cannot start before it is integrated, so waiting on them deadlocks.
  // So does work the agent filed in the step the review passed (re-verifying a fix once it lands,
  // say): the step was complete without it, and its work never reaches this checkpoint anyway.
  private async blockingChildren(task: Task): Promise<Task[]> {
    const step = this.store
      .listRuns(task.id)
      .filter((r) => r.purpose === "work")
      .at(-1);
    const followUps = step ? this.store.tasksFiledSince(task.id, step.startedAt) : new Set<string>();
    const blocking: Task[] = [];
    for (const child of this.store.openChildTasks(task.id)) if (!followUps.has(child.id) && !(await this.awaitsTaskInputs(child, task))) blocking.push(child);
    return blocking;
  }

  // Whether a required input of the child is missing from the baseline but present in the task's checkpoint.
  private async awaitsTaskInputs(child: Task, task: Task): Promise<boolean> {
    const baseline = this.store.projectBaseline(task.projectId);
    const checkpoint = this.store.getWorkspace(task.id)?.checkpointCommit;
    if (!baseline || !checkpoint) return false;
    const has = async (commit: string, file: string) => {
      const key = `${commit}:${file}`;
      let present = this.fileCache.get(key);
      if (present === undefined) {
        present = (await git(baseline.repoPath, ["cat-file", "-e", `${commit}:${file}`])).ok;
        this.fileCache.set(key, present);
      }
      return present;
    };
    for (const file of child.requiredPaths) if (!(await has(baseline.commit, file)) && (await has(checkpoint, file))) return true;
    return false;
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

  // Projects that opt in: staffed roles first resume steps their agents left partial (within the
  // project's automatic continuation limit), then start their top backlog tasks, as the owner's
  // Start would. Each needs a free agent of its role, a free slot for its provider and (for editing
  // work) no other writer in its department. Every pass re-reads the limits, so raising one starts
  // more work.
  private startIdleBacklog(): void {
    const projects = this.store.listProjects().filter((p) => p.startNextWhenIdle && !p.automationPaused);
    if (projects.length === 0) return;
    const limits = this.store.getSettings().maxConcurrentRuns;
    const roleLoad = new Map<string, number>();
    const providerLoad = new Map<Provider, number>();
    const writers = new Set<string>();
    const add = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const run of [...this.store.runsWithStatus("queued"), ...this.store.runsWithStatus("running")]) {
      if (dependencyBlockedQueue(this.store, run)) continue;
      add(providerLoad, run.status === "running" ? run.provider : this.runProvider(run));
      if (!run.roleId) continue;
      add(roleLoad, run.roleId);
      const role = this.store.getRole(run.roleId);
      if (run.purpose === "work" && role?.canEdit && this.store.getTask(run.taskId)?.canEdit) writers.add(role.departmentId);
    }
    const agents = new Map<string, number>();
    for (const a of this.store.listAgents()) if (!a.paused) add(agents, a.roleId);

    // Runs the start when the task fits, and counts it against the role, provider and writer slot.
    // A provider the owner paused in the project has no slot for its work.
    const tryStart = (project: Project, task: Task, begin: () => void) => {
      if (!task.roleId || (roleLoad.get(task.roleId) ?? 0) >= (agents.get(task.roleId) ?? 0) || this.store.dependencyBlocker(task)) return;
      const slots = { ...limits };
      for (const p of project.pausedProviders) slots[p] = 0;
      const current = this.taskProvider(task);
      const provider = task.emergency
        ? current
        : (this.coordinator?.selectAutomaticProvider?.(current, this.taskEffort(task), providerLoad, slots, task.priority) ?? current);
      if ((providerLoad.get(provider) ?? 0) >= slots[provider]) return;
      const role = this.store.getRole(task.roleId);
      const edits = !!role?.canEdit && task.canEdit;
      if (edits && writers.has(role!.departmentId)) return;
      try {
        if (provider !== current) {
          const updated = this.store.updateTask(task.id, { provider, model: null, effort: effortFor(provider, this.taskEffort(task)) });
          if (updated) this.bus.publish({ type: "task_updated", task: updated });
        }
        begin();
        add(roleLoad, task.roleId);
        add(providerLoad, provider);
        if (edits) writers.add(role!.departmentId);
      } catch {
        // A budget or a removed role holds it; the owner sees the task where it was.
      }
    };

    for (const project of projects) {
      if (this.isProjectBusy(project.id) || this.deliveryPending.has(project.id) || this.store.deliveryPaused(project.id)) continue;
      for (const task of this.store.stalledTasks(project.id)) {
        if (task.autoContinues >= project.autoContinueSteps || this.store.autoContinueStopped(task.id) || this.budgetReason(task)) continue;
        const checkpoint = this.store.getWorkspace(task.id)?.checkpointCommit ?? null;
        const last = this.store.getStateJson<AutoContinueState>(`auto-continue.${task.id}`);
        // The last automatic continue ended unfinished again without changing any file: the agent is
        // blocked by something a resume cannot change (a read-only permission, say), so stop retrying.
        // The count stays true (health reports it); the mark lapses once another run follows this one.
        if (last && last.runId === this.store.listRuns(task.id).at(-1)?.id && last.checkpoint === checkpoint) {
          this.store.setStateJson(`auto-continue.${task.id}`, { ...last, stopped: true });
          this.note(task.id, "warn", "The automatic continue changed nothing and the step is still unfinished, so it is not resumed again. Reply to continue.");
          this.bus.publish({ type: "inbox_changed" });
          continue;
        }
        tryStart(project, task, () => {
          this.store.updateTask(task.id, { autoContinues: task.autoContinues + 1 });
          this.note(task.id, "info", `Resuming the unfinished step automatically (${task.autoContinues + 1} of ${project.autoContinueSteps}).`);
          const { run } = this.send(task.id, task.nextStep ? `Continue the unfinished step: ${task.nextStep}` : "Continue the unfinished step.", true);
          this.store.setStateJson(`auto-continue.${task.id}`, { runId: run.id, checkpoint });
        });
      }
      for (const task of this.store.backlogTasks(project.id)) tryStart(project, task, () => this.stageAction(task.id, { action: "start" }));
    }
  }

  private requireIdleTask(taskId: string, deliveryApproval = false): Task {
    if (this.restartHeld) throw new RunnerError("Server restart requested; cancel it before changing task work.", 409);
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
    const readOnly = !task.canEdit || !this.store.getRole(task.roleId!)?.canEdit;
    const work = this.store.listRuns(task.id).findLast((r) => r.purpose === "work");
    const reply = readOnly ? (this.store.listMessages(task.id).findLast((m) => m.runId === work?.id && m.role === "assistant")?.text ?? null) : undefined;
    const prompt = reviewPrompt({ title: task.title, request, summary: task.stepSummary, ...changes, reply });
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

  // automate() only runs as a run ends, so a step or review that ended while its project was paused
  // (an owner-forced run, say) or a restart was held would wait in review forever. Each pass hands
  // such a task's last run to automate() once the project runs again; it is the same run either way.
  private catchUpAutomation(): void {
    for (const project of this.store.listProjects()) {
      if (project.automationPaused || this.isProjectBusy(project.id) || this.deliveryPending.has(project.id)) continue;
      if (!project.autoReview && !project.autoApprove && project.autoContinueSteps === 0) continue;
      for (const task of this.store.listTasks(project.id)) {
        if (!task.roleId || task.status !== "idle" || (task.stage !== "needs_review" && task.stage !== "changes_requested")) continue;
        const last = this.store.listRuns(task.id).at(-1);
        if (!last || last.status !== "succeeded" || this.automatedRuns.get(task.id) === last.id) continue;
        // Only a finished step asks for a review, and a passed review on this checkpoint already covers it.
        if (last.purpose === "work" && (task.stage !== "needs_review" || task.handoffRunId === last.id || this.passedOnCheckpoint(task))) continue;
        this.automate(task.id, last, (event) => {
          if (event.kind === "notice") this.note(task.id, event.level, event.text);
        });
      }
    }
  }

  // The project's opt-in automation after a step or a review ends: ask for a review, continue after
  // a passed one up to the project's step limit, or (hands-off delivery) send the findings back to
  // the author. Approval itself happens in deliverReviewed.
  // ended: the work run that finished a step, or the review run that gave a verdict.
  private automate(taskId: string, ended: Run, record: (event: AgentEvent) => void): boolean {
    // True when an automatic run carries on from this one, so the owner is not alerted yet.
    if (this.restartHeld) return false;
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : null;
    if (!task || !project || project.automationPaused || task.status !== "idle") return false;
    // The inbox steward's triage is not work to review or continue: the steward closes it itself.
    if (this.store.isStewardTask(task.id)) return false;
    this.automatedRuns.set(task.id, ended.id);
    try {
      if (ended.purpose === "review" && task.stage === "changes_requested") {
        const review = this.store.listTaskReviews(task.id).at(-1);
        if (!project.autoApprove || review?.runId !== ended.id || task.autoContinues >= AUTO_FIX_ROUNDS) return false;
        this.store.updateTask(task.id, { autoContinues: task.autoContinues + 1 });
        record({
          kind: "notice",
          level: "info",
          text: `Sending the findings back to the author automatically (${task.autoContinues + 1} of ${AUTO_FIX_ROUNDS}).`,
        });
        this.send(task.id, ["Address these review findings:", ...review.findings.map((f) => `- ${f}`)].join("\n"), true);
        return true;
      }
      if (task.stage !== "needs_review") return false;
      if (ended.purpose === "review") {
        const passed = this.store.listTaskReviews(task.id).at(-1);
        if (passed?.runId !== ended.id || passed.verdict !== "pass") return false;
        if (task.stepState !== "done" || !task.nextStep || task.autoContinues >= project.autoContinueSteps) return false;
        this.store.updateTask(task.id, { autoContinues: task.autoContinues + 1 });
        record({
          kind: "notice",
          level: "info",
          text: `Continuing automatically (${task.autoContinues + 1} of ${project.autoContinueSteps}): ${task.nextStep}`,
        });
        this.send(task.id, `Continue with: ${task.nextStep}`, true);
        return true;
      } else if (project.autoReview) {
        // A reply that changed no files (a status question, say) keeps the earlier passed review.
        if (this.store.getWorkspace(task.id) && this.passedOnCheckpoint(task)) {
          record({ kind: "notice", level: "info", text: "No changes since the passed agent review, so it is not reviewed again." });
          return false;
        }
        record({ kind: "notice", level: "info", text: "Asking for an agent review automatically (project setting)." });
        this.startReview(task.id).catch((error: Error) => {
          record({ kind: "notice", level: "warn", text: `Automatic review did not start: ${error.message}` });
          this.bus.publish({ type: "reply_ready", run: this.store.getRun(ended.id) ?? ended });
        });
        return true;
      }
    } catch (error) {
      record({ kind: "notice", level: "warn", text: `Automation stopped: ${(error as Error).message}` });
    }
    return false;
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
      status: "queued",
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
      const choice = task && this.choice(this.actorTask(task, run));
      if (choice && this.modelHeld(choice.provider, choice.model)) continue;
      const project = task && this.store.getProject(task.projectId);
      if (task && project && run.purpose === "work") {
        // The scheduler holds it for the pause; its Git checks can wait until the project resumes.
        if (choice && providerPaused(project, choice.provider) && !run.forced) {
          readiness.set(run.id, null);
          continue;
        }
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
    if (this.closed || this.restartHeld) return;
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
      if (task) {
        const choice = this.choice(this.actorTask(task, run));
        if (this.modelHeld(choice.provider, choice.model)) {
          this.holdModelRun(run);
          continue;
        }
        if (!task.roleId && !run.roleId) {
          this.launch(run.id, null);
          continue;
        }
      }
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
      pausedProviders: new Map(
        this.store
          .listProjects()
          .filter((p) => p.pausedProviders.length > 0)
          .map((p) => [p.id, new Set(p.pausedProviders)]),
      ),
      active: [...this.active.values()].map((a) => ({ runId: a.runId, departmentId: a.departmentId, canEdit: a.canEdit, provider: a.provider })),
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
    const systemText = roleSystemPrompt({
      projectName: project.name,
      handsOff: project.autoApprove,
      department,
      departments,
      role: readOnly ? { ...role, canEdit: false } : role,
      agentName,
    });
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
      this.bus.publish({ type: "reply_ready", run: failed });
      this.tick();
      return failed;
    }
  }

  private holdModelRun(run: Run): Run {
    const reason = "Model paused by you. Resume it in the sidebar to continue.";
    if (run.waitReason === reason) return run;
    const held = this.store.setWaitReason(run.id, reason)!;
    this.bus.publish({ type: "run_updated", run: held });
    this.publishTask(this.store.updateTask(run.taskId, { status: "queued" }));
    return held;
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
    if (this.modelHeld(provider, model)) return this.holdModelRun(queuedRun);
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
      provider,
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
      const reply = (result && !result.isError ? result.text : "") || finalText(events);
      if (canEdit) {
        const saved = await this.workspaces.checkpoint(
          task.id,
          active.stopRequested ? "Paused work" : "End of agent run",
          !active.stopRequested && result && !result.isError ? commitSummary(reply) : null,
        );
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
      if (run.purpose === "work") {
        const workspace = this.store.getWorkspace(task.id);
        const complete =
          canEdit &&
          status === "succeeded" &&
          !requestedSwitch &&
          !hasHandoff &&
          !waiting &&
          !checkpointError &&
          (task.roleId
            ? step?.state === "complete" && !step.next
            : !parseReplyBlocks(reply).some((b) => b.type === "step" && (b.state !== "complete" || !!b.next)));
        this.store.setStateJson(
          `automatic-merge.${task.id}`,
          complete && workspace?.checkpointCommit ? { runId: run.id, checkpoint: workspace.checkpointCommit } : null,
        );
      }
      // The finished step or the review's verdict now shows in the owner's inbox.
      if (finishedStep || reviewing) this.bus.publish({ type: "inbox_changed" });
      let continued = finishedStep || reviewing ? this.automate(task.id, run, record) : false;
      if (requestedSwitch && !this.restartHeld) {
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
            continued = true;
          } catch (error) {
            record({ kind: "notice", level: "warn", text: `Could not continue after model switch: ${(error as Error).message}` });
          }
        }
      }
      // Desktop alerts announce a reply only when nothing automatic carries on from it.
      if (finished && !continued) this.bus.publish({ type: "reply_ready", run: finished });
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
          "\n\nMake repository changes only in this task's isolated worktree. Keep its assigned branch. The dashboard saves local WIP commits after runs and automatically squash-merges completed tasks' published PRs once GitHub checks pass. Finish implementation and verification before reporting completion; return a context-handoff for unfinished work. Do not switch branches, merge into the live checkout, or remove the worktree. Dependencies may need installing in this separate folder. External tools and services may be used when required by the owner's request.";
        if (canEdit)
          prompt +=
            '\n\nWhen you change repository files, include a fenced commit-summary JSON block in your final reply: {"title":"Describe what this run changed","taskTitle":"Describe what all changes on this task branch achieved"}. Use concise imperative Git titles (maximum 120 characters each), grounded in the actual diff, not the initial request. Inspect the diff against the task base commit ' +
            workspace.baseCommit +
            " for taskTitle so it covers earlier runs too. Describe partial work honestly; do not claim unimplemented outcomes. These titles name the local checkpoint and the draft PR/squash commit; they do not approve or merge anything.";
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
            // In the task's own worktree, installs, builds and tests must write generated output
            // (node_modules, dist, tool caches) outside the department folders, or verification
            // roles can never run the project. Ownership of source files stays a rule, as for Claude.
            if (workspace) {
              roots = [repoPath, ...roots, os.tmpdir(), npmCacheDir()];
              where = `\n\nYour working directory is \`${first}/\` inside the repository; the repository root is \`${up}\`. Edit files only in your department's folders. Elsewhere in this isolated worktree, only generated install, build and test outputs may be written; never change source files there.`;
            }
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

      if (active.stopRequested) {
        await settle(null);
        return;
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
