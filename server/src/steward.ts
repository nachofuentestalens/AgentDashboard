import path from "node:path";
import {
  inboxKeys,
  isHealthKind,
  MAX_PRIORITY,
  STEWARD_ACTIONS,
  type Project,
  type Role,
  type StewardAction,
  type StewardItemKind,
  type Task,
} from "@ad/shared";
import type { Bus } from "./bus.ts";
import { MAX_RETRIES, projectHealth, type HealthConcern } from "./health.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { Studio } from "./studio.ts";

// The inbox steward: an agent role that sees every inbox item of its project first, decides what it
// can on the owner's behalf through validated `decision` blocks, and escalates the rest with a
// reason. See docs/STEWARD.md. The agent never changes state itself: this service applies its
// decisions after its run ends, through the same Studio and Runner calls the owner's buttons use.

export const STEWARD_ROLE = "Inbox Steward";
const BATCH = 12;
const DETAIL_CHARS = 3_000;
const REPORTS_KEY = "steward.reports";
const REPORT_OPEN_MS = 24 * 60 * 60_000;

interface Decision {
  item: string;
  action: string;
  text: string | null;
  reason: string;
  role?: string;
}

interface Candidate {
  key: string;
  kind: StewardItemKind;
  title: string;
  detail: string;
  // The kind's actions, minus those that cannot work now (a retry after too many failures).
  actions?: readonly string[];
  apply: (action: StewardAction, d: Decision, steward: Role) => Promise<void> | void;
}

