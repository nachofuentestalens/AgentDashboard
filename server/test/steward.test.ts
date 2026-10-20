import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inboxKeys, type Inbox, type Project, type Studio } from "@ad/shared";
import type { App } from "../src/app.ts";
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
