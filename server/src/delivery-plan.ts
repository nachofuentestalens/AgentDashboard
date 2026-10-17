import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { requiredPaths, type DeliveryPlanPreview } from "@ad/shared";
import { checkedGit } from "./baseline.ts";
import { git } from "./git.ts";
import { HttpError } from "./http.ts";
import { baselineBlocker } from "./readiness.ts";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";

const registry = z.object({
  projectId: z.string(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        role: z.string(),
        dependsOn: z.array(z.string()).max(100),
        inputs: requiredPaths,
        deliverables: requiredPaths,
        report: z.string().max(300),
      }),
    )
    .min(1)
    .max(200),
});
const mapping = z.object({ projectId: z.string(), tasks: z.record(z.string(), z.string().uuid()) });

export class DeliveryPlan {
  constructor(
    private readonly store: Store,
    private readonly runner: Runner,
  ) {}

  private fingerprint(projectId: string) {
    return createHash("sha256")
      .update(JSON.stringify({ tasks: this.store.listTasks(projectId), roles: this.store.listRoles(projectId) }))
      .digest("hex");
  }

  preview(projectId: string) {
    return this.runner.deliveryOperation(projectId, async () => {
      const project = this.store.getProject(projectId);
      const baseline = this.store.projectBaseline(projectId);
      if (!project || !baseline || project.repoPath !== baseline.repoPath)
        throw new HttpError("Approve a baseline for this repository before importing its milestone plan.", 409);
      let plan: z.infer<typeof registry>, state: z.infer<typeof mapping>;
      try {
        plan = registry.parse(JSON.parse(await checkedGit(project.repoPath, ["show", `${baseline.commit}:planning/milestone.json`])));
        state = mapping.parse(JSON.parse(await checkedGit(project.repoPath, ["show", `${baseline.commit}:planning/dashboard-state.json`])));
      } catch (error) {
        throw new HttpError(`Cannot import the committed milestone registry and dashboard mapping: ${(error as Error).message}`, 400);
      }
      if (plan.projectId !== projectId || state.projectId !== projectId)
        throw new HttpError("The milestone registry and mapping must belong to this project.", 400);
      const specs = new Map(plan.tasks.map((t) => [t.id, t]));
      if (specs.size !== plan.tasks.length) throw new HttpError("Duplicate milestone task IDs.", 400);
      const entries: DeliveryPlanPreview["entries"] = [];
      for (const spec of plan.tasks) {
        const taskId = state.tasks[spec.id];
        const task = taskId ? this.store.getTask(taskId) : null;
        if (!task || task.projectId !== projectId || !task.stage || this.store.getRole(task.roleId!)?.name !== spec.role)
          throw new HttpError(`The mapping for ${spec.id} must identify its existing assigned role task.`, 400);
        if (task.status === "queued" || task.status === "running" || task.stage === "in_review")
          throw new HttpError("Stop queued work and wait for reviews before importing the plan.", 409);
        if (new Set(spec.dependsOn).size !== spec.dependsOn.length || spec.dependsOn.some((id) => !specs.has(id) || !state.tasks[id]))
          throw new HttpError(`Invalid prerequisites for ${spec.id}.`, 400);
        const inputs = requiredPaths.parse([...new Set(["AGENTS.md", ...spec.inputs, ...spec.dependsOn.flatMap((id) => specs.get(id)!.deliverables)])]);
        const missingOutputs: string[] = [];
        for (const file of spec.deliverables)
          if (!(await git(project.repoPath, ["cat-file", "-e", `${baseline.commit}:${file}`])).ok) missingOutputs.push(file);
        const completed = task.stage === "closed" || task.stage === "approved";
        const toStage = completed ? (missingOutputs.length ? "backlog" : "needs_review") : task.stage === "in_progress" ? "backlog" : task.stage;
        entries.push({
          taskId: task.id,
          milestoneId: spec.id,
          title: task.title,
          dependencyIds: spec.dependsOn.map((id) => state.tasks[id]!),
          requiredPaths: inputs,
          fromStage: task.stage,
          toStage,
          report: spec.report,
          missingOutputs,
        });
      }
      this.store.validateTaskPlan(projectId, entries);
      const preview: DeliveryPlanPreview = { id: randomUUID(), projectId, baseline: baseline.commit, fingerprint: this.fingerprint(projectId), entries };
      this.store.setStateJson(`delivery-plan-preview.${projectId}`, preview);
      return preview;
    });
  }

  approve(projectId: string, previewId: string) {
    return this.runner.deliveryOperation(projectId, async () => {
      const preview = this.store.getStateJson<DeliveryPlanPreview>(`delivery-plan-preview.${projectId}`);
      const baseline = this.store.projectBaseline(projectId);
      if (
        !preview ||
        preview.id !== previewId ||
        baseline?.commit !== preview.baseline ||
        baseline.repoPath !== this.store.getProject(projectId)?.repoPath ||
        this.fingerprint(projectId) !== preview.fingerprint
      )
        throw new HttpError("The baseline or tasks changed. Prepare a fresh plan preview.", 409);
      this.store.applyTaskPlan(preview);
      return preview;
    });
  }

  enable(projectId: string) {
    return this.runner.deliveryOperation(projectId, async () => {
      const baseline = this.store.projectBaseline(projectId);
      const project = this.store.getProject(projectId);
      const plan = this.store.getStateJson<DeliveryPlanPreview>(`delivery-plan.${projectId}`);
      if (!project || !baseline || baseline.repoPath !== project.repoPath || !plan)
        throw new HttpError("Approve a baseline and import the milestone plan before enabling delivery automation.", 409);
      const tasks = plan.entries.map((e) => this.store.getTask(e.taskId));
      if (tasks.some((t) => !t)) throw new HttpError("A planned task was deleted. Repair and import the plan again.", 409);
      const ready = tasks.filter((t) => t!.stage === "backlog" && !this.store.dependencyBlocker(t!));
      if (!ready.length && tasks.some((t) => !this.store.taskApproved(t!)))
        throw new HttpError("No backlog task is ready. Review the recovered outputs and approve their prerequisites first.", 409);
      for (const task of ready) {
        const reason = await baselineBlocker(this.store, task!, project.repoPath, baseline.commit);
        if (reason) throw new HttpError(`${task!.title}: ${reason}`, 409);
      }
      this.store.updateProject(projectId, { autoReview: true, autoContinueSteps: 0, startNextWhenIdle: true });
      this.store.setStateJson(`delivery-paused.${projectId}`, false);
      return { enabled: true };
    });
  }
}
