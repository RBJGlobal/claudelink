// Stage 0 P0: proportional-occupancy threshold replaces the model-blind dollar
// gate as the watcher's primary trigger. Pins:
//   - modelContextWindow defaults to 200K and recognizes the [1m]/-1m variants
//   - contextOccupancyThreshold setting clamps to [0.10, 0.95] and defaults 0.50
//   - settings round-trip preserves the new field, partial updates don't clobber it
//   - dollarPerTurnThreshold is retained in settings (backward-compat) but is
//     observability-only — no test in this file fires the watcher off of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_SETTINGS = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-occupancy-")),
  "context-watcher.json"
);
process.env.CLAUDELINK_CONTEXT_WATCHER_SETTINGS = TMP_SETTINGS;

import {
  readContextWatcherSettings,
  writeContextWatcherSettings,
} from "../src/context-watcher-settings.js";
import { modelContextWindow, effectiveContextWindow } from "../src/usage-reader.js";

function reset() {
  if (fs.existsSync(TMP_SETTINGS)) fs.unlinkSync(TMP_SETTINGS);
}

// ---- modelContextWindow ----

test("modelContextWindow defaults to 200K for the standard Claude 4.x family", () => {
  assert.equal(modelContextWindow("claude-opus-4-7"), 200_000);
  assert.equal(modelContextWindow("claude-opus-4-8"), 200_000);
  assert.equal(modelContextWindow("claude-sonnet-4-6"), 200_000);
  assert.equal(modelContextWindow("claude-haiku-4-5-20251001"), 200_000);
  assert.equal(modelContextWindow("claude-fable-5"), 200_000);
});

test("modelContextWindow returns 1M for the [1m]-suffixed beta variant", () => {
  assert.equal(modelContextWindow("claude-opus-4-7[1m]"), 1_000_000);
  assert.equal(modelContextWindow("claude-sonnet-4-6[1m]"), 1_000_000);
});

test("modelContextWindow returns 1M for a -1m variant", () => {
  assert.equal(modelContextWindow("claude-opus-4-7-1m"), 1_000_000);
});

test("modelContextWindow handles empty / unknown model strings as 200K", () => {
  assert.equal(modelContextWindow(""), 200_000);
  assert.equal(modelContextWindow("some-unknown-model"), 200_000);
});

// ---- effectiveContextWindow (evidence-based 1M inference) ----

test("effectiveContextWindow infers 1M when observed context exceeds 200K", () => {
  // A 200K-window model would have its request rejected at >200K, so a recorded
  // 572K turn proves the session is on a 1M window even though Claude Code logs
  // the model as plain claude-opus-4-8 (the 1M beta is a request header).
  assert.equal(effectiveContextWindow("claude-opus-4-8", 571_990), 1_000_000);
  assert.equal(effectiveContextWindow("claude-opus-4-8", 290_473), 1_000_000);
});

test("effectiveContextWindow keeps the model default at or below 200K", () => {
  // Below the threshold the label is unchanged — correct for a 200K model and
  // harmless for a 1M one; the inference only corrects the misleading >100% case.
  assert.equal(effectiveContextWindow("claude-opus-4-8", 150_000), 200_000);
  assert.equal(effectiveContextWindow("claude-opus-4-8", 200_000), 200_000); // exactly at limit
  assert.equal(effectiveContextWindow("claude-opus-4-8", 0), 200_000);
});

test("effectiveContextWindow still honors an explicit 1M model marker below 200K", () => {
  assert.equal(effectiveContextWindow("claude-opus-4-7[1m]", 50_000), 1_000_000);
});

// ---- contextOccupancyThreshold setting ----

test("contextOccupancyThreshold defaults to 0.5 (Founder Advisor recommendation)", () => {
  reset();
  const s = readContextWatcherSettings();
  assert.equal(s.contextOccupancyThreshold, 0.5);
});

test("contextOccupancyThreshold accepts a value in [0.10, 0.95]", () => {
  reset();
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.42 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.42);
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.75 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.75);
});

test("contextOccupancyThreshold clamps below 0.10 (typo guard against arming whole fleet)", () => {
  reset();
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.01 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.1);
  writeContextWatcherSettings({ contextOccupancyThreshold: 0 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.1);
});

test("contextOccupancyThreshold clamps above 0.95 (must leave some fire latitude)", () => {
  reset();
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.99 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.95);
  writeContextWatcherSettings({ contextOccupancyThreshold: 2.5 });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.95);
});

test("contextOccupancyThreshold falls back to current on NaN / non-numeric", () => {
  reset();
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.6 });
  // NaN write → must keep the previously persisted 0.6, not collapse to default
  writeContextWatcherSettings({ contextOccupancyThreshold: NaN });
  assert.equal(readContextWatcherSettings().contextOccupancyThreshold, 0.6);
});

test("contextOccupancyThreshold survives a partial update of unrelated fields", () => {
  reset();
  writeContextWatcherSettings({ contextOccupancyThreshold: 0.42 });
  writeContextWatcherSettings({ enabled: true });
  const s = readContextWatcherSettings();
  assert.equal(s.contextOccupancyThreshold, 0.42);
  assert.equal(s.enabled, true);
});

test("dollarPerTurnThreshold still persists for backward compat (now observability-only)", () => {
  reset();
  writeContextWatcherSettings({
    contextOccupancyThreshold: 0.42,
    dollarPerTurnThreshold: 0.5,
  });
  const s = readContextWatcherSettings();
  assert.equal(s.contextOccupancyThreshold, 0.42);
  assert.equal(s.dollarPerTurnThreshold, 0.5);
});
