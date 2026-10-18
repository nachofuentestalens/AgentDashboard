import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("restart waits for saved agents, comes back, and continues the same session", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-restart-e2e-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const project = await (await request.post("/api/projects", { data: { name: "Restart test", repoPath: repo } })).json();
  await page.goto(`/projects/${project.id}`);
  // This natural turn lasts long enough to inspect the disabled confirmation.
  const task = await (
    await request.post(`/api/projects/${project.id}/tasks`, { data: { message: "Please check these details before finishing: " + "detail ".repeat(45) } })
  ).json();
  await page.getByRole("button", { name: "Request server restart", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Restart server", exact: true });
  await expect(confirm).toBeDisabled();
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/restart-ready.png" });
  const before = await (await request.get(`/api/tasks/${task.id}`)).json();
  expect(before.task.handoff).toContain("GOAL");
  await confirm.click();
  await expect(page.getByRole("button", { name: "Request server restart", exact: true })).toBeEnabled({ timeout: 30_000 });
  const after = await (await request.get(`/api/tasks/${task.id}`)).json();
  expect(after.task.sessionId).toBe(before.task.sessionId);
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue after the server restart");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Continuing session/).last()).toBeVisible();
});
