// Manual-override handshake — decision core. Pins the safety gates for a
// founder-clicked /compact or /clear: the prompt fires FIRST, the action fires
// only on a consent that POSTDATES the click, /clear additionally needs a
// verified handoff, and a forgotten request expires instead of firing later.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideManualAction, ManualDecisionInput } from "../src/manual-decision.js";

const MIN = 60 * 1000;
const T0 = 1_000_000_000_000; // a fixed "click time" for postdate arithmetic

// Baseline: founder just clicked Compact (requestedTs=T0), agent is idle, never
// asked, no consent on record, request is fresh. Nothing is fire-eligible yet,
// so the baseline decision is ASK.
function base(): ManualDecisionInput {
  return {
    requested: "compact",
    idle: true,
    ambiguous: false,
    safeToClear: false,
    consentTs: null,
    requestedTs: T0,
    handoffOk: false,
    msSinceLastAsk: null,
    askCooldownMs: 30 * MIN,
    ageMs: 5 * 1000,
    ttlMs: 30 * MIN,
  };
}

test("fresh click with no consent → ASK (prompt fires first, never an instant fire)", () => {
  assert.deepEqual(decideManualAction(base()), { kind: "ask" });
});

test("PRE-EXISTING consent (older than the click) does NOT fire — still asks", () => {
  // The MCP server tells agents to signal_checkpoint often, so safe_to_clear is
  // frequently already true when the founder clicks. That stale yes must not
  // short-circuit the prompt.
  const r = decideManualAction({
    ...base(),
    safeToClear: true,
    consentTs: T0 - 2 * MIN, // consented BEFORE the click
  });
  assert.deepEqual(r, { kind: "ask" }, "pre-click consent must be ignored");
});

test("POSTDATED consent + idle → FIRE /compact", () => {
  const r = decideManualAction({
    ...base(),
    safeToClear: true,
    consentTs: T0 + 90 * 1000, // acknowledged AFTER the ask
  });
  assert.deepEqual(r, { kind: "fire", command: "/compact" });
});

test("postdated consent but agent went busy again → skip (re-check idle at fire time)", () => {
  const r = decideManualAction({
    ...base(),
    idle: false,
    safeToClear: true,
    consentTs: T0 + 90 * 1000,
  });
  assert.deepEqual(r, { kind: "skip", reason: "consented-but-not-idle" });
});

test("/clear with postdated consent but NO verified handoff → skip (destructive, hard-gated)", () => {
  const r = decideManualAction({
    ...base(),
    requested: "clear",
    safeToClear: true,
    consentTs: T0 + 90 * 1000,
    handoffOk: false,
  });
  assert.deepEqual(r, { kind: "skip", reason: "clear-needs-verified-handoff" });
});

test("/clear with postdated consent AND verified handoff → FIRE /clear", () => {
  const r = decideManualAction({
    ...base(),
    requested: "clear",
    safeToClear: true,
    consentTs: T0 + 90 * 1000,
    handoffOk: true,
  });
  assert.deepEqual(r, { kind: "fire", command: "/clear" });
});

test("ambiguous (shared-repo) session never FIRES — hard stop even with postdated consent", () => {
  const r = decideManualAction({
    ...base(),
    ambiguous: true,
    safeToClear: true,
    consentTs: T0 + 90 * 1000,
  });
  assert.deepEqual(r, { kind: "skip", reason: "ambiguous-session" });
});

test("ambiguous + idle + no consent yet → ASK (the ask wakes a parked terminal; tty targeting is exact)", () => {
  // A parked terminal in a shared repo goes transcript-stale and reads ambiguous.
  // Ambiguity must NOT starve the ask — the prompt is what disambiguates it (the
  // agent's reply + signal_checkpoint refreshes the transcript). FIRE stays gated
  // on ambiguity above; only the ASK is relaxed.
  const r = decideManualAction({ ...base(), ambiguous: true });
  assert.deepEqual(r, { kind: "ask" });
});

test("not idle and no consent yet → skip not-idle (don't ask mid-work)", () => {
  const r = decideManualAction({ ...base(), idle: false });
  assert.deepEqual(r, { kind: "skip", reason: "not-idle" });
});

test("recently re-asked → skip ask-cooldown (don't spam the prompt every tick)", () => {
  const r = decideManualAction({ ...base(), msSinceLastAsk: 2 * MIN });
  assert.deepEqual(r, { kind: "skip", reason: "ask-cooldown" });
});

test("first ask is never cooldown-blocked (msSinceLastAsk=null fires the ask)", () => {
  // Guards the watcher-owns-the-ask wiring: requestedTs must NOT be reused as an
  // ask time, or the first prompt would wait a full cooldown after the click.
  assert.deepEqual(decideManualAction({ ...base(), msSinceLastAsk: null }), { kind: "ask" });
});

test("expired request → skip expired (a forgotten click never fires hours later)", () => {
  const r = decideManualAction({
    ...base(),
    ageMs: 31 * MIN, // past ttl
    safeToClear: true,
    consentTs: T0 + 90 * 1000, // even with a postdated consent
  });
  assert.deepEqual(r, { kind: "skip", reason: "expired" });
});

test("consent exactly AT requestedTs does not count (strictly-after required)", () => {
  const r = decideManualAction({
    ...base(),
    safeToClear: true,
    consentTs: T0, // == requestedTs, not strictly after
  });
  assert.deepEqual(r, { kind: "ask" });
});
