// Playwright config for ClaudeLink Command Center smoke tests.
// One-time setup: `npx playwright install chromium`
// Run: `npm run test:e2e`

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false, // tests share a server in beforeAll — keep serial
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // one server per worker; one worker total
  reporter: "list",
  timeout: 30 * 1000,
  expect: { timeout: 5000 },
  use: {
    actionTimeout: 5000,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
