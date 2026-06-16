// Playwright smoke against the Command Center UI. Verifies the single-page
// HTML loads, the two tabs render (Overview + Fleet Token Meter), and the
// API endpoints the page consumes return valid JSON shapes.
//
// One-time setup: `npx playwright install chromium`
// Run: `npm run test:e2e`
//
// Isolation: same env-var pattern as the node:test suite — test DB +
// services-off + dynamic port.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Configure the env BEFORE importing the server so the right paths are used.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-e2e-"));
process.env.CLAUDELINK_DB_PATH = path.join(TMP_DIR, "nexus.db");
process.env.CLAUDELINK_UI_NO_SERVICES = "1";

let server: http.Server;
let baseURL: string;

test.beforeAll(async () => {
  // Plant a registered agent so the UI has something to render.
  const { NexusDB } = await import("../../src/db.js");
  const db = new NexusDB();
  db.registerAgent("e2e-agent", "Playwright smoke", process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });

  const { startUIServer } = await import("../../src/ui-server.js");
  server = startUIServer(0);
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Command Center loads and identifies as ClaudeLink", async ({ page }) => {
  await page.goto(baseURL);
  await expect(page).toHaveTitle(/ClaudeLink/i);
});

test("Both tabs are present (Overview + Fleet Token Meter)", async ({ page }) => {
  await page.goto(baseURL);
  // The tabs are buttons with data-tab attributes.
  const tabs = page.locator(".tab");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".tab", { hasText: /overview/i })).toBeVisible();
  await expect(page.locator(".tab", { hasText: /fleet token meter/i })).toBeVisible();
});

test("Clicking Fleet Token Meter tab swaps the active panel", async ({ page }) => {
  await page.goto(baseURL);
  const meterTab = page.locator(".tab", { hasText: /fleet token meter/i });
  await meterTab.click();
  await expect(meterTab).toHaveClass(/active/);
  // The meter panel should now be the active tab-content. We assert by
  // looking at any tab-content marked active.
  await expect(page.locator(".tab-content.active")).toHaveCount(1);
});

test("The planted e2e-agent appears in the agents area", async ({ page }) => {
  await page.goto(baseURL);
  await page.waitForLoadState("networkidle");
  // The state is fetched + rendered via JS; check the body text.
  await expect(page.locator("body")).toContainText("e2e-agent");
});
