// Pins the Plan Usage tile's freshness rules. The proxy only captures while it
// is running and a terminal routed through it is making requests; otherwise
// quota.json freezes. A weeks-old "5% / 2%" was rendered as if current while
// real usage was far higher. These rules decide when a reading must not be
// shown as a number.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quotaFreshness, proxyIsRunning, STALE_AFTER_MIN } from "../src/usage-proxy.js";

const NOW = Date.UTC(2026, 9, 23, 0, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

test("a fresh capture with future resets is usable", () => {
  const f = quotaFreshness(
    {
      capturedAtMs: NOW - 2 * 60_000,
      session: { resetEpoch: sec(NOW + 3_600_000) },
      weekly: { resetEpoch: sec(NOW + 86_400_000) },
    },
    NOW,
    true
  );
  assert.equal(f.ageMin, 2);
  assert.equal(f.stale, false);
  assert.equal(f.sessionExpired, false);
  assert.equal(f.weeklyExpired, false);
});

test("the Sep 5 reading is stale and both windows have expired", () => {
  // Shape of the real frozen file: captured 2026-09-05, resets long past.
  const f = quotaFreshness(
    {
      capturedAtMs: 1788628619794,
      session: { resetEpoch: 1788646200 },
      weekly: { resetEpoch: 1788926400 },
      fable: { resetEpoch: 1788926400 },
    },
    NOW,
    false
  );
  assert.equal(f.stale, true);
  assert.equal(f.sessionExpired, true);
  assert.equal(f.weeklyExpired, true);
  assert.equal(f.fableExpired, true);
  assert.equal(f.proxyRunning, false);
});

test("stale threshold is exactly STALE_AFTER_MIN", () => {
  const at = (m: number) => quotaFreshness({ capturedAtMs: NOW - m * 60_000 }, NOW, true).stale;
  assert.equal(at(STALE_AFTER_MIN - 1), false);
  assert.equal(at(STALE_AFTER_MIN), true);
});

test("the session window can expire while the weekly one is still valid", () => {
  const f = quotaFreshness(
    {
      capturedAtMs: NOW - 5 * 60_000,
      session: { resetEpoch: sec(NOW - 1000) },
      weekly: { resetEpoch: sec(NOW + 86_400_000) },
    },
    NOW,
    true
  );
  assert.equal(f.sessionExpired, true);
  assert.equal(f.weeklyExpired, false);
});

test("a window with no reset time is not treated as expired", () => {
  const f = quotaFreshness({ capturedAtMs: NOW, session: { resetEpoch: null } }, NOW, true);
  assert.equal(f.sessionExpired, false);
});

test("proxyIsRunning: missing lock, junk lock, dead pid all read as stopped; live pid reads as running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-proxylock-"));
  const lock = path.join(dir, "quota-proxy.lock");
  assert.equal(proxyIsRunning(lock), false);
  fs.writeFileSync(lock, "not json");
  assert.equal(proxyIsRunning(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, port: 8788 }));
  assert.equal(proxyIsRunning(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port: 8788 }));
  assert.equal(proxyIsRunning(lock), true);
});
