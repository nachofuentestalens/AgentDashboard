import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("create a project, chat with the agent, resume, stop and retry", async ({ page }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-e2e-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your game projects" })).toBeVisible();
  await page.getByRole("button", { name: "Create your first project" }).click();
  await page.getByPlaceholder("Idle Quest").fill("Idle Quest");
  await page.getByPlaceholder(/Projects/).fill(repo);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: "Idle Quest" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Design three starter classes [tool]");
  await page.getByRole("button", { name: "Start chat" }).click();

  await expect(page.getByText('You said: "Design three starter classes [tool]"')).toBeVisible();
  await expect(page.getByText("Bash")).toBeVisible();
  await expect(page.getByText("The working tree is clean.")).toBeVisible();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Task workspace")).toContainText("Isolated branch: agent/task-");
  await expect(page.getByLabel("Task workspace")).toContainText("Local checkpoint:");
  await page.getByRole("button", { name: "Preview project worktree cleanup" }).click();
  await expect(page.getByLabel("Worktree cleanup preview")).toContainText("Cleanup blocked.");
  await expect(page.getByLabel("Worktree cleanup preview")).toContainText("No verified Git delivery");
  await expect(page.getByRole("button", { name: /^Remove eligible worktree/ })).toHaveCount(0);
  await expect(page.getByText("Sonnet 5 · medium").first()).toBeVisible();
  await page.getByText("Bash").click();
  await expect(page.getByText("nothing to commit, working tree clean")).toBeVisible();
  await page.screenshot({ path: "test-results/chat.png" });

  await page.getByRole("textbox", { name: "Message" }).fill("Make the warrior tankier");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText(/Continuing session/)).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill("Long job [slow]");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Still working \(2\)/)).toBeVisible();
  await page.getByRole("button", { name: "Pause & checkpoint" }).click();
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save checkpoint" })).toBeEnabled();
  await page.getByRole("button", { name: "Save checkpoint" }).click();
  await expect(page.getByLabel("Task workspace")).toContainText("Not published to GitHub.");
  await expect(page.getByRole("button", { name: "↻ Retry" })).toBeVisible();

  // The task shows up in the project's list with its cost.
  // Unsent text survives switching between the task and the project.
  await page.getByRole("textbox", { name: "Message" }).fill("Half-written reply");
  await page.getByRole("navigation").getByRole("link", { name: "Idle Quest" }).click();
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("textbox", { name: "Message" }).fill("Half-written brief");
  await expect(page.getByRole("link", { name: /Design three starter classes/ })).toBeVisible();
  await page.screenshot({ path: "test-results/tasks.png" });
  await page.getByRole("link", { name: /Design three starter classes/ }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Half-written reply");
  await page.getByRole("navigation").getByRole("link", { name: "Idle Quest" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Half-written brief");

  // A task push must refresh workspace metadata even when no run or publish operation finished.
  await page.getByRole("link", { name: /Design three starter classes/ }).click();
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByLabel("Task workspace")).toContainText("Not published to GitHub.");
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({ json: { ...detail, workspace: { ...detail.workspace, mergeCommit: "abc1234" } } });
  });
  const updated = await page.request.patch(`/api/tasks/${taskId}`, { data: { title: "Externally merged task" } });
  expect(updated.ok()).toBe(true);
  await expect(page.getByLabel("Task workspace")).toContainText("Merged as abc1234");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Half-written reply");
});

test("settings find the demo agent", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Save and check Claude Code" }).click();
  await expect(page.getByText(/Found 0.0.0 \(Fake Claude Code\)/)).toBeVisible();
});
