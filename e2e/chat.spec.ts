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
  await expect(page.getByText("Opus 5.5 · medium").first()).toBeVisible();
  await page.getByText("Bash").click();
  await expect(page.getByText("nothing to commit, working tree clean")).toBeVisible();
  await page.screenshot({ path: "test-results/chat.png" });

  await page.getByRole("textbox", { name: "Message" }).fill("Make the warrior tankier");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText(/Continuing session/)).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill("Long job [slow]");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Still working \(2\)/)).toBeVisible();
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "↻ Retry" })).toBeVisible();

  // The task shows up in the project's list with its cost.
  await page.getByRole("navigation").getByRole("link", { name: "Idle Quest" }).click();
  await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
  await expect(page.getByText("Design three starter classes [tool]", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/tasks.png" });
});

test("settings find the demo agent", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Save and check Claude Code" }).click();
  await expect(page.getByText(/Found 0.0.0 \(Fake Claude Code\)/)).toBeVisible();
});
