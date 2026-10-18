import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BaselinePreview, DeliveryView, DeliveryPlanPreview } from "@ad/shared";
import { requiredPaths } from "@ad/shared";
import { checkedGit, gitIdentity, mergeCommit } from "./baseline.ts";
import { git } from "./git.ts";
import { checkpointTitle } from "./commit-summary.ts";
import { HttpError } from "./http.ts";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";

export class Delivery {
  constructor(
    private readonly store: Store,
    private readonly runner: Runner,
    private readonly root: string,
  ) {}

  private project(id: string) {
    const project = this.store.getProject(id);
    if (!project) throw new HttpError("Project not found.", 404);
    const baseline = this.store.projectBaseline(id);
    if (baseline && baseline.repoPath !== project.repoPath)
      throw new HttpError("The baseline belongs to the project's original repository. Restore its path or use a new project.", 409);
    return project;
  }

  async view(projectId: string): Promise<DeliveryView> {
    const project = this.project(projectId);
    const baseline = this.store.projectBaseline(projectId);
    const tasks: DeliveryView["tasks"] = [];
    for (const task of this.store.listTasks(projectId)) {
      const w = this.store.getWorkspace(task.id);
      if (!w?.checkpointCommit || w.error || (task.stepState === "done" && task.nextStep)) continue;
      const approved = this.store.taskApproved(task) && w.approvedCommit === w.checkpointCommit;
      if (!approved && (task.stage !== "needs_review" || task.status !== "idle")) continue;
      tasks.push({
        id: task.id,
        title: task.title,
        checkpoint: w.checkpointCommit,
        integrated: approved && !!baseline && (await git(project.repoPath, ["merge-base", "--is-ancestor", w.checkpointCommit, baseline.commit])).ok,
      });
    }
    const snapshotFiles = baseline
      ? []
      : [
          ...new Set(
            [
              await checkedGit(project.repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
              (await git(project.repoPath, ["diff", "--name-only", "-z", "HEAD"])).stdout,
            ].flatMap((s) => s.split("\0").filter(Boolean)),
          ),
        ].sort();
    return {
      baseline,
      preview: this.store.getStateJson<BaselinePreview>(`baseline-preview.${projectId}`),
      tasks,
      snapshotFiles,
      planPreview: this.store.getStateJson<DeliveryPlanPreview>(`delivery-plan-preview.${projectId}`),
      paused: this.store.deliveryPaused(projectId),
      planImported: !!this.store.getStateJson(`delivery-plan.${projectId}`),
    };
  }

  private async savePreview(projectId: string, kind: BaselinePreview["kind"], baseCommit: string, sourceCommit: string, commit: string, taskId: string | null) {
    const project = this.project(projectId);
    const id = randomUUID();
    const files = await checkedGit(project.repoPath, ["diff", "--stat", baseCommit, commit]);
    const diff = await checkedGit(project.repoPath, ["diff", "--no-ext-diff", "--no-textconv", baseCommit, commit]);
    // Refuse an incomplete preview instead of approving changes the UI cannot display.
    if (diff.length > 500_000) throw new HttpError("The preview is too large. Prepare a smaller baseline or integrate a smaller task.", 409);
    await checkedGit(project.repoPath, ["update-ref", `refs/agent-dashboard/previews/${id}`, commit]);
    const preview: BaselinePreview = {
      id,
      projectId,
      repoPath: project.repoPath,
      kind,
      baseCommit,
      sourceCommit,
      commit,
      taskId,
      approvesTask: !!taskId && this.store.getTask(taskId)?.stage === "needs_review",
      expectedBaseline: this.store.projectBaseline(projectId)?.commit ?? null,
      files,
      diff,
      createdAt: new Date().toISOString(),
    };
    this.store.setStateJson(`baseline-preview.${projectId}`, preview);
    return preview;
  }

  snapshot(projectId: string, paths: string[]) {
    return this.runner.deliveryOperation(projectId, async () => {
      const project = this.project(projectId);
      if (this.store.projectBaseline(projectId))
        throw new HttpError("This project already has a managed baseline. Integrate approved tasks to advance it.", 409);
      requiredPaths.parse(paths);
      for (const file of paths) {
        if (file.split("/").some((part) => part.toLowerCase() === ".git")) throw new HttpError("Git metadata cannot be included in a baseline.", 400);
        // Do not follow a directory link out of the selected repository.
        let current = project.repoPath;
        for (const part of file.split("/")) {
          current = path.join(current, part);
          if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
            throw new HttpError("Select regular repository files, not symbolic links.", 400);
        }
        if (fs.existsSync(current) && !fs.statSync(current).isFile())
          throw new HttpError("Select individual files so every baseline addition is explicit.", 400);
      }
      const base = await checkedGit(project.repoPath, ["rev-parse", "--verify", "HEAD"]);
      fs.mkdirSync(this.root, { recursive: true });
      const index = path.join(this.root, `${randomUUID()}.index`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await checkedGit(project.repoPath, ["read-tree", base], undefined, env);
        if (paths.length) await checkedGit(project.repoPath, ["--literal-pathspecs", "add", "-A", "--", ...paths], undefined, env);
        const tree = await checkedGit(project.repoPath, ["write-tree"], undefined, env);
        const commit = await checkedGit(project.repoPath, [...gitIdentity, "commit-tree", tree, "-p", base], "Reviewed project baseline candidate\n");
        return await this.savePreview(projectId, "snapshot", base, base, commit, null);
      } finally {
        fs.rmSync(index, { force: true });
        fs.rmSync(`${index}.lock`, { force: true });
      }
    });
  }

  integrate(projectId: string, taskId: string) {
    return this.runner.deliveryOperation(projectId, async () => {
      const project = this.project(projectId);
      const baseline = this.store.projectBaseline(projectId);
      if (!baseline) throw new HttpError("Approve an initial project baseline first.", 409);
      const task = this.store.getTask(taskId);
      const w = this.store.getWorkspace(taskId);
      if (!task || task.projectId !== projectId || !w) throw new HttpError("Choose a task workspace in this project.", 400);
      const ready = task.stage === "needs_review" && task.status === "idle";
      const approved = this.store.taskApproved(task) && w.approvedCommit === w.checkpointCommit;
      if ((!ready && !approved) || !w.checkpointCommit || w.error || (task.stepState === "done" && task.nextStep))
        throw new HttpError("Finish and checkpoint the task before reviewing its integration.", 409);
      await this.runner.verifyWorkspaceSnapshot(taskId);
      const blocked = this.store.dependencyBlocker(task);
      if (blocked) throw new HttpError(blocked, 409);
      const message = await checkedGit(w.path, ["show", "-s", "--format=%B", w.checkpointCommit]);
      const commit = await mergeCommit(project.repoPath, baseline.commit, w.checkpointCommit, `${checkpointTitle(message)}\n`);
      return this.savePreview(projectId, "integration", baseline.commit, w.checkpointCommit, commit, taskId);
    });
  }

  // Hands-off delivery: the integration preview and its approval the owner would otherwise do by hand.
  // Without a managed baseline or a task worktree there is nothing to integrate, so it only approves.
  async autoApprove(projectId: string, taskId: string): Promise<void> {
    if (!this.store.projectBaseline(projectId) || !this.store.getWorkspace(taskId)) {
      this.runner.stageAction(taskId, { action: "approve" });
      return;
    }
    const preview = await this.integrate(projectId, taskId);
    await this.approve(projectId, preview.id);
  }

  approve(projectId: string, previewId: string) {
    return this.runner.deliveryOperation(projectId, async () => {
      const project = this.project(projectId);
      const preview = this.store.getStateJson<BaselinePreview>(`baseline-preview.${projectId}`);
      if (!preview || preview.id !== previewId || preview.repoPath !== project.repoPath) throw new HttpError("Prepare a fresh preview before approving.", 409);
      if ((this.store.projectBaseline(projectId)?.commit ?? null) !== preview.expectedBaseline)
        throw new HttpError("The baseline changed. Prepare a fresh preview.", 409);
      if (preview.kind === "snapshot" && (await checkedGit(project.repoPath, ["rev-parse", "HEAD"])) !== preview.sourceCommit)
        throw new HttpError("The source branch changed. Prepare a fresh snapshot.", 409);
      if (preview.taskId) {
        const task = this.store.getTask(preview.taskId);
        const w = this.store.getWorkspace(preview.taskId);
        const canApprove = preview.approvesTask && task?.stage === "needs_review" && task.status === "idle";
        const approved = task && this.store.taskApproved(task) && w?.approvedCommit === preview.sourceCommit;
        if (!task || (!canApprove && !approved) || w?.checkpointCommit !== preview.sourceCommit || w.error || (task.stepState === "done" && task.nextStep))
          throw new HttpError("Task approval changed. Prepare a fresh integration preview.", 409);
        const blocker = this.store.dependencyBlocker(task);
        if (blocker) throw new HttpError(blocker, 409);
        await this.runner.verifyWorkspaceSnapshot(task.id);
      }
      await checkedGit(project.repoPath, ["cat-file", "-e", `${preview.commit}^{commit}`]);
      if (preview.approvesTask && preview.taskId && this.store.getTask(preview.taskId)?.stage === "needs_review")
        this.runner.stageAction(preview.taskId, { action: "approve" }, true);
      const baseline = { repoPath: project.repoPath, commit: preview.commit, approvedAt: new Date().toISOString() };
      this.store.setProjectBaseline(projectId, baseline);
      this.store.setStateJson(`baseline-preview.${projectId}`, null);
      return baseline;
    });
  }
}
