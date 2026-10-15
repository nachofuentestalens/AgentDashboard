import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { finalText, parseClaudeLine, type AgentEvent, type Message, type Run, type StampedEvent, type Task } from "@ad/shared";
import type { Bus } from "./bus.ts";
import { buildArgs, resolveLauncher, systemPrompt, type Launcher } from "./claude.ts";
import type { Store } from "./store.ts";

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ActiveRun {
  runId: string;
  taskId: string;
  child: ChildProcess | null;
  stopRequested: boolean;
}

const STDERR_TAIL_CHARS = 4000;

// Starts Claude Code processes for tasks, records what they stream and settles each run's outcome.
// One run per task at a time; different tasks run side by side.
export class Runner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly runsDir: string;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    dataDir: string,
    // Tests inject a launcher; the app resolves it from Settings on every run.
    private readonly launcherOverride?: Launcher,
  ) {
    this.runsDir = path.join(dataDir, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  isTaskRunning(taskId: string): boolean {
    for (const a of this.active.values()) if (a.taskId === taskId) return true;
    return false;
  }

  activeCount(): number {
    return this.active.size;
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

  // Adds the user's message to the conversation and starts the agent on it.
  send(taskId: string, text: string): { message: Message; run: Run } {
    const task = this.requireIdleTask(taskId);
    const message = this.store.addMessage({ taskId, role: "user", text, runId: null });
    const run = this.start(task, message, text);
    return { message, run };
  }

  // Runs the message of a run that did not finish again, as a new run.
  retry(runId: string): Run {
    const previous = this.store.getRun(runId);
    if (!previous) throw new RunnerError("Run not found.", 404);
    if (previous.status === "running" || previous.status === "succeeded")
      throw new RunnerError("Only a failed, stopped or interrupted run can be retried.", 409);
    const latest = this.store.listRuns(previous.taskId).at(-1);
    if (latest?.id !== previous.id) throw new RunnerError("Only the latest run of a task can be retried.", 409);
    const task = this.requireIdleTask(previous.taskId);
    const message = this.store.getMessage(previous.messageId);
    if (!message) throw new RunnerError("The message of that run no longer exists.", 404);
    // A resumed session may already hold the first attempt's copy of the message.
    const prompt = task.sessionStarted
      ? `(Your previous attempt at this did not finish: ${previous.error ?? previous.status}. Please try again.)\n\n${message.text}`
      : message.text;
    return this.start(task, message, prompt);
  }

  stop(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.stopRequested = true;
    if (active.child?.pid) killTree(active.child);
    return true;
  }

  stopAll(): void {
    for (const runId of this.active.keys()) this.stop(runId);
  }

  private requireIdleTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new RunnerError("Task not found.", 404);
    if (this.isTaskRunning(taskId)) throw new RunnerError("An agent is already working on this task. Wait for it or stop it first.", 409);
    return task;
  }

  private start(task: Task, message: Message, prompt: string): Run {
    const project = this.store.getProject(task.projectId);
    if (!project) throw new RunnerError("Project not found.", 404);

    const resume = task.sessionStarted && task.sessionId !== null;
    const sessionId = resume ? task.sessionId! : randomUUID();
    const model = task.model ?? project.defaultModel;
    const effort = task.effort ?? project.defaultEffort;

    const run = this.store.createRun({ taskId: task.id, messageId: message.id, model, effort, sessionId });
    const active: ActiveRun = { runId: run.id, taskId: task.id, child: null, stopRequested: false };
    this.active.set(run.id, active);
    this.publishTask(this.store.updateTask(task.id, { status: "running", sessionId }));
    this.bus.publish({ type: "run_updated", run });

    let seq = 0;
    const events: AgentEvent[] = [];
    let result: Extract<AgentEvent, { kind: "result" }> | null = null;
    let stderrTail = "";
    let settled = false;

    const record = (event: AgentEvent) => {
      const stamped: StampedEvent = { seq: seq++, at: new Date().toISOString(), event };
      events.push(event);
      // Written before it is published, so a client that loads the file after a push sees it.
      fs.appendFileSync(this.eventsFile(run.id), JSON.stringify(stamped) + "\n");
      this.bus.publish({ type: "run_event", runId: run.id, taskId: task.id, stamped });
    };

    const settle = (exitError: string | null) => {
      if (settled) return;
      settled = true;
      this.active.delete(run.id);
      const status = active.stopRequested ? "stopped" : result ? (result.isError ? "failed" : "succeeded") : "failed";
      const error =
        status === "stopped"
          ? "Stopped by you."
          : status === "failed"
            ? (result?.isError ? result.text : null) || exitError || stderrTail.trim() || "Claude Code exited without a result."
            : null;
      const reply = (result && !result.isError ? result.text : "") || finalText(events);
      if (reply.trim()) this.store.addMessage({ taskId: task.id, role: "assistant", text: reply, runId: run.id });
      const finished = this.store.finishRun(run.id, {
        status,
        usage: result?.usage,
        costUsd: result?.costUsd,
        error,
        sessionId: result?.sessionId ?? sessionId,
      });
      if (finished) this.bus.publish({ type: "run_updated", run: finished });
      this.publishTask(this.store.updateTask(task.id, { status: status === "failed" ? "failed" : "idle" }));
    };

    let launcher: Launcher;
    try {
      launcher = this.launcherOverride ?? resolveLauncher(this.store.getSettings().claudePath);
      if (!fs.existsSync(project.repoPath)) throw new Error(`The project folder does not exist: ${project.repoPath}`);
    } catch (error) {
      record({ kind: "error", message: (error as Error).message });
      settle((error as Error).message);
      return this.store.getRun(run.id)!;
    }

    const args = buildArgs({
      model,
      effort,
      sessionId,
      resume,
      canEdit: task.canEdit,
      allowedTools: project.allowedTools,
      systemPrompt: systemPrompt(project.name, task.canEdit),
    });

    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      cwd: project.repoPath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX so Stop can end the agent's children too.
      detached: process.platform !== "win32",
    });
    active.child = child;

    child.on("error", (error) => {
      record({ kind: "error", message: `Could not start Claude Code (${launcher.display}): ${error.message}` });
      settle(error.message);
    });

    child.stdin?.on("error", () => {
      // The process exited before reading its prompt; the exit handler reports why.
    });
    child.stdin?.end(prompt);

    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      for (const event of parseClaudeLine(line)) {
        if (event.kind === "init" && !task.sessionStarted) {
          this.publishTask(this.store.updateTask(task.id, { sessionStarted: true }));
          task.sessionStarted = true;
        }
        if (event.kind === "result") result = event;
        record(event);
      }
    });

    readline.createInterface({ input: child.stderr! }).on("line", (line) => {
      stderrTail = (stderrTail + line + "\n").slice(-STDERR_TAIL_CHARS);
      if (line.trim()) record({ kind: "stderr", text: line });
    });

    child.on("close", (code, signal) => {
      settle(code === 0 ? null : `Claude Code exited with ${signal ? `signal ${signal}` : `code ${code}`}.`);
    });

    return this.store.getRun(run.id)!;
  }

  private publishTask(task: Task | null) {
    if (task) this.bus.publish({ type: "task_updated", task });
  }
}

function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
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
