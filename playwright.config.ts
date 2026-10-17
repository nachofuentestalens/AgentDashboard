import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const port = 5199;
// A fresh data folder per run, so tests never see a previous run's projects.
const dataDir = path.join(os.tmpdir(), `agent-dashboard-e2e-${Date.now()}`);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Assertions often wait for a queued fake agent run; CI's Windows runners take well over the 5 s default.
  expect: { timeout: 20_000 },
  workers: 1,
  // On CI, failures also appear as annotations on the run.
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    // Set PW_CHROMIUM to use an already installed Chromium instead of `npx playwright install chromium`.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "pnpm --filter @ad/server start",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: { AGENT_DASHBOARD_PORT: String(port), AGENT_DASHBOARD_DATA: dataDir, AGENT_DASHBOARD_FAKE_CLAUDE: "1", FAKE_CLAUDE_DELAY: "15" },
  },
});
