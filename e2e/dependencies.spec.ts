import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("owner sets prerequisites and sees why a task cannot start", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-dependencies-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const project = await (await request.post("/api/projects", { data: { name: "Dependencies", repoPath: repo } })).json();
  await request.post(`/api/projects/${project.id}/studio/template`);
  const studio = await (await request.get(`/api/projects/${project.id}/studio`)).json();
  const roleId = studio.departments.flatMap((d: { roles: { id: string; name: string }[] }) => d.roles).find((r: { name: string }) => r.name === "QA Tester").id;
  const create = async (title: string) => (await request.post(`/api/projects/${project.id}/tasks`, { data: { title, roleId } })).json();
  const first = await create("Approve contracts");
  const next = await create("Implement combat");
  await page.goto(`/tasks/${next.id}`);
  await page.getByText("Prerequisites (0)", { exact: true }).click();
  await page.getByLabel("Depends on", { exact: true }).selectOption([first.id]);
  await expect(page.getByText("Dependency: waiting for owner approval of Approve contracts")).toBeVisible();
  await page.getByLabel("Required committed paths").fill("design/contracts.md");
  await page.getByLabel("Required committed paths").blur();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${next.id}`)).json()).task.requiredPaths).toEqual(["design/contracts.md"]);
  await page.reload();
  await page.getByText("Prerequisites (1) · Blocked", { exact: true }).click();
  await expect(page.getByLabel("Required committed paths")).toHaveValue("design/contracts.md");
  // The suite shares a server; do not leave duplicate department labels in later tests.
  expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
});
