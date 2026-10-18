import fs from "node:fs";
import path from "node:path";
import type { RestartStatus } from "@ad/shared";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";
import { HttpError } from "./http.ts";

// A durable barrier: a crash during preparation must not silently release queued work.
export class ServerRestart {
  private state: RestartStatus;
  private readonly file: string;
  private readonly timer: NodeJS.Timeout;
  private pumping = false;
  private closed = false;

  constructor(
    private runner: Runner,
    private store: Store,
    dataDir: string,
    supported: boolean,
  ) {
    this.file = path.join(dataDir, "restart.json");
    this.state = { supported, phase: "idle", participants: [], error: null };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as RestartStatus;
      if (saved.phase !== "restarting") this.state = { ...saved, supported };
    }
    runner.restartHeld = this.state.phase !== "idle";
    this.persist();
    this.timer = setInterval(() => void this.pump(), 250);
    this.timer.unref();
  }

  status(): RestartStatus {
    return structuredClone(this.state);
  }

  request(): RestartStatus {
    if (this.pumping) throw new HttpError("Wait for the current save operation to finish.", 409);
    if (!this.state.supported) throw new HttpError("Start the server with pnpm start or pnpm dev to enable restart.", 409);
    if (this.state.phase === "restarting") throw new HttpError("Server is restarting.", 409);
    if (this.state.phase === "idle") {
      this.runner.restartHeld = true;
      this.state.participants = this.runner.activeRuns().map((run) => ({
        taskId: run.taskId,
        title: this.store.getTask(run.taskId)?.title ?? run.taskId,
        runId: run.runId,
        handoffRunId: null,
        state: "working",
        error: null,
      }));
    } else {
      for (const p of this.state.participants)
        if (p.state === "error") {
          p.state = "working";
          p.handoffRunId = null;
          p.error = null;
        }
    }
    this.state.phase = "preparing";
    this.state.error = null;
    this.persist();
    return this.status();
  }

  cancel(): RestartStatus {
    if (this.pumping || this.state.phase === "restarting") throw new HttpError("Wait for the current save operation to finish.", 409);
    this.state = { supported: this.state.supported, phase: "idle", participants: [], error: null };
    this.persist();
    this.runner.restartHeld = false;
    this.runner.tick();
    return this.status();
  }

  async confirm(): Promise<void> {
    if (!this.state.supported) throw new HttpError("Restart requires the supervising launcher.", 409);
    if (this.state.phase !== "ready" || this.runner.restartBusy() || this.pumping) throw new HttpError("Agents have not all saved their work yet.", 409);
    this.pumping = true;
    try {
      // Recheck disk state at confirmation; external edits can invalidate a ready checkpoint.
      for (const p of this.state.participants) if (this.store.getWorkspace(p.taskId)) await this.runner.verifyWorkspaceSnapshot(p.taskId);
      this.state.phase = "restarting";
      this.persist();
    } catch (error) {
      this.state.phase = "preparing";
      this.state.error = (error as Error).message;
      for (const p of this.state.participants) {
        p.state = "error";
        p.error = this.state.error;
      }
      this.persist();
      throw error;
    } finally {
      this.pumping = false;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private persist(): void {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping || this.state.phase !== "preparing" || this.runner.restartBusy()) return;
    this.pumping = true;
    try {
      for (const p of this.state.participants) {
        if (p.state === "ready" || p.state === "error") continue;
        try {
          if (!p.handoffRunId) {
            await this.runner.saveRestartCheckpoint(p.taskId);
            if (this.closed) return;
            p.handoffRunId = this.runner.prepareRestartHandoff(p.taskId).id;
            p.state = "saving";
            this.persist();
            return;
          }
          const run = this.store.getRun(p.handoffRunId);
          const task = this.store.getTask(p.taskId);
          if (run?.status !== "succeeded" || task?.handoffRunId !== run.id || !task.handoff)
            throw new Error(run?.error || "Agent did not save a valid restart handoff. Retry preparation or cancel to resolve it.");
          await this.runner.saveRestartCheckpoint(p.taskId);
          if (this.closed) return;
          p.state = "ready";
        } catch (error) {
          p.state = "error";
          p.error = (error as Error).message;
        }
      }
      if (this.state.participants.every((p) => p.state === "ready")) this.state.phase = "ready";
      this.persist();
    } catch (error) {
      // A disk failure must leave the barrier closed, not an unhandled timer rejection.
      this.state.phase = "preparing";
      this.state.error = (error as Error).message;
    } finally {
      this.pumping = false;
    }
  }
}
