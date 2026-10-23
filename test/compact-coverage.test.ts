// Pins per-agent auto-compact coverage: who is covered by default, how the
// Command Center checkbox edits it, and which reasons surface as "blocked"
// (red) versus "excluded" (the operator's own choice).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-coverage-")), "context-watcher.json");
process.env.CLAUDELINK_CONTEXT_WATCHER_SETTINGS = TMP;

import {
  readContextWatcherSettings,
  writeContextWatcherSettings,
  compactChecked,
  compactCoverage,
  setCompactForRole,
} from "../src/context-watcher-settings.js";

function reset(raw?: object) {
  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
  if (raw) fs.writeFileSync(TMP, JSON.stringify(raw));
}
const iterm = { tty: "/dev/ttys001", terminal_app: "iterm2", hasTranscript: true };
const armed = { enabled: true, mode: "inject" };

test("fresh install: scope is all, so a brand-new or renamed role is covered with no edits", () => {
  reset();
  const s = readContextWatcherSettings();
  assert.equal(s.injectScope, "all");
  assert.equal(compactChecked(s, "Some New Terminal"), true);
});

test("a legacy config with a non-empty allowlist keeps allowlist scope", () => {
  reset({ ...armed, injectAllowlist: ["Dev A"] });
  const s = readContextWatcherSettings();
  assert.equal(s.injectScope, "allowlist");
  assert.equal(compactChecked(s, "Dev A"), true);
  assert.equal(compactChecked(s, "Dev A Renamed"), false);
});

test("a legacy config with an empty allowlist becomes scope all", () => {
  reset({ ...armed, injectAllowlist: [] });
  assert.equal(readContextWatcherSettings().injectScope, "all");
});

test("explicit scope wins over the legacy inference", () => {
  reset({ ...armed, injectScope: "all", injectAllowlist: ["Dev A"] });
  assert.equal(compactChecked(readContextWatcherSettings(), "Anyone"), true);
});

test("checkbox in scope all: untick adds to exclude, tick removes", () => {
  reset({ ...armed, injectScope: "all" });
  setCompactForRole("Desk", false);
  assert.deepEqual(readContextWatcherSettings().injectExclude, ["Desk"]);
  assert.equal(compactChecked(readContextWatcherSettings(), "Desk"), false);
  setCompactForRole("Desk", true);
  assert.deepEqual(readContextWatcherSettings().injectExclude, []);
});

test("checkbox in allowlist scope edits the allowlist instead", () => {
  reset({ ...armed, injectAllowlist: ["Dev A"] });
  setCompactForRole("Dev B", true);
  assert.deepEqual(readContextWatcherSettings().injectAllowlist, ["Dev A", "Dev B"]);
  setCompactForRole("Dev A", false);
  assert.deepEqual(readContextWatcherSettings().injectAllowlist, ["Dev B"]);
});

test("partial updates don't clobber scope or exclude list", () => {
  reset({ ...armed, injectScope: "all", injectExclude: ["Desk"] });
  writeContextWatcherSettings({ cooldownMin: 45 });
  const s = readContextWatcherSettings();
  assert.equal(s.injectScope, "all");
  assert.deepEqual(s.injectExclude, ["Desk"]);
});

test("coverage: protected when checked, armed, dispatchable and measurable", () => {
  reset({ ...armed, injectScope: "all" });
  const c = compactCoverage(readContextWatcherSettings(), { role: "Dev", ...iterm });
  assert.deepEqual([c.state, c.checked], ["covered", true]);
});

test("coverage: operator's untick is 'excluded', not an alert", () => {
  reset({ ...armed, injectScope: "all", injectExclude: ["Desk"] });
  const c = compactCoverage(readContextWatcherSettings(), { role: "Desk", ...iterm });
  assert.deepEqual([c.state, c.checked, c.reason], ["excluded", false, "excluded by you"]);
});

test("coverage: falling off an allowlist is an alert", () => {
  reset({ ...armed, injectAllowlist: ["Old Name"] });
  const c = compactCoverage(readContextWatcherSettings(), { role: "New Name", ...iterm });
  assert.equal(c.state, "blocked");
  assert.match(c.reason, /allowlist/);
});

test("coverage: system reasons are alerts, each with its own reason", () => {
  reset({ enabled: false, mode: "inject", injectScope: "all" });
  assert.match(compactCoverage(readContextWatcherSettings(), { role: "Dev", ...iterm }).reason, /turned off/);
  reset({ enabled: true, mode: "observe", injectScope: "all" });
  assert.match(compactCoverage(readContextWatcherSettings(), { role: "Dev", ...iterm }).reason, /observe mode/);
  reset({ ...armed, injectScope: "all" });
  const s = readContextWatcherSettings();
  const apple = compactCoverage(s, { role: "Dev", ...iterm, terminal_app: "apple_terminal" });
  assert.equal(apple.state, "blocked");
  assert.match(apple.reason, /can't receive \/compact/);
  assert.match(compactCoverage(s, { role: "Dev", ...iterm, tty: null }).reason, /can't receive/);
  assert.match(compactCoverage(s, { role: "Dev", ...iterm, hasTranscript: false }).reason, /can't be measured/);
  assert.equal(compactCoverage(s, { role: "Dev", ...iterm, terminal_app: "tmux" }).state, "covered");
});
