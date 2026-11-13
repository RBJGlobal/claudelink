import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { dailyDue, checkpointDue, readRebuildConfig } from "../src/rebuild-job.js";

const at = (h: number, m: number) => { const d = new Date(2026, 10, 12, h, m, 0, 0); return d; };

test("daily: not due before the slot", () => {
  assert.equal(dailyDue(at(3, 0), at(0, 0).getTime(), "03:30"), false);
});
test("daily: due after the slot if no run since", () => {
  assert.equal(dailyDue(at(3, 31), at(0, 0).getTime(), "03:30"), true);
});
test("daily: catches up after sleep, once", () => {
  assert.equal(dailyDue(at(9, 0), at(0, 0).getTime(), "03:30"), true);
  assert.equal(dailyDue(at(9, 1), at(9, 0).getTime(), "03:30"), false);
});
test("daily: bad or empty time disables", () => {
  assert.equal(dailyDue(at(9, 0), 0, ""), false);
  assert.equal(dailyDue(at(9, 0), 0, "25:99"), false);
});
test("checkpoint: needs a newer checkpoint", () => {
  assert.equal(checkpointDue(100, 100, 1e9, 0, 10), false);
  assert.equal(checkpointDue(200, 100, 1e9, 0, 10), true);
});
test("checkpoint: debounced", () => {
  const now = 1e9;
  assert.equal(checkpointDue(200, 100, now, now - 5 * 60000, 10), false);
  assert.equal(checkpointDue(200, 100, now, now - 11 * 60000, 10), true);
});
test("config: missing file is disabled with no command", () => {
  const c = readRebuildConfig("/nonexistent/rebuild-job.json");
  assert.equal(c.enabled, false);
  assert.equal(c.command, "");
});
test("config: parsed and clamped", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rj-")), "c.json");
  fs.writeFileSync(f, JSON.stringify({ enabled: true, command: " echo hi ", debounceMin: 0, timeoutMin: 9999 }));
  const c = readRebuildConfig(f);
  assert.equal(c.enabled, true);
  assert.equal(c.command, "echo hi");
  assert.equal(c.debounceMin, 1);
  assert.equal(c.timeoutMin, 120);
  assert.equal(c.onCheckpoint, true);
});
