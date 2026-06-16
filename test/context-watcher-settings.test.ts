// Tests for cleanAllowlist (the fail-closed armed-inject allowlist) and the
// settings clamp + write semantics. The allowlist is the load-bearing gate
// that determines which roles can be auto-compacted; bugs here are
// safety-critical.
//
// Isolation: settings module honors CLAUDELINK_CONTEXT_WATCHER_SETTINGS env
// var. We set it to a temp file path BEFORE importing the module so all
// reads/writes hit the temp file and never touch the live fleet's config.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_SETTINGS = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-cw-settings-")),
  "context-watcher.json"
);
process.env.CLAUDELINK_CONTEXT_WATCHER_SETTINGS = TMP_SETTINGS;

import {
  readContextWatcherSettings,
  writeContextWatcherSettings,
} from "../src/context-watcher-settings.js";

function reset() {
  if (fs.existsSync(TMP_SETTINGS)) fs.unlinkSync(TMP_SETTINGS);
}

test("default allowlist is empty (fail-closed)", () => {
  reset();
  writeContextWatcherSettings({ injectAllowlist: [] });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, []);
});

test("allowlist accepts an array of strings", () => {
  reset();
  writeContextWatcherSettings({ injectAllowlist: ["dev-a", "dev-b"] });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["dev-a", "dev-b"]);
});

test("cleanAllowlist trims whitespace — 'dev' and 'dev ' must dedupe", () => {
  // The regression: gate's .includes(role) treats "dev" and "dev " as
  // different roles. Operator pastes a list with a stray space → one role
  // doesn't fire and the bug is silent.
  reset();
  writeContextWatcherSettings({ injectAllowlist: ["dev", "dev "] });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["dev"]);
});

test("cleanAllowlist dedupes duplicate entries", () => {
  reset();
  writeContextWatcherSettings({ injectAllowlist: ["a", "b", "a", "b", "a"] });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["a", "b"]);
});

test("cleanAllowlist drops empty strings + whitespace-only entries", () => {
  reset();
  writeContextWatcherSettings({ injectAllowlist: ["", "  ", "real", "\t"] });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["real"]);
});

test("cleanAllowlist drops non-string entries", () => {
  reset();
  writeContextWatcherSettings({
    injectAllowlist: ["real", 42, null, true, "alsoreal"] as any,
  });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["real", "alsoreal"]);
});

test("non-array allowlist input becomes empty (fail-closed)", () => {
  reset();
  writeContextWatcherSettings({ injectAllowlist: "dev" as any });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, []);
});

test("partial update of one setting does not clobber others", () => {
  reset();
  writeContextWatcherSettings({
    injectAllowlist: ["a"],
    dollarPerTurnThreshold: 0.42,
  });
  writeContextWatcherSettings({ enabled: true });
  const s = readContextWatcherSettings();
  assert.deepEqual(s.injectAllowlist, ["a"]);
  assert.equal(s.dollarPerTurnThreshold, 0.42);
  assert.equal(s.enabled, true);
});

test("clampInt enforces thresholdTokens within bounds [20000, 1_000_000]", () => {
  reset();
  writeContextWatcherSettings({ thresholdTokens: 5 });
  assert.equal(readContextWatcherSettings().thresholdTokens, 20000);
  writeContextWatcherSettings({ thresholdTokens: 5_000_000 });
  assert.equal(readContextWatcherSettings().thresholdTokens, 1_000_000);
  writeContextWatcherSettings({ thresholdTokens: 200_000 });
  assert.equal(readContextWatcherSettings().thresholdTokens, 200_000);
});

test("dollarPerTurnThreshold accepts a positive number", () => {
  reset();
  writeContextWatcherSettings({ dollarPerTurnThreshold: 0.5 });
  assert.equal(readContextWatcherSettings().dollarPerTurnThreshold, 0.5);
});

test("dollarPerTurnThreshold rejects zero / negative (falls back to current)", () => {
  reset();
  writeContextWatcherSettings({ dollarPerTurnThreshold: 0.5 });
  writeContextWatcherSettings({ dollarPerTurnThreshold: -1 });
  assert.equal(readContextWatcherSettings().dollarPerTurnThreshold, 0.5);
  writeContextWatcherSettings({ dollarPerTurnThreshold: 0 });
  assert.equal(readContextWatcherSettings().dollarPerTurnThreshold, 0.5);
});

test("oneShot defaults to true (one demo fire, then auto-disarm)", () => {
  reset();
  const s = readContextWatcherSettings();
  assert.equal(s.oneShot, true);
});

test("enabled defaults to false (opt-in)", () => {
  reset();
  const s = readContextWatcherSettings();
  assert.equal(s.enabled, false);
});

test("mode defaults to 'observe' (never injects out of the box)", () => {
  reset();
  const s = readContextWatcherSettings();
  assert.equal(s.mode, "observe");
});
