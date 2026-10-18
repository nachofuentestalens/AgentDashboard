import { expect, test } from "@playwright/test";

test("sidebar activity groups models and tasks without expanding by default", async ({ page }) => {
  const row = (taskId: string, provider: string, model: string, projectId: string, projectName: string, status = "running") => ({
    run: { id: `run-${taskId}`, taskId, provider, model, status, waitReason: status === "queued" ? "Waiting for a free slot" : null },
    projectId,
    projectName,
    taskTitle: `Task ${taskId}`,
    roleName: "Developer",
  });
  await page.route("**/api/compute", (route) =>
    route.fulfill({
      json: {
        active: [row("task-alpha", "codex", "gpt-6-astra", "a", "Project Alpha"), row("task-beta", "claude", "sonnet", "b", "Project Beta")],
        queued: [row("task-gamma", "codex", "gpt-5.6-sol", "b", "Project Beta", "queued")],
      },
    }),
  );
  await page.goto("/");
  const usage = page.getByRole("region", { name: "Session usage", exact: true });
  const codex = usage.locator('details[aria-label="Codex activity"]');
  const claude = usage.locator('details[aria-label="Claude activity"]');
  await expect(codex.locator(":scope > summary")).toHaveText("1 working · 1 queued");
  await expect(claude.locator(":scope > summary")).toHaveText("1 working");
  await expect(codex.getByRole("link")).toHaveCount(0);
  await codex.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  const task = codex.getByRole("link", { name: /gpt-6-astra/ });
  await expect(task).toContainText("Task task-alpha");
  await expect(task).toHaveAttribute("href", "/tasks/task-alpha");
  await expect(task).toHaveAttribute("title", /Task task-alp · Developer/);
  await expect(codex.getByRole("link", { name: /gpt-5.6-sol/ })).toHaveAttribute("title", /Waiting for a free slot/);
  await codex.getByText("Project Alpha", { exact: false }).click();
  await expect(task).toBeHidden();
  await codex.getByText("Project Alpha", { exact: false }).click();
  await claude.locator(":scope > summary").click();
  await expect(claude.getByRole("link", { name: /sonnet/ })).toBeVisible();
  await page.screenshot({ path: "test-results/model-activity.png" });
});

test("sidebar distinguishes idle activity from unavailable activity", async ({ page }) => {
  await page.route("**/api/compute", (route) => route.fulfill({ json: { active: [], queued: [] } }));
  await page.goto("/");
  const codex = page.locator('details[aria-label="Codex activity"]');
  await expect(codex.locator(":scope > summary")).toHaveText("Idle");
  await codex.locator(":scope > summary").click();
  await expect(codex).toContainText("No running or queued tasks.");
  await page.route("**/api/compute", (route) => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.reload();
  await expect(codex.locator(":scope > summary")).toHaveText("Activity unavailable");
});
