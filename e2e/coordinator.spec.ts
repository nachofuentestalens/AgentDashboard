import { expect, test } from "@playwright/test";

test("enter a usage reading and see the coordinator keep the reserve", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Coordinator" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator" })).toBeVisible();

  const codex = page.getByRole("region", { name: "ChatGPT (Codex)" });
  await codex.getByLabel("Used %").fill("90");
  await codex.getByRole("button", { name: "Save reading" }).click();
  await expect(codex.getByText("Reserve only")).toBeVisible();
  await expect(codex.getByText(/Session usage 90% reached the 20% reserve kept for you/)).toBeVisible();
  await expect(codex.getByRole("meter", { name: "Session usage" })).toHaveAttribute("aria-valuenow", "90");
  const usage = page.getByRole("region", { name: "Session usage", exact: true });
  const codexSession = usage.getByRole("link", { name: "Codex session: 10% left", exact: true });
  await expect(codexSession).toBeVisible();
  await expect(usage.getByRole("link", { name: /^Claude session:/ })).toBeVisible();
  await codexSession.hover();
  await expect(usage.getByRole("tooltip")).toContainText(/Resets in .*h .*m/);
  await page.getByRole("link", { name: "Compute", exact: true }).click();
  await expect(codexSession).toBeVisible();
  await codexSession.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(usage.getByRole("tooltip")).toBeVisible();
  await codexSession.click();
  await expect(page.getByRole("heading", { name: "Coordinator" })).toBeVisible();
  await page.screenshot({ path: "test-results/coordinator.png", fullPage: true });

  await page.getByRole("spinbutton", { name: "Session reserve %" }).fill("10");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(codex.getByText(/Session usage 90% reached the 10% reserve/)).toBeVisible();

  // Leave the shared server with room on both providers for the other specs.
  await codex.getByLabel("Used %").fill("0");
  await codex.getByRole("button", { name: "Save reading" }).click();
  await expect(codex.getByText("Room to work", { exact: true })).toBeVisible();
});
