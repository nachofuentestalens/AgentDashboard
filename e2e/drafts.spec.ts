import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("unsaved design documents and role edits survive leaving the page", async ({ page, request }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ad-e2e-drafts-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const res = await request.post("/api/projects", { data: { name: "Drafts", repoPath: repo } });
  const projectId = ((await res.json()) as { id: string }).id;
  // A custom role, not the template: other specs count the template's departments across projects.
  const dept = (await (await request.post(`/api/projects/${projectId}/departments`, { data: { name: "Writing" } })).json()) as { id: string };
  await request.post(`/api/projects/${projectId}/roles`, { data: { departmentId: dept.id, name: "Narrative Designer", brief: "Write the story." } });

  // A new design document, half written, then a reload: the editor comes back with the text.
  await page.goto(`/projects/${projectId}/docs`);
  await page.getByRole("button", { name: "+ New" }).click();
  await page.getByRole("textbox", { name: "Document path" }).fill("design/game/levels.md");
  await page.getByRole("textbox", { name: "Document content" }).fill("# Levels\n\nThree acts.");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Document path" })).toHaveValue("design/game/levels.md");
  await expect(page.getByRole("textbox", { name: "Document content" })).toHaveValue("# Levels\n\nThree acts.");
  await page.getByRole("button", { name: "Save and commit" }).click();
  await expect(page.getByRole("heading", { name: "Levels" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Document content" })).toHaveCount(0);

  // A role's job description, edited and the dialog closed: reopening restores it until Cancel discards it.
  await page.goto(`/projects/${projectId}/studio`);
  const writer = page.getByRole("listitem", { name: "Narrative Designer role" });
  await writer.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Job description").fill("Own the engine.");
  await page.keyboard.press("Escape");
  await page.goto(`/projects/${projectId}/docs`);
  await page.goto(`/projects/${projectId}/studio`);
  await writer.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Restored your unsaved changes.")).toBeVisible();
  await expect(page.getByLabel("Job description")).toHaveValue("Own the engine.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await writer.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Restored your unsaved changes.")).toHaveCount(0);
  await expect(page.getByLabel("Job description")).toHaveValue("Write the story.");
});
