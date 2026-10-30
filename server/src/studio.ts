import {
  effortFor,
  inboxKeys,
  MAX_DELEGATION_DEPTH,
  MAX_PRIORITY,
  parseReplyBlocks,
  type Agent,
  type AgentView,
  type Compute,
  type ComputeRun,
  type Effort,
  type Inbox,
  type Proposal,
  type Provider,
  type Run,
  type StewardItem,
  type StewardItemKind,
  isHealthKind,
  type Studio as StudioView,
  type Task,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import { readDocText, safeDocPath, saveDocs } from "./docs.ts";
import { HttpError } from "./http.ts";
import { DECISIONS_DOC } from "./folders.ts";
import type { Notice, ReplyHandler, ReplyOutcome, Runner } from "./runner.ts";
import { isBlockedReason, isHeldReason } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { STUDIO_TEMPLATE } from "./template.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const sinceDays = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

export interface NewStudioTask {
  dependencyIds?: string[];
  requiredPaths?: string[];
  projectId: string;
  roleId: string | null;
  title: string;
  message?: string;
  canEdit?: boolean;
  provider?: Provider | null;
  model?: string | null;
  effort?: Effort | null;
  priority?: number;
  emergency?: boolean;
  parentTaskId?: string | null;
  depth?: number;
  createdByRoleId?: string | null;
}

// The studio around the runner: its structure (departments, roles, agents), what agents ask for
// at the end of a reply, and the owner's inbox. State changes happen here and in the runner, never
// in the browser.
export class Studio implements ReplyHandler {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly runner: Runner,
  ) {
    runner.replies = this;
  }

  private changed(projectId: string) {
    this.bus.publish({ type: "studio_changed", projectId });
    // Roles, agents and budgets all feed the scheduler.
    this.runner.tick();
  }

  // ---- structure

  view(projectId: string): StudioView {
    const departments = this.store.listDepartments(projectId);
    const roles = this.store.listRoles(projectId);
    const agents = this.store.listAgents(projectId);
    const active = this.runner.activeRuns();
    const day = sinceDays(1);
    const deptSpend = this.store.departmentSpendSince(day);
    const deptSpendWeek = this.store.departmentSpendSince(sinceDays(7));
    const roleSpend = this.store.roleSpendSince(day);
    const agentSpend = this.store.agentSpendSince(day);
    const costs = this.store.costByRoleEffort();
    const queued = this.store.runsWithStatus("queued");
    const waiting = this.store.waitingTasks();

    const agentView = (agent: Agent): AgentView => {
      const run = active.find((a) => a.agentId === agent.id);
      const task = run ? this.store.getTask(run.taskId) : (waiting.find((t) => t.agentId === agent.id) ?? null);
      const status = agent.paused ? "paused" : run ? "running" : task ? "waiting" : "idle";
      return {
        ...agent,
        status,
        runId: run?.runId ?? null,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null,
        spend24h: agentSpend.get(agent.id) ?? 0,
      };
    };

    return {
      projectId,
      departments: departments.map((d) => ({
        ...d,
        roles: roles
          .filter((r) => r.departmentId === d.id)
          .map((r) => ({
            ...r,
            agents: agents.filter((a) => a.roleId === r.id).map(agentView),
            queued: queued.filter((q) => q.roleId === r.id).length,
            spend24h: roleSpend.get(r.id) ?? 0,
            costByEffort: costs.get(r.id) ?? {},
          })),
        spend24h: deptSpend.get(d.id) ?? 0,
        spend7d: deptSpendWeek.get(d.id) ?? 0,
        writerRunId: active.find((a) => a.departmentId === d.id && a.canEdit)?.runId ?? null,
      })),
      emergencies: this.store.openEmergencies(projectId).map((t) => ({ taskId: t.id, title: t.title })),
    };
  }

  applyTemplate(projectId: string): StudioView {
    if (this.store.listDepartments(projectId).length > 0) throw new HttpError("This project already has departments. Remove them first to start over.", 409);
    // The template's models are Claude's. On a Codex project its roles keep their efforts and use
    // Codex's default model.
    const provider = this.store.getProject(projectId)?.defaultProvider ?? "claude";
    for (const t of STUDIO_TEMPLATE) {
      const dept = this.store.createDepartment({
        projectId,
        name: t.name,
        color: t.color,
        weight: t.weight,
        dailyBudgetUsd: null,
        folders: t.folders,
        autonomy: t.autonomy,
      });
      for (const r of t.roles) {
        const role = this.store.createRole({
          projectId,
          departmentId: dept.id,
          name: r.name,
          brief: r.brief,
          provider,
          model: provider === "claude" ? r.model : null,
          effort: effortFor(provider, r.effort),
          canEdit: r.canEdit,
          allowedTools: r.allowedTools,
          contextDocs: r.contextDocs,
        });
        for (let i = 0; i < r.seats; i++) this.hire(role.id);
      }
    }
    this.changed(projectId);
    return this.view(projectId);
  }

  hire(roleId: string, name?: string): Agent {
    const role = this.store.getRole(roleId);
    if (!role) throw new HttpError("Role not found.", 404);
    const n = this.store.countAgentsEver(roleId) + 1;
    const agent = this.store.createAgent({ roleId, name: name || (n === 1 ? role.name : `${role.name} ${n}`) });
    this.changed(role.projectId);
    return agent;
  }

  removeAgent(agentId: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new HttpError("Agent not found.", 404);
    if (this.runner.activeRuns().some((a) => a.agentId === agentId)) throw new HttpError("This agent is working. Stop its run first.", 409);
    const role = this.store.getRole(agent.roleId);
    this.store.removeAgent(agentId);
    if (role) this.changed(role.projectId);
  }

  deleteRole(roleId: string): void {
    const role = this.store.getRole(roleId);
    if (!role) throw new HttpError("Role not found.", 404);
    const busy = this.runner.activeRuns().some((a) => this.store.getTask(a.taskId)?.roleId === roleId);
    if (busy || this.store.runsWithStatus("queued").some((r) => r.roleId === roleId))
      throw new HttpError("This role has running or queued work. Stop it first.", 409);
    this.store.deleteRole(roleId);
    this.changed(role.projectId);
  }

  deleteDepartment(departmentId: string): void {
    const dept = this.store.getDepartment(departmentId);
    if (!dept) throw new HttpError("Department not found.", 404);
    if (this.store.listRoles(dept.projectId).some((r) => r.departmentId === departmentId))
      throw new HttpError("Move or remove this department's roles first.", 409);
    this.store.deleteDepartment(departmentId);
    this.changed(dept.projectId);
  }

  // ---- tasks

  createTask(input: NewStudioTask): Task {
    const role = input.roleId ? this.store.getRole(input.roleId) : null;
    if (input.roleId && (!role || role.projectId !== input.projectId)) throw new HttpError("That role is not part of this project.", 400);
    const task = this.store.createTask({
      projectId: input.projectId,
      dependencyIds: input.dependencyIds,
      requiredPaths: input.requiredPaths,
      title: input.title,
      canEdit: role ? role.canEdit && input.canEdit !== false : (input.canEdit ?? true),
      provider: input.provider ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      roleId: role?.id ?? null,
      priority: input.priority,
      // Only a role's task can hold up the project; a plain chat runs anyway.
      emergency: role ? (input.emergency ?? false) : false,
      parentTaskId: input.parentTaskId ?? null,
      depth: input.depth ?? 0,
      createdByRoleId: input.createdByRoleId ?? null,
    });
    this.bus.publish({ type: "task_updated", task });
    if (input.message?.trim()) this.runner.send(task.id, input.message.trim());
    // An emergency freezes the project's other work at once.
    if (task.emergency) this.changed(task.projectId);
    return this.store.getTask(task.id)!;
  }

  // ---- what agents ask for at the end of a reply

  afterReply(task: Task, run: Run, reply: string): ReplyOutcome {
    const blocks = parseReplyBlocks(reply);
    if (blocks.length === 0) return { notices: [], waiting: false, step: null, plan: null };
    const project = this.store.getProject(task.projectId);
    if (!project) return { notices: [], waiting: false, step: null, plan: null };
    const role = task.roleId ? this.store.getRole(task.roleId) : null;
    const dept = role ? this.store.getDepartment(role.departmentId) : null;
    const notices: Notice[] = [];
    const questions: string[] = [];
    let step: ReplyOutcome["step"] = null;
    let plan: ReplyOutcome["plan"] = null;
    let inbox = false;

    for (const block of blocks) {
      if (block.type === "invalid") {
        notices.push({ level: "warn", text: `Ignored a \`${block.lang}\` block: ${block.error}` });
      } else if (block.type === "step") {
        // Plain chats have no stage, so their step blocks mean nothing. The last block wins.
        if (task.roleId) step = block;
      } else if (block.type === "plan") {
        if (task.roleId) plan = block.steps;
      } else if (block.type === "review") {
        // Only a review run's verdict counts, and the runner reads that itself.
      } else if (block.type === "decision") {
        // Recorded now and acted on by the steward once its run has ended (steward.ts).
        if (!this.store.isStewardTask(task.id))
          notices.push({ level: "warn", text: "Ignored a decision block: only the inbox steward's triage tasks decide inbox items." });
        else if (this.store.recordStewardDecision(task.id, block.item, block)) notices.push({ level: "info", text: `Decided ${block.item}: ${block.action}.` });
        else notices.push({ level: "warn", text: `Ignored a decision for ${block.item}: it is not an open item of this triage.` });
      } else if (block.type === "question") {
        questions.push(block.question);
      } else if (block.type === "proposal") {
        try {
          const docPath = safeDocPath(project.repoPath, block.docPath);
          if (docPath === DECISIONS_DOC) throw new Error("the decision log is written by the dashboard only.");
          this.store.createProposal({
            projectId: project.id,
            taskId: task.id,
            runId: run.id,
            roleName: role?.name ?? null,
            docPath,
            rationale: block.rationale,
            body: block.body,
          });
          inbox = true;
          notices.push({ level: "info", text: `Proposal for ${docPath} sent to the owner's inbox.` });
        } catch (error) {
          notices.push({ level: "warn", text: `Ignored a proposal: ${(error as Error).message}` });
        }
      } else {
        try {
          this.store.validateDependencies(project.id, null, block.dependencyIds ?? []);
        } catch (error) {
          notices.push({ level: "warn", text: "Ignored task: " + (error as Error).message });
          continue;
        }
        const target = this.store.findRoleByName(project.id, block.role);
        const depth = task.depth + 1;
        const reason =
          this.runner.budgetReason(task) ??
          (!target
            ? `there is no role called "${block.role}".`
            : depth > MAX_DELEGATION_DEPTH
              ? `it would be ${depth} levels of delegation deep; the limit is ${MAX_DELEGATION_DEPTH}.`
              : !dept
                ? "tasks suggested in a chat wait for your approval."
                : dept.autonomy === "ask"
                  ? `${dept.name} asks before creating tasks.`
                  : null);
        const label = `"${block.title}" for ${target?.name ?? block.role} (priority ${block.priority}/${MAX_PRIORITY}${block.emergency ? ", emergency" : ""})`;
        const base = {
          projectId: project.id,
          fromTaskId: task.id,
          fromRoleName: role?.name ?? null,
          toRoleName: target?.name ?? block.role,
          roleId: target?.id ?? null,
          dependencyIds: block.dependencyIds,
          requiredPaths: block.requiredPaths,
          title: block.title,
          prompt: block.prompt,
          priority: block.priority,
          emergency: block.emergency,
          depth,
        };
        if (reason) {
          this.store.createHandoff({ ...base, reason: `Waiting for you: ${reason}`, status: "pending", createdTaskId: null });
          inbox = true;
          notices.push({ level: "info", text: `Task ${label} waits for your approval in the Inbox: ${reason}` });
        } else {
          const created = this.createTask({
            projectId: project.id,
            roleId: target!.id,
            dependencyIds: block.dependencyIds,
            requiredPaths: block.requiredPaths,
            title: block.title,
            message: block.prompt,
            priority: block.priority,
            emergency: block.emergency,
            parentTaskId: task.id,
            depth,
            createdByRoleId: role?.id ?? null,
          });
          this.store.createHandoff({ ...base, reason: null, status: "created", createdTaskId: created.id });
          notices.push({ level: "info", text: `Created task ${label}.` });
        }
      }
    }

    if (questions.length) {
      this.store.updateTask(task.id, { question: questions.join("\n\n") });
      inbox = true;
      notices.push({ level: "info", text: "Asked you a question. Answer it in the Inbox or reply below; the task waits until then." });
    }
    if (inbox) this.bus.publish({ type: "inbox_changed" });
    return { notices, waiting: questions.length > 0, step, plan };
  }

  // ---- the owner's inbox

  // Every waiting item, before the inbox steward takes its share.
  allInbox(): Omit<Inbox, "steward" | "stewardNotes" | "alerts" | "count"> {
    const projects = new Map(this.store.listProjects().map((p) => [p.id, p]));
    const name = (id: string) => projects.get(id)?.name ?? "?";
    const proposals = this.store.pendingProposals().map((p) => {
      const project = projects.get(p.projectId);
      return { ...p, projectName: name(p.projectId), current: project ? readDocText(project.repoPath, p.docPath) : null };
    });
    const handoffs = this.store.pendingHandoffs().map((h) => ({ ...h, projectName: name(h.projectId) }));
    const questions = this.store.waitingTasks().map((task) => ({ task, projectName: name(task.projectId) }));
    const queued = (match: (reason: string) => boolean) =>
      this.store
        .runsWithStatus("queued")
        .filter((run) => run.waitReason && match(run.waitReason))
        .flatMap((run) => {
          const task = this.store.getTask(run.taskId);
          return task ? [{ run, task, projectName: name(task.projectId) }] : [];
        });
    const held = queued(isHeldReason).filter((h) => !h.run.forced);
    // Run anyway cannot override a baseline wait, so forced runs still need the owner.
    const blocked = queued(isBlockedReason);
    const inStage = (stage: "needs_review" | "changes_requested") =>
      this.store.tasksInStage(stage).map((task) => ({ task, projectName: name(task.projectId) }));
    return { proposals, handoffs, questions, reviews: inStage("needs_review"), changes: inStage("changes_requested"), held, blocked };
  }

  // The owner's inbox: on a project with the steward, only what it escalated, with its reason.
  inbox(): Inbox {
    const all = this.allInbox();
    const projects = new Map(this.store.listProjects().map((p) => [p.id, p]));
    const items = this.store.stewardItems({ limit: 2000 });
    const byKey = new Map(items.map((i) => [`${i.projectId}/${i.key}`, i]));
    const stewardNotes: Record<string, string> = {};
    // Items the steward has not picked up yet: it does within moments, and the owner hears only what it escalates.
    const unrouted: StewardItem[] = [];
    const owner = (projectId: string, kind: StewardItemKind, key: string, title: string, taskId?: string) => {
      if (!projects.get(projectId)?.inboxSteward) return true;
      // The steward's own work: its questions and holds are the owner's; its finished triage closes by itself.
      if (taskId && this.store.isStewardTask(taskId)) return kind === "question" || kind === "held" || kind === "blocked";
      const item = byKey.get(`${projectId}/${key}`);
      if (!item) unrouted.push({ projectId, key, kind, title, taskId: null, status: "triaging", action: null, note: null, createdAt: "", decidedAt: null });
      if (item?.status === "escalated") stewardNotes[key] = item.note ?? "";
      return item?.status === "escalated";
    };
    const proposals = all.proposals.filter((p) => owner(p.projectId, "proposal", inboxKeys.proposal(p), `Proposal for ${p.docPath}`));
    const handoffs = all.handoffs.filter((h) => owner(h.projectId, "handoff", inboxKeys.handoff(h), `Task request "${h.title}" for ${h.toRoleName}`));
    const questions = all.questions.filter((q) =>
      owner(q.task.projectId, "question", inboxKeys.question(q.task), `Question from "${q.task.title}"`, q.task.id),
    );
    const reviews = all.reviews.filter((r) => owner(r.task.projectId, "review", inboxKeys.review(r.task), `Review "${r.task.title}"`, r.task.id));
    const changes = all.changes.filter((r) =>
      owner(r.task.projectId, "changes", inboxKeys.changes(r.task), `Changes requested on "${r.task.title}"`, r.task.id),
    );
    const held = all.held.filter((h) => owner(h.task.projectId, "held", inboxKeys.held(h.run), `"${h.task.title}" is held`, h.task.id));
    const blocked = all.blocked.filter((h) => owner(h.task.projectId, "blocked", inboxKeys.blocked(h.run), `"${h.task.title}" is blocked`, h.task.id));
    const named = (i: StewardItem) => ({ ...i, projectName: projects.get(i.projectId)?.name ?? "?" });
    const steward = {
      triaging: [...items.filter((i) => i.status === "triaging" && projects.get(i.projectId)?.inboxSteward), ...unrouted].map(named),
      handled: items
        .filter((i) => i.status === "handled")
        .slice(0, 20)
        .map(named),
    };
    const alerts = items.filter((i) => i.status === "escalated" && isHealthKind(i.kind) && projects.get(i.projectId)?.inboxSteward).map(named);
    const count = proposals.length + handoffs.length + questions.length + reviews.length + changes.length + held.length + blocked.length + alerts.length;
    return { proposals, handoffs, questions, reviews, changes, held, blocked, alerts, steward, stewardNotes, count };
  }

  private pendingProposal(id: string): { proposal: Proposal; repo: string } {
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new HttpError("Proposal not found.", 404);
    if (proposal.status !== "pending") throw new HttpError("This proposal was already decided.", 409);
    const project = this.store.getProject(proposal.projectId);
    if (!project) throw new HttpError("Project not found.", 404);
    return { proposal, repo: project.repoPath };
  }

  async acceptProposal(id: string, editedBody?: string, acceptedBy = "the owner"): Promise<{ proposal: Proposal; commitError: string | null }> {
    const { proposal, repo } = this.pendingProposal(id);
    const edited = editedBody !== undefined && editedBody !== proposal.body;
    const body = editedBody ?? proposal.body;
    const by = proposal.roleName ?? "an agent";
    const saved = await saveDocs(repo, {
      files: [{ path: proposal.docPath, content: body }],
      decision: {
        title: `${proposal.docPath} updated`,
        body: `Proposed by ${by}${edited ? " and edited by the owner" : ""}; accepted by ${acceptedBy}.${proposal.rationale ? `\n\n${proposal.rationale}` : ""}`,
      },
      message: `Update ${proposal.docPath} (proposal by ${by})\n\n${proposal.rationale}`.trim(),
    });
    const decided = this.store.decideProposal(id, { status: "accepted", body })!;
    this.bus.publish({ type: "inbox_changed" });
    this.bus.publish({ type: "docs_changed", projectId: proposal.projectId });
    return { proposal: decided, commitError: saved.commitError };
  }

  rejectProposal(id: string, reason?: string): Proposal {
    const { proposal } = this.pendingProposal(id);
    const decided = this.store.decideProposal(id, { status: "rejected", note: reason || null })!;
    this.bus.publish({ type: "inbox_changed" });
    // The agent learns why, in its own conversation, so its next attempt can do better.
    const task = proposal.taskId ? this.store.getTask(proposal.taskId) : null;
    if (reason && task && task.status !== "running" && task.status !== "queued")
      this.runner.send(task.id, `The owner rejected your proposal for ${proposal.docPath}: ${reason}`);
    return decided;
  }

  approveHandoff(id: string, patch: { roleId?: string; priority?: number; emergency?: boolean }): Task {
    const handoff = this.store.getHandoff(id);
    if (!handoff) throw new HttpError("Request not found.", 404);
    if (handoff.status !== "pending") throw new HttpError("This request was already decided.", 409);
    const roleId = patch.roleId ?? handoff.roleId ?? this.store.findRoleByName(handoff.projectId, handoff.toRoleName)?.id;
    if (!roleId) throw new HttpError(`There is no role called "${handoff.toRoleName}". Pick one.`, 400);
    const parent = handoff.fromTaskId ? this.store.getTask(handoff.fromTaskId) : null;
    const task = this.createTask({
      projectId: handoff.projectId,
      roleId,
      dependencyIds: handoff.dependencyIds,
      requiredPaths: handoff.requiredPaths,
      title: handoff.title,
      message: handoff.prompt,
      priority: patch.priority ?? handoff.priority,
      emergency: patch.emergency ?? handoff.emergency,
      parentTaskId: handoff.fromTaskId,
      depth: handoff.depth,
      createdByRoleId: parent?.roleId ?? null,
    });
    this.store.decideHandoff(id, { status: "created", createdTaskId: task.id });
    this.bus.publish({ type: "inbox_changed" });
    return task;
  }

  rejectHandoff(id: string): void {
    const handoff = this.store.getHandoff(id);
    if (!handoff) throw new HttpError("Request not found.", 404);
    if (handoff.status !== "pending") throw new HttpError("This request was already decided.", 409);
    this.store.decideHandoff(id, { status: "rejected" });
    this.bus.publish({ type: "inbox_changed" });
  }

  async answer(taskId: string, text: string, record: boolean): Promise<{ run: Run; commitError: string | null }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError("Task not found.", 404);
    if (task.status !== "waiting" || !task.question) throw new HttpError("This task has no open question.", 409);
    let commitError: string | null = null;
    if (record) {
      const project = this.store.getProject(task.projectId)!;
      const asker = task.roleId ? (this.store.getRole(task.roleId)?.name ?? "An agent") : "An agent";
      const saved = await saveDocs(project.repoPath, {
        files: [],
        decision: { title: task.title, body: `${asker} asked:\n\n> ${task.question.replace(/\n/g, "\n> ")}\n\nThe owner answered:\n\n${text}` },
        message: `Record decision: ${task.title}`,
      });
      commitError = saved.commitError;
      this.bus.publish({ type: "docs_changed", projectId: task.projectId });
    }
    const { run } = this.runner.send(taskId, text);
    this.bus.publish({ type: "inbox_changed" });
    return { run, commitError };
  }

  // ---- compute

  compute(): Compute {
    const settings = this.store.getSettings();
    const projects = new Map(this.store.listProjects().map((p) => [p.id, p]));
    const departments = this.store.listDepartments();
    const day = sinceDays(1);
    const deptSpend = this.store.departmentSpendSince(day);
    const deptSpendWeek = this.store.departmentSpendSince(sinceDays(7));
    const row = (run: Run): ComputeRun | null => {
      const task = this.store.getTask(run.taskId);
      if (!task) return null;
      return {
        run,
        taskTitle: task.title,
        projectId: task.projectId,
        projectName: projects.get(task.projectId)?.name ?? "?",
        roleName: run.roleId ? (this.store.getRole(run.roleId)?.name ?? null) : null,
        agentName: run.agentId ? this.store.agentName(run.agentId) : null,
        departmentName: run.departmentId ? (departments.find((d) => d.id === run.departmentId)?.name ?? null) : null,
        priority: task.priority,
        emergency: task.emergency,
        provider: run.status === "queued" ? this.runner.runProvider(run) : run.provider,
      };
    };
    const active = this.runner.activeRuns().flatMap((a) => {
      const run = this.store.getRun(a.runId);
      const r = run ? row(run) : null;
      return r ? [r] : [];
    });
    const queued = this.store
      .runsWithStatus("queued")
      .flatMap((run) => {
        const r = row(run);
        return r ? [r] : [];
      })
      .sort((a, b) => Number(b.emergency) - Number(a.emergency) || b.priority - a.priority || a.run.startedAt.localeCompare(b.run.startedAt));
    return {
      maxConcurrentRuns: settings.maxConcurrentRuns,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      spend24h: this.store.totalSpendSince(day),
      active,
      queued,
      departments: departments.map((d) => ({
        id: d.id,
        projectId: d.projectId,
        projectName: projects.get(d.projectId)?.name ?? "?",
        name: d.name,
        color: d.color,
        weight: d.weight,
        dailyBudgetUsd: d.dailyBudgetUsd,
        spend24h: deptSpend.get(d.id) ?? 0,
        spend7d: deptSpendWeek.get(d.id) ?? 0,
      })),
    };
  }

  // ---- feedback

  triage(projectId: string, itemIds: string[], roleId: string, priority?: number): Task {
    const project = this.store.getProject(projectId);
    if (!project) throw new HttpError("Project not found.", 404);
    const items = itemIds.map((id) => this.store.getFeedback(id)).filter((f) => f && f.projectId === projectId);
    if (items.length === 0) throw new HttpError("Select feedback from this project.", 400);
    const list = items.map((item, i) => `${i + 1}. (${item!.source}) ${item!.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
    // Weighed like player opinions, the owner's own requests were deferred into spec-only "later milestone" tasks and never built.
    const fromOwner = items.some((item) => isOwnerSource(item!.source));
    const task = this.createTask({
      projectId,
      roleId,
      title: `Triage ${items.length} feedback item${items.length === 1 ? "" : "s"}`,
      priority,
      message: [
        `Triage this player feedback for "${project.name}".`,
        "Group duplicates, weigh each point against the vision and current priorities, and create tasks (task blocks) for the right roles with honest priorities.",
        "List anything you decide not to act on, and why.",
        ...(fromOwner
          ? [
              "Items marked (Owner) are the owner's own requirements, not opinions to weigh: do not defer them to a later milestone or turn them into spec-only tasks.",
              "Create implementation tasks that deliver each one in the playable build soon, with high priority. If one truly conflicts with the vision or needs a design call, ask the owner with a question block instead of deferring it.",
            ]
          : []),
        "",
        list,
      ].join("\n"),
    });
    for (const item of items) this.store.updateFeedback(item!.id, { status: "triaged", taskId: task.id });
    this.bus.publish({ type: "feedback_changed", projectId });
    return task;
  }
}

// The owner pastes their own playtest notes as "Owner" (or "me"); other sources are players.
const isOwnerSource = (source: string) => /^(owner|me)$/i.test(source.trim());
