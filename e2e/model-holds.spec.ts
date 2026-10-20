import { expect, test } from "@playwright/test";

test("sidebar pauses and resumes a model across navigation and reload", async ({ page }) => {
  await page.goto("/");
  const controls = page.getByText("Model controls", { exact: true }).first();
  await controls.click();
  await page.getByLabel("Claude model to pause").selectOption("claude-sonnet-5");
  await page.getByRole("button", { name: "Pause Claude model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume Claude model", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Compute", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume Claude model", exact: true })).toBeVisible();
  await page.reload();
  await page.getByText("Model controls - Paused", { exact: true }).click();
  await page.getByLabel("Claude model to pause").selectOption("claude-sonnet-5");
  await page.screenshot({ path: "test-results/model-holds.png" });
  await page.getByRole("button", { name: "Resume Claude model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause Claude model", exact: true })).toBeVisible();
});
