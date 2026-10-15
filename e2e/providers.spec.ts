import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("choose ChatGPT for a prompt, resume, and switch to Claude", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-provider-e2e-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const response = await request.post("/api/projects", { data: { name: "Provider switching", repoPath: repo } });
  const project = await response.json();
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel("Provider", { exact: true }).selectOption("codex");
  const modelPicker = page.getByLabel("Model", { exact: true });
  await expect(modelPicker.locator("option")).toHaveCount(6); // Default plus five discovered entries.
  await expect(modelPicker.locator("option").nth(1)).toHaveText("Demo Model 1");
  await modelPicker.selectOption("demo-model-2");
  await page.getByRole("textbox", { name: "Message" }).fill("Hello Codex");
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByText(/Starting thread.*demo-model-2/)).toBeVisible();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Follow-up");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Continuing thread/)).toBeVisible();
  await expect(page.getByLabel("Provider", { exact: true })).toBeEnabled();
  await page.getByLabel("Provider", { exact: true }).selectOption("claude");
  await expect(page.getByLabel("Provider", { exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message" }).fill("Hello Claude");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Switched from ChatGPT/)).toBeVisible();
  await expect(page.getByText(/You said: "Hello Claude"/)).toBeVisible();
});
