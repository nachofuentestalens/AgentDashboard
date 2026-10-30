import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, DocDetail, DesignDoc, FeedbackItem, Inbox, Role, Run, Studio, Task } from "@ad/shared";
import type { App } from "../src/app.ts";
import { api, git, gitRepo, latestRun, newProject, newTask, reply, stepFinished, taskReaches, tempDir, testApp, waitFor } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const start = async (dataDir?: string) => {
  const app = await testApp(dataDir);
  apps.push(app);
  return app;
};

// A project staffed with the template, and a way to find its roles by name.
async function studioProject(app: App, repo = gitRepo()) {
  const projectId = await newProject(app, repo);
  const res = await api<Studio>(app, "POST", `/api/projects/${projectId}/studio/template`);
  expect(res.status).toBe(201);
  const role = (name: string) => app.store.findRoleByName(projectId, name)!;
  return { projectId, repo, role };
}

const roleTask = async (app: App, projectId: string, role: Role, message: string, extra: Record<string, unknown> = {}) =>
  newTask(app, projectId, { roleId: role.id, message, ...extra });

const notices = (app: App, runId: string) =>
  app.runner
    .readEvents(runId)
    .flatMap((e) => (e.event.kind === "notice" && !/^(Task assessment:|Isolated worktree:|Saved local checkpoint)/.test(e.event.text) ? [e.event] : []));

describe("studio structure", () => {
  it("applies the template once, with departments, roles and staffed seats", async () => {
    const app = await start();
    const { projectId } = await studioProject(app);
    const studio = (await api<Studio>(app, "GET", `/api/projects/${projectId}/studio`)).body;
    expect(studio.departments.map((d) => [d.name, d.weight, d.folders])).toEqual([
      ["Leadership", 3, ["design/studio"]],
      ["Engineering", 5, ["."]],
      ["Design", 3, ["design/game"]],
      ["QA", 2, ["qa"]],
    ]);
    const roles = studio.departments.flatMap((d) => d.roles);
    expect(roles.find((r) => r.name === "CTO")).toMatchObject({ model: "claude-sonnet-5", effort: "medium" });
    expect(roles.find((r) => r.name === "Gameplay Programmer")!.agents.map((a) => a.name)).toEqual(["Gameplay Programmer"]);
    expect(roles.find((r) => r.name === "Narrative Designer")!.agents).toEqual([]);
    expect((await api(app, "POST", `/api/projects/${projectId}/studio/template`)).status).toBe(409);
  });

  it("hires and removes agents, archiving those with history", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const qa = role("QA Tester");
    const hired = await api<Agent>(app, "POST", `/api/roles/${qa.id}/agents`, {});
    expect(hired.body.name).toBe("QA Tester 2");

    const task = await roleTask(app, projectId, qa, "check the build");
    await stepFinished(app, task.id);
    const worker = latestRun(app, task.id).agentId!;
    const staff = app.store.listAgents(projectId).filter((a) => a.roleId === qa.id);
    expect(staff.map((a) => a.id)).toContain(hired.body.id);
    for (const agent of staff) expect((await api(app, "DELETE", `/api/agents/${agent.id}`)).status).toBe(204);
    // The agent that worked is archived: gone from the studio, still named on its run. The idle
    // one is deleted outright.
    expect(app.store.listAgents(projectId).filter((a) => a.roleId === qa.id)).toEqual([]);
    expect(app.store.agentName(worker)).toBeTruthy();
    expect(app.store.getAgent(staff.find((a) => a.id !== worker)!.id)).toBeNull();
  });

  it("validates departments and roles", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const dept = app.store.listDepartments(projectId)[0]!;
    expect((await api(app, "PATCH", `/api/departments/${dept.id}`, { folders: ["../outside"] })).status).toBe(400);
    expect((await api(app, "PATCH", `/api/departments/${dept.id}`, { weight: 11 })).status).toBe(400);
    expect((await api(app, "PATCH", `/api/roles/${role("CTO").id}`, { name: "game director" })).status).toBe(409);
    expect((await api(app, "PATCH", `/api/roles/${role("CTO").id}`, { allowedTools: ['Bash(rm -rf "/")'] })).status).toBe(400);
    expect((await api(app, "DELETE", `/api/departments/${dept.id}`)).status).toBe(409);
  });
});

