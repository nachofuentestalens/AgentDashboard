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

test("owner reviews and approves a baseline snapshot without touching the project folder", async ({ page, request }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-delivery-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "committed\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  fs.writeFileSync(path.join(repo, "contract.md"), "reviewed contract\n");
  const project = await (await request.post("/api/projects", { data: { name: "Delivery", repoPath: repo } })).json();
  await page.goto(`/projects/${project.id}`);
  await page.getByText("Delivery & baseline", { exact: true }).click();
  await page.getByLabel("contract.md", { exact: true }).check();
  await page.getByRole("button", { name: "Prepare baseline preview" }).click();
  const preview = page.getByRole("region", { name: "Baseline preview" });
  await expect(preview.getByText("+reviewed contract")).toBeVisible();
  await preview.getByRole("button", { name: "Approve this baseline" }).click();
  await expect(page.getByText("Approved baseline:")).toBeVisible();
  expect(git("status", "--porcelain").trim()).toBe("?? contract.md");
  expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
});
