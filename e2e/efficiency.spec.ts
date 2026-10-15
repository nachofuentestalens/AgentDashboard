import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("review a handoff, start a fresh session and retain usage controls", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-efficiency-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const project = await (await request.post("/api/projects", { data: { name: "Efficient project", repoPath: repo } })).json();
  const task = await (await request.post(`/api/projects/${project.id}/tasks`, { data: { message: "Investigate files [tool]" } })).json();
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/fresh in.*cached in.*cache write/)).toBeVisible();
  await page.getByText(/Context & usage/).click();
  await page.getByLabel("Task tool-call allowance").fill("20");
  await page.getByRole("button", { name: "Save usage controls" }).click();
  await page.getByRole("button", { name: "Prepare handoff", exact: true }).click();
  await expect(page.getByLabel("Compact handoff")).toHaveValue(/GOAL/, { timeout: 15000 });
  await page.getByLabel("Compact handoff").fill("GOAL: implement compact handoffs. CONSTRAINTS: preserve history. REMAINING: verify.");
  await page.getByRole("button", { name: "Use compact handoff" }).click();
  await expect(page.getByText(/Fresh session on next message/)).toBeVisible();
  await expect(page.getByLabel("Task tool-call allowance")).toHaveValue("20");
  await page.screenshot({ path: "test-results/efficiency-controls.png" });
  await page.getByText(/Context & usage/).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Implement next phase");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Starting session/)).toHaveCount(2);
});

test("agent recommends a cheaper model and continues the step automatically", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-routing-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const project = await (await request.post("/api/projects", { data: { name: "Routing project", repoPath: repo } })).json();
  const task = await (await request.post(`/api/projects/${project.id}/tasks`, { data: { message: "Small change [switch-model]" } })).json();
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText(/Switching to claude-haiku-4-5-20251001/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Haiku 4.5 · low", { exact: true })).toBeVisible();
  await expect(page.getByText(/Starting session/)).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue("Small change [switch-model]");
});