describe("role tasks", () => {
  it("run with the role's model, effort, preamble file and folder rules, and finish as done", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const task = await roleTask(app, projectId, role("QA Tester"), "Check the build [args] [sysprompt] [context]");
    expect(["queued", "running"]).toContain(task.status);
    expect(task.canEdit).toBe(true);
    const done = await stepFinished(app, task.id);
    const run = latestRun(app, task.id);
    expect(run).toMatchObject({ status: "succeeded", model: "claude-sonnet-5", effort: "low", roleId: role("QA Tester").id });
    expect(run.agentId).toBe(done.agentId);

    const text = app.store
      .listMessages(task.id)
      .filter((m) => m.role === "assistant")
      .map((m) => m.text)
      .join("\n");
    const events = app.runner
      .readEvents(run.id)
      .flatMap((e) => (e.event.kind === "text" ? [e.event.text] : []))
      .join("\n");
    expect(events).toContain("(can edit qa) as QA Tester (QA) with studio context");
    expect(events).toContain("System prompt: You are QA Tester, the QA Tester in the QA department");
    expect(events).toContain("Team (use these exact role names in task blocks):");
    expect(events).toContain("This task:");
    const args = JSON.parse(events.match(/Arguments: (\[.*\])/)![1]!) as string[];
    expect(args).toContain("--append-system-prompt-file");
    expect(args.join(" ")).toContain("--permission-mode default --allowedTools Edit(./qa/**)");
    expect(args.join(" ")).toContain("--disallowedTools Edit(./design/decisions.md)");
    // Nothing anyone wrote reaches the process arguments.
    for (const words of ["Check the build", "check the build", "test plans", "QA Tester"]) expect(args.join(" ")).not.toContain(words);
    expect(text).toBeTruthy();
    // The preamble file is removed once the run ends.
    expect(fs.readdirSync(path.join((app as App & { dataDir: string }).dataDir, "prompts"))).toEqual([]);
  });

  it("lets a '.' department edit everywhere except other departments' folders", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const task = await roleTask(app, projectId, role("Gameplay Programmer"), "Fix it [args]");
    await stepFinished(app, task.id);
    const args = reply(app, task.id);
    expect(args).toContain('"--permission-mode","acceptEdits"');
    expect(args).toContain('"--disallowedTools","Edit(./design/studio/**)","Edit(./design/game/**)","Edit(./qa/**)","Edit(./design/decisions.md)"');
  });

  it("runs one writing agent per department at a time", async () => {
    const app = await start();
    await api(app, "PATCH", "/api/settings", { maxConcurrentRuns: { claude: 3 } });
    const { projectId, role } = await studioProject(app);
    const prog = role("Gameplay Programmer");
    await api(app, "POST", `/api/roles/${prog.id}/agents`, {});
    const first = await roleTask(app, projectId, prog, "long job [slow]");
    await taskReaches(app, first.id, ["running"]);
    const second = await roleTask(app, projectId, prog, "another job");
    await waitFor(() => !!latestRun(app, second.id).waitReason);
    expect(latestRun(app, second.id).waitReason).toMatch(/Engineering already has an agent editing files/);
    // Another department's writer is not held up.
    const qa = await roleTask(app, projectId, role("QA Tester"), "review");
    await stepFinished(app, qa.id);

    await api(app, "POST", `/api/runs/${latestRun(app, first.id).id}/stop`);
    await stepFinished(app, second.id);
  });

  it("starts higher priorities first when slots are scarce", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    await api(app, "PATCH", "/api/settings", { maxConcurrentRuns: { claude: 1 } });
    const chat = await newTask(app, projectId, { message: "[slow]" });
    const qa = role("QA Tester");
    await api(app, "POST", `/api/roles/${qa.id}/agents`, {});
    await api(app, "POST", `/api/roles/${qa.id}/agents`, {});
    const tasks: Task[] = [];
    for (const p of [2, 9, 5]) tasks.push(await roleTask(app, projectId, qa, `priority ${p} [slow]`, { priority: p, canEdit: false }));
    await waitFor(() => tasks.every((t) => latestRun(app, t.id).waitReason));
    expect(latestRun(app, tasks[0]!.id).waitReason).toMatch(/Waiting for a free Claude slot \(1 of 1/);

    await api(app, "POST", `/api/runs/${latestRun(app, chat.id).id}/stop`);
    await taskReaches(app, tasks[1]!.id, ["running"]);
    expect(app.store.getTask(tasks[0]!.id)!.status).toBe("queued");
    expect(app.store.getTask(tasks[2]!.id)!.status).toBe("queued");
    await api(app, "POST", `/api/runs/${latestRun(app, tasks[1]!.id).id}/stop`);
    await taskReaches(app, tasks[2]!.id, ["running"]);
    expect(app.store.getTask(tasks[0]!.id)!.status).toBe("queued");
    for (const t of tasks) await api(app, "POST", `/api/runs/${latestRun(app, t.id).id}/stop`);
  });

  it("starts emergencies past full slots and pauses the project's other work until they are done", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    await api(app, "PATCH", "/api/settings", { maxConcurrentRuns: { claude: 1 } });
    const chat = await newTask(app, projectId, { message: "[slow]" });
    const waiting = await roleTask(app, projectId, role("QA Tester"), "routine check", { priority: 10 });
    await waitFor(() => !!latestRun(app, waiting.id).waitReason);

    const fire = await roleTask(app, projectId, role("Gameplay Programmer"), "Fix the build [slow]", { emergency: true });
    await taskReaches(app, fire.id, ["running"]);
    await waitFor(() => /emergency task/.test(latestRun(app, waiting.id).waitReason ?? ""));
    // A free slot is not enough while the emergency is open, even after it was stopped.
    await api(app, "POST", `/api/runs/${latestRun(app, chat.id).id}/stop`);
    await api(app, "POST", `/api/runs/${latestRun(app, fire.id).id}/stop`);
    await taskReaches(app, fire.id, ["idle"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(app.store.getTask(waiting.id)!.status).toBe("queued");
    expect((await api<Studio>(app, "GET", `/api/projects/${projectId}/studio`)).body.emergencies).toEqual([{ taskId: fire.id, title: fire.title }]);

    expect((await api<Task>(app, "PATCH", `/api/tasks/${fire.id}`, { done: true })).body).toMatchObject({ status: "idle", stage: "closed" });
    await stepFinished(app, waiting.id);
  });

  it("lets agents raise emergencies for other roles", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    await api(app, "PATCH", `/api/departments/${role("QA Tester").departmentId}`, { autonomy: "auto" });
    const reporter = await roleTask(app, projectId, role("QA Tester"), "The build is red [emergency:Gameplay Programmer]");
    await stepFinished(app, reporter.id);
    const emergency = app.store.listTasks(projectId).find((t) => t.emergency)!;
    expect(emergency).toMatchObject({ priority: 10, roleId: role("Gameplay Programmer").id, parentTaskId: reporter.id, depth: 1 });
    await stepFinished(app, emergency.id);
    expect(app.store.openEmergencies(projectId)).toEqual([]);
  });

  it("holds a department over its budget until the owner runs it anyway", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const qa = role("QA Tester");
    await api(app, "PATCH", `/api/departments/${qa.departmentId}`, { dailyBudgetUsd: 1 });
    const expensive = await roleTask(app, projectId, qa, "big check [cost:1.5]");
    await stepFinished(app, expensive.id);
    const next = await roleTask(app, projectId, qa, "another check");
    await waitFor(() => !!latestRun(app, next.id).waitReason);
    expect(latestRun(app, next.id).waitReason).toMatch(/QA reached its daily budget \(\$1\.50 of \$1\.00\)/);
    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.held.map((h) => h.task.id)).toEqual([next.id]);
    expect((await api<Run>(app, "POST", `/api/runs/${latestRun(app, next.id).id}/force`)).status).toBe(200);
    await stepFinished(app, next.id);
  });

  it("keeps queued runs across a restart and starts them", async () => {
    const dataDir = tempDir("ad-data-");
    const first = await start(dataDir);
    const { projectId, role } = await studioProject(first);
    await api(first, "PATCH", "/api/settings", { maxConcurrentRuns: { claude: 1 } });
    const chat = await newTask(first, projectId, { message: "[slow]" });
    const queued = await roleTask(first, projectId, role("QA Tester"), "after the restart");
    await waitFor(() => !!latestRun(first, queued.id).waitReason);
    // Close while the chat still holds the only slot: the next server finds the run still queued.
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await start(dataDir);
    expect(second.store.getRun(latestRun(second, chat.id).id)!.status).toBe("interrupted");
    expect(["queued", "running", "idle"]).toContain(second.store.getTask(queued.id)!.status);
    await stepFinished(second, queued.id);
  });
});

