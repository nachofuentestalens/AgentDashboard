import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function newProject(request: APIRequestContext, name: string): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-e2e-studio-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const res = await request.post("/api/projects", { data: { name, repoPath: repo } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("staff a studio, give a role a task, accept its proposal, watch the queue", async ({ page, request }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const projectId = await newProject(request, "Lighthouse");

  // Studio: apply the template, hire and fire.
  await page.goto(`/projects/${projectId}/studio`);
  await page.getByRole("button", { name: "Apply the Small indie studio template" }).click();
  const engineering = page.getByRole("region", { name: "Engineering department" });
  await expect(engineering).toBeVisible();
  await expect(page.getByRole("listitem", { name: "CTO role" })).toContainText("Sonnet 5 · medium");
  await page.getByRole("button", { name: "Hire a QA Tester" }).click();
  await expect(page.getByRole("button", { name: "Remove QA Tester 2" })).toBeVisible();
  await page.getByRole("button", { name: "Remove QA Tester 2" }).click();
  await expect(page.getByRole("button", { name: "Remove QA Tester 2" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/studio.png", fullPage: true });

  // A task for a role, with a priority: it queues, runs, and sends a proposal to the inbox.
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("combobox", { name: "Assign to" }).selectOption({ label: "Gameplay Programmer" });
  await page.getByRole("combobox", { name: "Priority" }).selectOption("8");
  await page.getByRole("textbox", { name: "Message" }).fill("The combat spec is unclear [proposal:design/game/combat.md]");
  await page.getByRole("button", { name: "Queue task" }).click();
  await expect(page.getByText("P8")).toBeVisible();
  await expect(page.getByText("Proposal for design/game/combat.md sent to the owner's inbox.")).toBeVisible();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: /^Inbox/ }).click();
  const proposal = page.getByRole("article", { name: "Proposal for design/game/combat.md" });
  await expect(proposal).toContainText("Proposed by the fake agent.");
  await page.screenshot({ path: "test-results/inbox.png", fullPage: true });
  await proposal.getByRole("button", { name: "Accept" }).click();
  // The task's finished step also waits for review.
  await page
    .getByRole("article", { name: /^Review:/ })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();

  await page.goto(`/projects/${projectId}/docs`);
  await page.getByRole("button", { name: /game\/combat\.md/ }).click();
  await expect(page.getByText("Proposed by the fake agent.")).toBeVisible();
  await expect(page.getByText("owned by Design")).toBeVisible();

  // One slot, held by a chat: the role's task waits and says why.
  await page.goto("/compute");
  await page.getByRole("spinbutton", { name: /^Claude agents at once/ }).fill("1");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const chat = await request.post(`/api/projects/${projectId}/tasks`, { data: { message: "[slow]" } });
  const qa = (await (await request.get(`/api/projects/${projectId}/studio`)).json()) as { departments: { roles: { id: string; name: string }[] }[] };
  const qaRole = qa.departments.flatMap((d) => d.roles).find((r) => r.name === "QA Tester")!;
  await request.post(`/api/projects/${projectId}/tasks`, { data: { roleId: qaRole.id, message: "Run the smoke test", priority: 9 } });
  await expect(page.getByText(/Waiting for a free Claude slot \(1 of 1 running\)/)).toBeVisible();
  await expect(page.getByRole("meter", { name: "QA spend" })).toBeVisible();
  await page.screenshot({ path: "test-results/compute.png", fullPage: true });

  const chatTask = (await chat.json()) as { id: string };
  const runs = ((await (await request.get(`/api/tasks/${chatTask.id}`)).json()) as { runs: { id: string }[] }).runs;
  await request.post(`/api/runs/${runs[0]!.id}/stop`);
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
});

test("review a finished step with an agent from the board, fix, approve and close", async ({ page, request }) => {
  const projectId = await newProject(request, "Stage Coast");
  await request.post(`/api/projects/${projectId}/studio/template`);
  const studio = (await (await request.get(`/api/projects/${projectId}/studio`)).json()) as { departments: { roles: { id: string; name: string }[] }[] };
  const qa = studio.departments.flatMap((d) => d.roles).find((r) => r.name === "QA Tester")!;
  const created = await request.post(`/api/projects/${projectId}/tasks`, {
    data: { roleId: qa.id, title: "Dash ability", message: "Add dash [plan] [step-done] [review-changes]" },
  });
  const dash = (await created.json()) as { id: string };
  await request.post(`/api/projects/${projectId}/tasks`, { data: { roleId: qa.id, title: "Later work" } });

  await page.goto(`/projects/${projectId}`);
  const banner = page.getByLabel("Next up");
  await expect(banner).toContainText("Dash ability");
  await expect(page.getByRole("list", { name: "Needs you" })).toContainText("Fake step done.");
  await expect(page.getByRole("list", { name: "Needs you" })).toContainText("1/3");
  await expect(page.getByRole("list", { name: "Up next" })).toContainText("Later work");
  await page.screenshot({ path: "test-results/board.png", fullPage: true });

  // A read-only review by the same role finds a problem; Fix sends it back to the author.
  await banner.getByRole("button", { name: "Review with QA Tester" }).click();
  await expect(page.getByRole("list", { name: "Needs you" })).toContainText("Agent review: changes");
  await page.goto(`/tasks/${dash.id}`);
  await expect(page.getByText("Agent review (QA Tester): changes requested")).toBeVisible();
  await expect(page.getByText("Review requested from QA Tester.")).toBeVisible();
  await page.getByRole("button", { name: "Fix" }).click();
  await expect(page.getByText("Address these review findings:")).toBeVisible();
  await expect(page.getByText("Needs review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("paste feedback and triage it with the Game Director", async ({ page, request }) => {
  const projectId = await newProject(request, "Feedback Isle");
  await request.post(`/api/projects/${projectId}/studio/template`);
  await page.goto(`/projects/${projectId}/feedback`);
  await page.getByRole("textbox", { name: "Feedback" }).fill("Upgrades feel slow\n\nLove the music");
  await page.getByRole("textbox", { name: "Source" }).fill("Discord");
  await page.getByRole("button", { name: "Add 2 items" }).click();
  await page.getByRole("checkbox", { name: /Upgrades feel slow/ }).check();
  await page.getByRole("checkbox", { name: /Love the music/ }).check();
  await page.getByRole("button", { name: "Triage with Game Director" }).click();
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue("Triage 2 feedback items");
  await expect(page.getByText("(Discord) Upgrades feel slow")).toBeVisible();
});

test("a desktop alert and the tab title say when something new waits on you", async ({ page, request }) => {
  // A stand-in Notification records what would be shown, and the window reports no focus, as when
  // the owner is in another app.
  await page.addInitScript(() => {
    const shown: { title: string; body: string }[] = [];
    (window as unknown as { shown: typeof shown }).shown = shown;
    class FakeNotification {
      static permission = "default";
      static requestPermission() {
        FakeNotification.permission = "granted";
        return Promise.resolve("granted");
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body: string }) {
        shown.push({ title, body: options.body });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification });
    document.hasFocus = () => false;
  });
  const projectId = await newProject(request, "Alert Bay");
  await request.post(`/api/projects/${projectId}/studio/template`);
  const studio = (await (await request.get(`/api/projects/${projectId}/studio`)).json()) as { departments: { roles: { id: string; name: string }[] }[] };
  const qa = studio.departments.flatMap((d) => d.roles).find((r) => r.name === "QA Tester")!;

  await page.goto("/");
  await page.getByRole("button", { name: "Turn on desktop alerts" }).click();
  await expect(page.getByRole("button", { name: "Desktop alerts on" })).toBeVisible();
  const shown = () => page.evaluate(() => (window as unknown as { shown: { body: string }[] }).shown.map((n) => n.body));

  const created = await request.post(`/api/projects/${projectId}/tasks`, {
    data: { roleId: qa.id, title: "Smoke test the alerts", message: "check [step-done]" },
  });
  await expect.poll(shown).toContain('"Smoke test the alerts" is ready for review');
  await expect(page).toHaveTitle(/^\(\d+\) AgentDashboard$/);
  // Closing it takes it off the inbox and out of the title count.
  const task = (await created.json()) as { id: string };
  await request.patch(`/api/tasks/${task.id}`, { data: { done: true } });
});