const clip = (text: string | null | undefined, max = DETAIL_CHARS) => {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}\n[... ${t.length - max} more characters]` : t;
};

export const STEWARD_BRIEF = [
  "Handle the owner's inbox on their behalf. Every question, proposal, task request, review and hold reaches you first; the owner only sees what you escalate.",
  "Decide from the company brief, the design documents, design/decisions.md and the repository. Prefer reversible choices, state your assumptions, and keep the studio moving.",
  "Watch the project as a whole, not only single items: the server also reports stalls, repeated failures and idle work, with a health overview. When several items share one cause, fix the cause.",
  "Escalate only when an item spends money or adds paid services; deletes or irreversibly changes the owner's data, history or releases; touches credentials, legal, licensing or publishing outside the repository; settles a game-direction choice the documents leave open and that is costly to reverse; or when you cannot get the information you need by reading.",
].join(" ");

export function stewardPrompt(project: Project, items: Candidate[], brief: string | null, overview = ""): string {
  return [
    `Triage ${items.length} inbox item${items.length === 1 ? "" : "s"} for "${project.name}" on the owner's behalf.`,
    brief ? `Company brief: ${clip(brief, 2_000)}` : "",
    overview,
    "Look at the items together with the health overview before deciding one by one. A stall, a failure that repeats or the same error across tasks usually has one cause: find it (read the repository, the tasks and design/), handle the cause once, and decide the other items consistently. Nobody else watches the project between the owner's visits.",
    "For every item, end your reply with exactly one decision block (JSON). `text` carries the answer, the review findings, the reason for a rejection or the next instructions; `reason` is a short line the owner reads.",
    "```decision",
    '{"item": "<item key>", "action": "<one of the item\'s actions>", "text": "...", "reason": "..."}',
    "```",
    'Actions: answer (needs text) the agent\'s question; accept or reject a design proposal; approve or reject a task request; for finished steps: continue (optionally with text), review (ask the reviewer role), request_changes (needs text), approve (only after a passed agent review of the current work), close (read-only reports only); fix for requested changes; wait for held or blocked runs (they start on their own when the hold clears). Project health concerns: wait (a stall that will clear by itself; you will be asked again if it lasts), retry (a failed task, when the failure looks transient), continue (an idle task in progress; text gives the next instructions), delegate (add `"role": "<role name>"` and put the instructions in text: the role gets a task to fix the cause in the project), report (the cause is in AgentDashboard itself, the tool running the studio: wrong scheduling, a hold that should have cleared, a crash in the dashboard; put your diagnosis and evidence in text and a fix task is filed on the dashboard\'s repository). escalate hands the item to the owner: put your recommendation in text.',
    "Escalate only for money, irreversible deletion, credentials, legal or licensing, publishing outside the repository, open and costly game-direction choices, or missing information. Do not ask question blocks; use escalate. Do not edit files.",
    ...items.map((c, i) =>
      [`## ${i + 1}. ${c.title}`, `Item key: ${c.key}`, `Kind: ${c.kind}; actions: ${(c.actions ?? STEWARD_ACTIONS[c.kind]).join(", ")}`, c.detail].join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class Steward {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  // The dashboard's own repository: "report" decisions file a fix task on the project that uses it.
  dashboardRepo = path.resolve(import.meta.dirname, "..", "..");

  constructor(
    private store: Store,
    private runner: Runner,
    private studio: Studio,
    private bus: Bus,
  ) {}

  start(): void {
    if (this.timer) return;
    // New inbox items and finished triage runs are picked up at once; the timer is a fallback.
    this.unsubscribe = this.bus.subscribe((push) => {
      if (push.type === "inbox_changed" || push.type === "run_updated") setImmediate(() => void this.tick());
    });
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.timer = null;
    this.unsubscribe = null;
  }

  // One pass at a time; a request during a pass runs another one after it.
  tick(): Promise<void> {
    // Pushes and timers may still fire while the server closes.
    if (!this.timer) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        for (const project of this.store.listProjects()) {
          if (!project.inboxSteward || !this.timer) continue;
          try {
            await this.pass(project);
          } catch (error) {
            console.warn(`Inbox steward for ${project.name}: ${(error as Error).message}`);
          }
        }
      } while (this.again && this.timer);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(project: Project): Promise<void> {
    const { candidates, overview } = this.candidates(project);
    const brief = this.store.companyConfig(project.id)?.description ?? null;
    const triaging = this.store.stewardItems({ projectId: project.id, status: "triaging" });
    let settled = false;
    let active = false;
    for (const taskId of new Set(triaging.map((i) => i.taskId))) {
      const items = triaging.filter((i) => i.taskId === taskId);
      const task = taskId ? this.store.getTask(taskId) : null;
      if (task && (task.status === "running" || task.status === "queued" || task.status === "waiting")) {
        active = true;
        continue;
      }
      // Routed before a crash, never sent: send it now.
      if (task && task.status === "idle" && this.store.listRuns(task.id).length === 0) {
        const open = items.flatMap((i) => candidates.get(i.key) ?? []);
        if (open.length) {
          this.runner.send(task.id, stewardPrompt(project, open, brief, overview));
          active = true;
          continue;
        }
      }
      const failure = task ? this.store.listRuns(task.id).at(-1)?.error : "The triage task was deleted.";
      for (const item of items) {
        const current = candidates.get(item.key);
        const decision = this.store.stewardDecision<Decision>(project.id, item.key);
        if (!current) this.store.settleStewardItem(project.id, item.key, "handled", null, decision?.reason ?? "Resolved before the steward acted.");
        else if (!decision)
          this.store.settleStewardItem(project.id, item.key, "escalated", null, `The steward did not decide this item${failure ? `: ${failure}` : "."}`);
        else await this.apply(project, current, decision);
        settled = true;
      }
      if (task?.stage && task.stage !== "closed" && task.stage !== "in_review") {
        try {
          this.runner.stageAction(task.id, { action: "close" });
        } catch {
          // Another action got there first; the triage is recorded either way.
        }
      }
    }
    // Escalated health concerns that cleared by themselves leave the owner's inbox.
    if (!project.automationPaused && !this.runner.restartHeld)
      for (const alert of this.store.stewardItems({ projectId: project.id, status: "escalated" }))
        if (isHealthKind(alert.kind) && !candidates.has(alert.key))
          settled = this.store.clearStewardAlert(project.id, alert.key, "Cleared by itself.") || settled;
    if (settled) this.bus.publish({ type: "inbox_changed" });
    if (active || this.runner.restartHeld || project.automationPaused) return;

    const known = this.store.stewardKeys(project.id);
    const fresh = [...candidates.values()].filter((c) => !known.has(c.key)).slice(0, BATCH);
    if (fresh.length === 0) return;
    const role = this.ensureRole(project.id);
    const prompt = stewardPrompt(project, fresh, brief, overview);
    const taskId = this.store.routeStewardItems(
      project.id,
      fresh,
      () =>
        this.studio.createTask({
          projectId: project.id,
          roleId: role.id,
          title: `Inbox triage: ${fresh.length} item${fresh.length === 1 ? "" : "s"}`,
          priority: MAX_PRIORITY,
          canEdit: false,
        }).id,
    );
    this.runner.send(taskId, prompt);
    this.bus.publish({ type: "inbox_changed" });
  }

  private async apply(project: Project, item: Candidate, decision: Decision): Promise<void> {
    const allowed: readonly string[] = item.actions ?? STEWARD_ACTIONS[item.kind];
    const reason = decision.reason;
    if (!allowed.includes(decision.action)) {
      this.store.settleStewardItem(project.id, item.key, "escalated", null, `The steward chose "${decision.action}", which is not allowed here. ${reason}`);
      return;
    }
    const action = decision.action as StewardAction;
    if (action === "escalate") {
      this.store.settleStewardItem(project.id, item.key, "escalated", "escalate", decision.text ? `${reason}\n\nRecommendation: ${decision.text}` : reason);
      return;
    }
    try {
      await item.apply(action, decision, this.ensureRole(project.id));
      this.store.settleStewardItem(project.id, item.key, "handled", action, reason);
    } catch (error) {
      this.store.settleStewardItem(
        project.id,
        item.key,
        "escalated",
        action,
        `The steward chose ${action}, but it failed: ${(error as Error).message} (${reason})`,
      );
    }
  }

  private ensureRole(projectId: string): Role {
    let role = this.store.findRoleByName(projectId, STEWARD_ROLE);
    if (!role) {
      const dept =
        this.store.listDepartments(projectId).find((d) => d.name.toLowerCase() === "leadership") ??
        this.store.createDepartment({
          projectId,
          name: "Leadership",
          color: "#a78bfa",
          weight: 3,
          dailyBudgetUsd: null,
          folders: ["design/studio"],
          autonomy: "ask",
        });
      role = this.store.createRole({
        projectId,
        departmentId: dept.id,
        name: STEWARD_ROLE,
        brief: STEWARD_BRIEF,
        provider: null,
        model: null,
        effort: "medium",
        canEdit: false,
        allowedTools: null,
        contextDocs: [],
      });
    }
    if (!this.store.listAgents(projectId).some((a) => a.roleId === role.id)) this.studio.hire(role.id);
    return role;
  }

  // What the steward may decide now: the project's inbox items and health concerns, minus its own triage work.
  private candidates(project: Project): { candidates: Map<string, Candidate>; overview: string } {
    const projectId = project.id;
    const all = this.studio.allInbox();
    const out = new Map<string, Candidate>();
    const own = (task: Task) => this.store.isStewardTask(task.id);
    const roleName = (task: Task) => (task.roleId ? (this.store.getRole(task.roleId)?.name ?? "a role") : "a chat");
    const text = (d: Decision) => d.text ?? d.reason;
    const add = (c: Candidate) => out.set(c.key, c);

    for (const { task } of all.questions) {
      if (task.projectId !== projectId || own(task)) continue;
      add({
        key: inboxKeys.question(task),
        kind: "question",
        title: `Question from "${task.title}" (${roleName(task)})`,
        detail: `Question:\n${clip(task.question)}${task.stepSummary ? `\n\nLast step: ${clip(task.stepSummary, 800)}` : ""}`,
        apply: async (_action, d) => {
          if (!d.text) throw new Error("an answer needs text.");
          await this.studio.answer(task.id, `Answer from the inbox steward, on the owner's behalf:\n\n${d.text}`, false);
        },
      });
    }
    for (const p of all.proposals) {
      if (p.projectId !== projectId) continue;
      add({
        key: inboxKeys.proposal(p),
        kind: "proposal",
        title: `Proposal for ${p.docPath} by ${p.roleName ?? "an agent"}`,
        detail: `Rationale: ${clip(p.rationale, 1_000)}\n\nProposed document:\n${clip(p.body)}\n\nCurrent document:\n${p.current === null ? "(new file)" : clip(p.current, 1_500)}`,
        apply: async (action, d) => {
          if (action === "accept") await this.studio.acceptProposal(p.id, undefined, "the inbox steward");
          else this.studio.rejectProposal(p.id, text(d));
        },
      });
    }
    for (const h of all.handoffs) {
      if (h.projectId !== projectId) continue;
      add({
        key: inboxKeys.handoff(h),
        kind: "handoff",
        title: `Task request "${h.title}" for ${h.toRoleName}`,
        detail: `From: ${h.fromRoleName ?? "a chat"}; priority ${h.priority}${h.emergency ? ", emergency" : ""}.\nWaiting because: ${h.reason ?? "unknown"}\n\nInstructions:\n${clip(h.prompt)}`,
        apply: (action) => {
          if (action === "approve") this.studio.approveHandoff(h.id, {});
          else this.studio.rejectHandoff(h.id);
        },
      });
    }
    for (const { task } of all.reviews) {
      if (task.projectId !== projectId || own(task)) continue;
      const reviews = this.store.listTaskReviews(task.id);
      const last = reviews.at(-1);
      const checkpoint = this.store.getWorkspace(task.id)?.checkpointCommit ?? null;
      const passed = last?.verdict === "pass" && (!checkpoint || last.commit === checkpoint);
      add({
        key: inboxKeys.review(task),
        kind: "review",
        title: `Finished step of "${task.title}" (${roleName(task)})`,
        detail: [
          `Writes files: ${task.canEdit ? "yes" : "no (read-only report)"}. Step state: ${task.stepState ?? "none"}.`,
          `Summary: ${clip(task.stepSummary, 1_500) || "none"}`,
          `Next step: ${task.nextStep ?? "none"}`,
          last ? `Latest review: ${last.verdict}${last.findings.length ? ` - ${clip(last.findings.join("; "), 1_000)}` : ""}` : "Not reviewed yet.",
          `Approve is ${passed ? "available: an agent review passed the current work" : "not available until an agent review passes the current work"}.`,
        ].join("\n"),
        apply: async (action, d, steward) => {
          if (action === "review") await this.runner.startReview(task.id);
          else if (action === "continue") this.runner.stageAction(task.id, { action: "continue", text: d.text ?? undefined });
          else if (action === "request_changes") this.runner.stageAction(task.id, { action: "request_changes", text: text(d) }, false, steward.id);
          else if (action === "close") {
            if (task.canEdit) throw new Error("only read-only reports can be closed by the steward; approve or request changes instead.");
            this.runner.stageAction(task.id, { action: "close" });
          } else {
            if (!passed) throw new Error("approval needs a passed agent review of the current work.");
            this.runner.stageAction(task.id, { action: "approve" }, false, steward.id);
          }
        },
      });
    }
    for (const { task } of all.changes) {
      if (task.projectId !== projectId || own(task)) continue;
      const findings = this.store.listTaskReviews(task.id).at(-1)?.findings ?? [];
      add({
        key: inboxKeys.changes(task),
        kind: "changes",
        title: `Changes requested on "${task.title}" (${roleName(task)})`,
        detail: `Findings:\n${clip(findings.map((f) => `- ${f}`).join("\n")) || "none recorded"}`,
        apply: (_action, d) => void this.runner.stageAction(task.id, { action: "fix", text: d.text ?? undefined }),
      });
    }
    for (const kind of ["held", "blocked"] as const) {
      for (const { run, task } of all[kind]) {
        if (task.projectId !== projectId || own(task)) continue;
        add({
          key: inboxKeys[kind](run),
          kind,
          title: `"${task.title}" is ${kind}`,
          detail: `Reason: ${run.waitReason ?? "unknown"}. Running it anyway would override a budget or baseline the owner set, which only the owner can do.`,
          apply: () => {},
        });
      }
    }

    // A paused project is the owner's choice, not a stall.
    if (project.automationPaused) return { candidates: out, overview: "" };
    const tasks = this.store
      .listTasks(projectId)
      .filter((t) => t.stage !== "closed" && t.status !== "done" && !own(t))
      .map((task) => ({ task, runs: this.store.listRuns(task.id) }));
    const running = tasks.reduce((n, t) => n + t.runs.filter((r) => r.status === "running").length, 0);
    const health = projectHealth({ now: Date.now(), tasks, runningElsewhere: Math.max(0, this.runner.activeRuns().length - running) });
    for (const concern of health.concerns) {
      const task = concern.taskId ? this.store.getTask(concern.taskId) : null;
      add({
        key: concern.key,
        kind: concern.kind,
        title: concern.title,
        detail: `${task ? `Task: "${task.title}" (${roleName(task)}), id ${task.id}.\n` : ""}${concern.detail}`,
        actions: concern.kind === "failing" && (concern.failures ?? 0) >= MAX_RETRIES ? STEWARD_ACTIONS.failing.filter((a) => a !== "retry") : undefined,
        apply: async (action, d, steward) => {
          if (action === "delegate") this.delegate(project, concern, d, steward);
          else if (action === "report") this.report(project, concern, d);
          else if (action === "retry") {
            if ((concern.failures ?? 0) >= MAX_RETRIES) throw new Error(`it already failed ${concern.failures} times in a row.`);
            await this.runner.retry(concern.runId!);
          } else if (action === "continue") this.runner.send(concern.taskId!, d.text ?? "Continue with the task from where you left off.", true);
          // wait: nothing to do; a stall that lasts gets a new key and comes back.
        },
      });
    }
    return { candidates: out, overview: health.overview };
  }

  // The steward hands the cause of a concern to a project role, as the owner would with a new task.
  private delegate(project: Project, concern: HealthConcern, d: Decision, steward: Role): void {
    if (!d.text) throw new Error("delegating needs instructions in text.");
    const role = d.role ? this.store.findRoleByName(project.id, d.role) : null;
    if (!role || role.id === steward.id) throw new Error(`"${d.role ?? ""}" is not a role of this project.`);
    this.studio.createTask({
      projectId: project.id,
      roleId: role.id,
      title: `Fix: ${concern.title}`.slice(0, 120),
      priority: MAX_PRIORITY - 2,
      parentTaskId: concern.taskId,
      depth: 1,
      createdByRoleId: steward.id,
      message: `The inbox steward found a problem in the project and hands its cause to you.\n\nProblem: ${concern.title}\n${concern.detail}\n\nInstructions:\n${d.text}`,
    });
  }

  // Problems in AgentDashboard itself are fixed on its own repository, when the owner added it as a project.
  private report(project: Project, concern: HealthConcern, d: Decision): void {
    if (!d.text) throw new Error("a report needs the diagnosis in text.");
    const same = (a: string, b: string) => {
      const [x, y] = [path.resolve(a), path.resolve(b)];
      return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
    };
    const dashboard = this.store.listProjects().find((p) => same(p.repoPath, this.dashboardRepo));
    if (!dashboard) throw new Error("no project uses the AgentDashboard repository, so the steward cannot file a fix there.");
    const message = [
      `The inbox steward of the project "${project.name}" found a problem that looks like it comes from AgentDashboard itself, not from the project's work.`,
      "Find the root cause in the dashboard code, fix it with a test that reproduces it, and follow CLAUDE.md. If the dashboard is not at fault, say why and change nothing.",
      `Symptom: ${concern.title}\n${concern.detail}`,
      `The steward's diagnosis:\n${d.text}`,
    ].join("\n\n");
    // One open fix at a time, so one fault seen by several projects does not start several fixes:
    // later reports join the open one.
    const reports = (this.store.getStateJson<string[]>(REPORTS_KEY) ?? []).filter((id) => this.store.getTask(id));
    const open = reports
      .map((id) => this.store.getTask(id)!)
      .find((t) => t.status !== "done" && !this.store.getWorkspace(t.id)?.mergeCommit && Date.now() - Date.parse(t.updatedAt) < REPORT_OPEN_MS);
    if (open) {
      if (open.status !== "idle" && open.status !== "failed" && open.status !== "interrupted")
        throw new Error(`the dashboard fix "${open.title}" (task ${open.id}) is still working; this waits for the owner.`);
      this.runner.send(open.id, `Another report for this fix.\n\n${message}`);
      return;
    }
    const title = `Dashboard fix: ${concern.title} (seen in ${project.name})`;
    const task = this.studio.createTask({ projectId: dashboard.id, roleId: null, title: title.slice(0, 120), message });
    this.store.setStateJson(REPORTS_KEY, [...reports, task.id].slice(-20));
  }
}