describe("what agents ask for", () => {
  it("creates tasks right away for departments on auto, with priority, parent and depth", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    await api(app, "PATCH", `/api/departments/${role("QA Tester").departmentId}`, { autonomy: "auto" });
    const qa = await roleTask(app, projectId, role("QA Tester"), "Found a bug [task:Gameplay Programmer:8]");
    await stepFinished(app, qa.id);
    const created = app.store.listTasks(projectId).find((t) => t.parentTaskId === qa.id)!;
    expect(created).toMatchObject({ roleId: role("Gameplay Programmer").id, priority: 8, depth: 1, createdByRoleId: role("QA Tester").id });
    expect(notices(app, latestRun(app, qa.id).id).find((n) => n.text.startsWith("Created task"))!.text).toMatch(
      /Created task "Follow-up for Gameplay Programmer" for Gameplay Programmer \(priority 8\/10\)/,
    );
    await stepFinished(app, created.id);
  });

  it("sends tasks to the inbox when the department asks first, the role is unknown or delegation is too deep", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const designer = await roleTask(app, projectId, role("Systems Designer"), "Ready [task:Gameplay Programmer:3] [task:Composer]");
    await stepFinished(app, designer.id);
    const deep = app.studio.createTask({ projectId, roleId: role("QA Tester").id, title: "deep", message: "go [task:Gameplay Programmer]", depth: 2 });
    await stepFinished(app, deep.id);

    // Higher priorities first, then oldest.
    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.handoffs.map((h) => [h.toRoleName, h.priority, h.reason])).toEqual([
      ["Composer", 5, 'Waiting for you: there is no role called "Composer".'],
      ["Gameplay Programmer", 5, "Waiting for you: it would be 3 levels of delegation deep; the limit is 2."],
      ["Gameplay Programmer", 3, "Waiting for you: Design asks before creating tasks."],
    ]);
    const unknown = inbox.handoffs.find((h) => h.toRoleName === "Composer")!;
    expect((await api(app, "POST", `/api/handoffs/${unknown.id}/approve`, {})).status).toBe(400);
    const approved = await api<Task>(app, "POST", `/api/handoffs/${unknown.id}/approve`, { roleId: role("Narrative Designer").id, priority: 6 });
    expect(approved.body).toMatchObject({ roleId: role("Narrative Designer").id, priority: 6, parentTaskId: designer.id });
    // Nobody staffs the role yet, so it waits and says why.
    await waitFor(() => !!latestRun(app, approved.body.id).waitReason);
    expect(latestRun(app, approved.body.id).waitReason).toMatch(/No Narrative Designer agent/);
    const rejected = inbox.handoffs[2]!;
    expect((await api(app, "POST", `/api/handoffs/${rejected.id}/reject`)).status).toBe(204);
    expect((await api<Inbox>(app, "GET", "/api/inbox")).body.handoffs).toHaveLength(1);
  });

  it("turns proposals into commits with a decision entry, and tells the agent about rejections", async () => {
    const app = await start();
    const { projectId, repo, role } = await studioProject(app);
    const task = await roleTask(app, projectId, role("Gameplay Programmer"), "Spec is unclear [proposal:design/game/combat.md] [proposal:../escape.md]");
    await stepFinished(app, task.id);
    const shown = notices(app, latestRun(app, task.id).id);
    expect(shown.map((n) => n.level)).toEqual(["info", "warn"]);

    const inbox = (await api<Inbox>(app, "GET", "/api/inbox")).body;
    expect(inbox.proposals).toHaveLength(1);
    expect(inbox.proposals[0]).toMatchObject({ docPath: "design/game/combat.md", roleName: "Gameplay Programmer", current: null });
    const accepted = await api<{ commitError: string | null }>(app, "POST", `/api/proposals/${inbox.proposals[0]!.id}/accept`, {
      body: "# Combat\n\nOwner's version.\n",
    });
    expect(accepted.body.commitError).toBeNull();
    expect(fs.readFileSync(path.join(repo, "design", "game", "combat.md"), "utf8")).toBe("# Combat\n\nOwner's version.\n");
    expect(fs.readFileSync(path.join(repo, "design", "decisions.md"), "utf8")).toMatch(
      /design\/game\/combat\.md updated\n\nProposed by Gameplay Programmer and edited by the owner/,
    );
    expect(git(repo, "log", "--format=%s")).toBe("Update design/game/combat.md (proposal by Gameplay Programmer)");
    expect(git(repo, "status", "--porcelain")).toBe("");

    const again = await roleTask(app, projectId, role("Gameplay Programmer"), "Try again [proposal:design/game/loot.md]");
    await stepFinished(app, again.id);
    const proposal = app.store.pendingProposals()[0]!;
    await api(app, "POST", `/api/proposals/${proposal.id}/reject`, { reason: "Loot is out of scope" });
    await waitFor(() => app.store.listMessages(again.id).some((m) => m.text.includes("rejected your proposal for design/game/loot.md: Loot is out of scope")));
    await stepFinished(app, again.id);
    expect((await api(app, "POST", `/api/proposals/${proposal.id}/accept`, {})).status).toBe(409);
  });

  it("pauses on a question until the owner answers, and can record the answer", async () => {
    const app = await start();
    const { projectId, repo, role } = await studioProject(app);
    const task = await roleTask(app, projectId, role("Systems Designer"), "Design the warrior [question] [badblock]");
    const waiting = await taskReaches(app, task.id, ["waiting"]);
    expect(waiting.question).toBe("Should the warrior use a shield?");
    expect(notices(app, latestRun(app, task.id).id).map((n) => n.level)).toEqual(["warn", "info"]);
    expect((await api<Inbox>(app, "GET", "/api/inbox")).body.questions.map((q) => q.task.id)).toEqual([task.id]);

    const answered = await api<{ run: Run }>(app, "POST", `/api/tasks/${task.id}/answer`, { text: "Yes, a small one.", record: true });
    expect(answered.status).toBe(201);
    await stepFinished(app, task.id);
    expect(app.store.getTask(task.id)!.question).toBeNull();
    expect(fs.readFileSync(path.join(repo, "design", "decisions.md"), "utf8")).toMatch(
      /Systems Designer asked:\n\n> Should the warrior use a shield\?\n\nThe owner answered:\n\nYes, a small one\./,
    );
    expect((await api(app, "POST", `/api/tasks/${task.id}/answer`, { text: "again" })).status).toBe(409);
  });
});

