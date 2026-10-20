import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inboxKeys, type Inbox, type Project, type Studio } from "@ad/shared";
import type { App } from "../src/app.ts";
import { MAX_RETRIES } from "../src/health.ts";
import { STEWARD_ROLE } from "../src/steward.ts";
import { api, newProject, newTask, testApp, waitFor } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function stewardProject() {
  const app = await testApp();
  apps.push(app);
  const projectId = await newProject(app);
  expect((await api<Studio>(app, "POST", `/api/projects/${projectId}/studio/template`)).status).toBe(201);
  expect((await api<Project>(app, "PATCH", `/api/projects/${projectId}`, { inboxSteward: true })).body.inboxSteward).toBe(true);
  return { app, projectId, role: (name: string) => app.store.findRoleByName(projectId, name)! };
}

describe("inbox steward", () => {
  it("decides what it can on the owner's behalf and escalates the rest with its reason", async () => {
    const { app, projectId, role } = await stewardProject();
    // Design asks before creating tasks, so the follow-up waits in the inbox.
    const task = await newTask(app, projectId, {
      roleId: role("Systems Designer").id,
      title: "Combat pass",
      message: "[question] [proposal:design/game/combat.md] [task:Gameplay Programmer:6]",
    });
    await waitFor(() => {
      const items = app.store.stewardItems({ projectId });
      return items.length === 3 && items.every((i) => i.status !== "triaging");
    }, 30_000);

    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.questions).toEqual([]);
    expect(inbox.proposals).toEqual([]);
    expect(inbox.handoffs).toHaveLength(1);
    expect(inbox.stewardNotes[inboxKeys.handoff(inbox.handoffs[0]!)]).toBe("Fake steward decided handoff.\n\nRecommendation: Approve it.");
    expect(inbox.count).toBe(1);
    expect(inbox.steward.handled.map((i) => [i.kind, i.action]).sort()).toEqual([
      ["proposal", "accept"],
      ["question", "answer"],
    ]);

    // Its decisions went through the owner's own paths: the answer reached the agent, the proposal was committed.
    await waitFor(() => app.store.listMessages(task.id).some((m) => m.text.includes("Use a shield.")));
    expect(app.store.listMessages(task.id).find((m) => m.text.includes("Use a shield."))!.text).toContain("inbox steward, on the owner's behalf");
    const project = app.store.getProject(projectId)!;
    expect(fs.readFileSync(path.join(project.repoPath, "design/game/combat.md"), "utf8")).toContain("Proposed by the fake agent.");
    expect(fs.readFileSync(path.join(project.repoPath, "design/decisions.md"), "utf8")).toContain("accepted by the inbox steward");

    // The triage is closed and retained; the steward is a read-only role of its own.
    const steward = role(STEWARD_ROLE);
    expect(steward.canEdit).toBe(false);
    const triage = app.store.listTasks(projectId).filter((t) => t.roleId === steward.id);
    expect(triage.length).toBeGreaterThan(0);
    await waitFor(() => triage.every((t) => app.store.getTask(t.id)?.stage === "closed"));
  }, 60_000);

  it("leaves the owner's inbox alone on projects without it", async () => {
    const app = await testApp();
    apps.push(app);
    const projectId = await newProject(app);
    expect(app.store.getProject(projectId)!.inboxSteward).toBe(false);
    await api<Studio>(app, "POST", `/api/projects/${projectId}/studio/template`);
    const task = await newTask(app, projectId, {
      roleId: app.store.findRoleByName(projectId, "Systems Designer")!.id,
      title: "Combat pass",
      message: "[question]",
    });
    await waitFor(() => app.store.getTask(task.id)?.status === "waiting");
    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.questions).toHaveLength(1);
    expect(inbox.steward.triaging).toEqual([]);
    expect(app.store.stewardItems({ projectId })).toEqual([]);
    expect(app.store.findRoleByName(projectId, STEWARD_ROLE)).toBeNull();
  });
});

describe("inbox steward health watch", () => {
  it("retries a failing task, stops retrying at the cap and escalates what it cannot fix", async () => {
    const { app, projectId, role } = await stewardProject();
    const task = await newTask(app, projectId, { roleId: role("Systems Designer").id, title: "Broken pass", message: "[fail]" });
    // The fake steward retries while it may, then reports; with no dashboard project the report escalates.
    await waitFor(() => app.store.stewardItems({ projectId, status: "escalated" }).some((i) => i.kind === "failing"), 60_000);
    const failing = app.store.stewardItems({ projectId }).filter((i) => i.kind === "failing");
    expect(failing.filter((i) => i.action === "retry")).toHaveLength(MAX_RETRIES - 1);
    expect(app.store.listRuns(task.id).filter((r) => r.status === "failed")).toHaveLength(MAX_RETRIES);

    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.alerts).toHaveLength(1);
    expect(inbox.alerts[0]!.note).toContain("no project uses the AgentDashboard repository");
    expect(inbox.count).toBe(1);

    const key = inbox.alerts[0]!.key;
    expect((await api(app, "POST", `/api/projects/${projectId}/steward/alerts/dismiss`, { key })).status).toBe(204);
    expect((await api<Inbox>(app, "GET", "/api/inbox")).body.alerts).toEqual([]);
    expect((await api(app, "POST", `/api/projects/${projectId}/steward/alerts/dismiss`, { key })).status).toBe(404);
  }, 90_000);

  it("files a fix on the dashboard's own project when the cause is the dashboard", async () => {
    const { app, projectId, role } = await stewardProject();
    const dashboardId = await newProject(app);
    app.steward.dashboardRepo = app.store.getProject(dashboardId)!.repoPath;
    await newTask(app, projectId, { roleId: role("Systems Designer").id, title: "Broken pass", message: "[fail]" });
    await waitFor(() => app.store.stewardItems({ projectId }).some((i) => i.kind === "failing" && i.action === "report" && i.status === "handled"), 60_000);
    const fixes = app.store.listTasks(dashboardId);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.title).toMatch(/^Dashboard fix: "Broken pass" failed/);
    expect(fixes[0]!.roleId).toBeNull();
    expect(app.store.listMessages(fixes[0]!.id)[0]!.text).toContain("The run fails before the agent starts.");
  }, 90_000);
});
