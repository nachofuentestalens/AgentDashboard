import type { FastifyInstance } from "fastify";
import { companyConfigSchema, type CompanyConfig, type CompanyView, type CompanyAssignmentKind } from "@ad/shared";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";
import type { Studio } from "./studio.ts";
import type { Bus } from "./bus.ts";
import { HttpError, parse } from "./http.ts";

const ROLES = { director: "Game Director", qa: "QA Player" } as const;

export function dailyCompanyPrompt(config: CompanyConfig, kind: CompanyAssignmentKind, day: string): string {
  return [
    `Company ${kind === "director" ? "director review" : "QA playtest"} for ${day} (UTC).`,
    `Game description: ${config.description}`,
    `Genre: ${config.genre}`,
    `Audience: ${config.audience || "Use the game description to choose a reasonable target audience."}`,
    `References: ${config.references || "None supplied."}`,
    `Playtest instructions: ${config.playtestInstructions || "Inspect the repository's documented local launch and playtest instructions."}`,
    "Use the available local game build and supported tools to play. Record the build/commit, tested scenarios, time spent, and evidence paths or screenshots.",
    "Never claim to have played based only on source inspection, automated unit tests, or another agent's report. If interactive play is unavailable, label the report NOT PLAYED, explain the blocker, and propose a concrete next step.",
    "You are an AI playtester: describe observed usability, pacing, challenge, clarity, and replay motivation; do not present your judgment as human player feedback.",
    "Separate reproducible bugs (steps, expected/actual behavior, severity) from subjective fun assessments and untested hypotheses.",
    kind === "director"
      ? "Write a daily director report: current playable state against the brief; strongest and weakest parts of the experience; top three next steps with acceptance criteria; milestone goals and exit criteria; needed designs; recommended staffing changes with reasons. Prioritize a playable core loop before speculative features. Recommendations are not executed staffing changes."
      : "Play as both a first-time and a returning player when possible. Write a QA report with scenario coverage, bugs, friction, fun observations, and ranked recommendations. Include what you could not test.",
    "Return the full report in your reply so it is retained in this task. This assignment is observation and planning; do not modify the repository, deploy, purchase, subscribe, or interrupt a live service.",
    "Make reasonable creative decisions from the brief. Escalate proposed spending or live-service downtime to the owner with a question block before taking action. Existing dashboard permission and delivery gates still apply.",
    "End with a step block using state complete. A completed report is not proof that the game was successfully played.",
  ].join("\n\n");
}

export class Company {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private runner: Runner,
    private studio: Studio,
    private bus: Bus,
    private now = Date.now,
  ) {}

  view(projectId: string): CompanyView {
    if (!this.store.getProject(projectId)) throw new HttpError("Project not found.", 404);
    return {
      config: this.store.companyConfig(projectId),
      error: this.store.companyError(projectId),
      assignments: this.store.companyAssignments(projectId).map(({ prompt: _prompt, ...a }) => ({
        ...a,
        status: a.taskId ? (this.store.getTask(a.taskId)?.status ?? "deleted") : "deleted",
      })),
    };
  }

  configure(projectId: string, config: CompanyConfig): CompanyView {
    if (!this.store.getProject(projectId)) throw new HttpError("Project not found.", 404);
    if (config.enabled) for (const kind of ["director", "qa"] as const) this.ensureRole(projectId, kind);
    this.store.saveCompanyConfig(projectId, config);
    this.tick();
    this.bus.publish({ type: "studio_changed", projectId });
    return this.view(projectId);
  }

  private ensureRole(projectId: string, kind: CompanyAssignmentKind) {
    let role = this.store.findRoleByName(projectId, ROLES[kind]);
    if (!role) {
      const name = kind === "director" ? "Leadership" : "QA";
      const dept =
        this.store.listDepartments(projectId).find((d) => d.name.toLowerCase() === name.toLowerCase()) ??
        this.store.createDepartment({
          projectId,
          name,
          color: kind === "director" ? "#a78bfa" : "#34d399",
          weight: 3,
          dailyBudgetUsd: null,
          folders: [kind === "director" ? "design/studio" : "qa"],
          autonomy: "ask",
        });
      role = this.store.createRole({
        projectId,
        departmentId: dept.id,
        name: ROLES[kind],
        brief:
          kind === "director"
            ? "Evaluate the playable game against the company brief and report priorities, milestones, and staffing needs."
            : "Play the game, identify reproducible bugs, and report observed usability and fun with evidence.",
        provider: null,
        model: null,
        effort: "medium",
        canEdit: false,
        allowedTools: null,
        contextDocs: [],
      });
    }
    if (!this.store.listAgents(projectId).some((a) => a.roleId === role.id)) this.studio.hire(role.id);
  }

  tick(): void {
    if (this.runner.restartHeld) return;
    const now = new Date(this.now());
    const day = now.toISOString().slice(0, 10);
    for (const project of this.store.listProjects()) {
      const config = this.store.companyConfig(project.id);
      if (!config?.enabled || this.runner.isProjectBusy(project.id)) continue;
      try {
        if (now.getUTCHours() >= config.dailyHourUtc) {
          for (const kind of ["qa", "director"] as const) {
            const role = this.store.findRoleByName(project.id, ROLES[kind]);
            if (!role) throw new Error(`Daily ${kind} assignment needs the ${ROLES[kind]} role. Save company settings to restore it.`);
            const task = this.store.createCompanyAssignment(project.id, day, kind, role.id, dailyCompanyPrompt(config, kind, day));
            if (task) this.bus.publish({ type: "task_updated", task });
          }
        }
        for (const assignment of this.store.companyAssignments(project.id, true)) {
          this.store.dispatchCompanyAssignment(project.id, assignment, () => this.runner.send(assignment.taskId!, assignment.prompt));
        }
        this.store.setCompanyError(project.id, null);
      } catch (error) {
        this.store.setCompanyError(project.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function registerCompanyRoutes(app: FastifyInstance, company: Company) {
  app.get<{ Params: { id: string } }>("/api/projects/:id/company", async (request) => company.view(request.params.id));
  app.put<{ Params: { id: string } }>("/api/projects/:id/company", async (request, reply) => {
    const config = parse(companyConfigSchema, request.body, reply);
    if (config) return company.configure(request.params.id, config);
  });
}