describe("design documents", () => {
  it("lists, reads and saves documents with history, inside design/ only", async () => {
    const app = await start();
    const { projectId, repo } = await studioProject(app);
    const saved = await api<{ commitError: string | null }>(app, "PUT", `/api/projects/${projectId}/docs/file`, {
      path: "design/studio/vision.md",
      content: "# Vision\n\nA cozy idle game about tending a lighthouse.",
    });
    expect(saved.body.commitError).toBeNull();
    const docs = (await api<DesignDoc[]>(app, "GET", `/api/projects/${projectId}/docs`)).body;
    const leadership = app.store.listDepartments(projectId).find((d) => d.name === "Leadership")!;
    expect(docs).toEqual([
      expect.objectContaining({
        path: "design/studio/vision.md",
        title: "Vision",
        summary: "A cozy idle game about tending a lighthouse.",
        departmentId: leadership.id,
      }),
    ]);
    const detail = (await api<DocDetail>(app, "GET", `/api/projects/${projectId}/docs/file?path=design/studio/vision.md`)).body;
    expect(detail.content).toContain("lighthouse");
    expect(detail.history.map((c) => c.subject)).toEqual(["Edit design/studio/vision.md"]);
    expect(git(repo, "status", "--porcelain")).toBe("");

    expect((await api(app, "PUT", `/api/projects/${projectId}/docs/file`, { path: "../evil.md", content: "x" })).status).toBe(400);
    expect((await api(app, "PUT", `/api/projects/${projectId}/docs/file`, { path: "design/decisions.md", content: "x" })).status).toBe(400);
    expect((await api(app, "GET", `/api/projects/${projectId}/docs/file?path=design/missing.md`)).status).toBe(404);
  });
});

