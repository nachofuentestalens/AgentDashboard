import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyConfig, CompanyView } from "@ad/shared";
import type { App } from "../src/app.ts";
import { Company, dailyCompanyPrompt } from "../src/company.ts";
import { api, newProject, testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
});
const config: CompanyConfig = {
  enabled: true,
  description: "A cozy fishing game",
  genre: "Exploration",
  audience: "Casual players",
  references: "A Short Hike: gentle discovery",
  playtestInstructions: "Use the local development build",
  dailyHourUtc: 9,
};

async function setup() {
  const app = await testApp();
  apps.push(app);
  const id = await newProject(app);
  let time = Date.parse("2026-10-20T08:59:00Z");
  const company = new Company(app.store, app.runner, app.studio, app.bus, () => time);
  company.configure(id, config);
  for (const a of app.store.listAgents(id)) app.store.updateAgent(a.id, { paused: true });
  return {
    app,
    id,
    company,
    advance: (date: string) => {
      time = Date.parse(date);
      company.tick();
    },
  };
}

describe("company daily assignments", () => {
  it("staffs only the initial review roles and queues once per UTC day after the configured hour", async () => {
    const { app, id, company, advance } = await setup();
    expect(app.store.listRoles(id).map((r) => r.name)).toEqual(["Game Director", "QA Player"]);
    expect(company.view(id).assignments).toEqual([]);
    company.configure(id, config);
    expect(app.store.listAgents(id)).toHaveLength(2);
    expect(app.store.listAgents(id).every((a) => a.paused)).toBe(true);
    advance("2026-10-20T09:00:00Z");
    company.tick();
    const assignments = company.view(id).assignments;
    expect(assignments).toHaveLength(2);
    for (const a of assignments) {
      expect(a).toMatchObject({ day: "2026-10-20", dispatched: true, status: "queued" });
      expect(app.store.getTask(a.taskId!)?.canEdit).toBe(false);
      expect(app.store.listRuns(a.taskId!)).toHaveLength(1);
      expect(app.store.listMessages(a.taskId!)[0]?.text).toContain(config.description);
    }
    advance("2026-10-24T12:00:00Z");
    expect(company.view(id).assignments).toHaveLength(2);
    // Finished or failed sessions permit today's work, without replaying missed days.
    for (const a of assignments) app.store.updateTask(a.taskId!, { status: "failed" });
    company.tick();
    expect(company.view(id).assignments.map((a) => a.day)).toEqual(["2026-10-24", "2026-10-24", "2026-10-20", "2026-10-20"]);
  });

  it("recovers an undispatched assignment after failure without creating duplicate tasks or messages", async () => {
    const { app, id, company, advance } = await setup();
    const send = vi.spyOn(app.runner, "send").mockImplementationOnce(() => {
      throw new Error("Temporary queue failure");
    });
    advance("2026-10-20T09:00:00Z");
    expect(company.view(id).error).toBe("Temporary queue failure");
    expect(company.view(id).assignments).toHaveLength(2);
    send.mockRestore();
    company.tick();
    expect(company.view(id).error).toBeNull();
    expect(company.view(id).assignments.every((a) => a.dispatched)).toBe(true);
    for (const a of company.view(id).assignments) expect(app.store.listMessages(a.taskId!)).toHaveLength(1);
    const dataDir = app.dataDir;
    await app.close();
    apps.pop();
    const reopened = await testApp(dataDir);
    apps.push(reopened);
    expect(reopened.company.view(id).config).toEqual(config);
    expect(reopened.company.view(id).assignments).toHaveLength(2);
  });

  it("preserves daily slots after task deletion and stops new assignments when disabled", async () => {
    const { app, id, company, advance } = await setup();
    advance("2026-10-20T09:00:00Z");
    const assignment = company.view(id).assignments[0]!;
    app.store.deleteTask(assignment.taskId!);
    company.tick();
    expect(company.view(id).assignments).toHaveLength(2);
    expect(company.view(id).assignments[0]?.taskId).toBeNull();
    company.configure(id, { ...config, enabled: false });
    advance("2026-10-21T09:00:00Z");
    expect(company.view(id).assignments).toHaveLength(2);
    app.store.deleteProject(id);
    expect(app.store.companyAssignments(id)).toEqual([]);
    expect(app.store.companyConfig(id)).toBeNull();
  });

  it("validates configuration and keeps unscheduled projects unchanged", async () => {
    const app = await testApp();
    apps.push(app);
    const id = await newProject(app);
    const url = `/api/projects/${id}/company`;
    expect((await api<CompanyView>(app, "GET", url)).body.config).toBeNull();
    for (const patch of [{ dailyHourUtc: 24 }, { description: " " }, { genre: "" }, { enabled: "true" }, { unknown: true }]) {
      expect((await api(app, "PUT", url, { ...config, ...patch })).status).toBe(400);
    }
    expect(app.store.listRoles(id)).toEqual([]);
    expect((await api(app, "PUT", url, { ...config, enabled: false })).status).toBe(200);
    expect(app.store.listTasks(id)).toEqual([]);
    expect((await api(app, "GET", "/api/projects/missing/company")).status).toBe(404);
  });

  it("requires evidence, labels unavailable play, and requests approval for spending or downtime", () => {
    for (const kind of ["director", "qa"] as const) {
      const prompt = dailyCompanyPrompt(config, kind, "2026-10-20");
      expect(prompt).toContain("NOT PLAYED");
      expect(prompt).toContain("build/commit");
      expect(prompt).toContain("do not present your judgment as human player feedback");
      expect(prompt).toContain("spending or live-service downtime");
    }
  });
});