describe("feedback", () => {
  it("collects feedback and hands a selection to a role for triage", async () => {
    const app = await start();
    const { projectId, role } = await studioProject(app);
    const added = await api<FeedbackItem[]>(app, "POST", `/api/projects/${projectId}/feedback`, {
      items: [{ text: "The lighthouse upgrades feel slow", source: "Steam" }, { text: "Love the music" }],
    });
    expect(added.status).toBe(201);
    const director = role("Game Director");
    const triage = await api<Task>(app, "POST", `/api/projects/${projectId}/feedback/triage`, { itemIds: added.body.map((f) => f.id), roleId: director.id });
    expect(triage.body).toMatchObject({ title: "Triage 2 feedback items", roleId: director.id });
    const items = (await api<FeedbackItem[]>(app, "GET", `/api/projects/${projectId}/feedback`)).body;
    expect(items.every((f) => f.status === "triaged" && f.taskId === triage.body.id)).toBe(true);
    await stepFinished(app, triage.body.id);
    const prompt = app.store.listMessages(triage.body.id)[0]!.text;
    expect(prompt).toContain("1. (Steam) The lighthouse upgrades feel slow");
    expect(prompt).not.toContain("owner's own requirements");

    // The owner's own notes are requirements to build, not opinions to defer.
    const own = await api<FeedbackItem[]>(app, "POST", `/api/projects/${projectId}/feedback`, { items: [{ text: "Add a codex tab", source: "Owner" }] });
    const ownTriage = await api<Task>(app, "POST", `/api/projects/${projectId}/feedback/triage`, { itemIds: own.body.map((f) => f.id), roleId: director.id });
    await stepFinished(app, ownTriage.body.id);
    expect(app.store.listMessages(ownTriage.body.id)[0]!.text).toMatch(/owner's own requirements[\s\S]*do not defer them/);
  });
});

describe("plain chats", () => {
  it("still start at once and never become emergencies", async () => {
    const app = await start();
    const projectId = await newProject(app);
    await api(app, "PATCH", "/api/settings", { maxConcurrentRuns: { claude: 1 } });
    const a = await newTask(app, projectId, { message: "[slow]", emergency: true });
    const b = await newTask(app, projectId, { message: "hello" });
    expect(a).toMatchObject({ status: "running", emergency: false, roleId: null });
    expect(b.status).toBe("running");
    await taskReaches(app, b.id, ["idle"]);
    await api(app, "POST", `/api/runs/${latestRun(app, a.id).id}/stop`);
  });
});
