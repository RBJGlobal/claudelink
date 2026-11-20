// T1 consent handshake — decision core. These pin the gate ORDERING and the
// freshness/cooldown semantics independently of the watcher's DB/transcript
// plumbing: FIRE rests on durable fresh consent + idle; ASK is throttled; a
// consent never gets starved by the ask-cooldown.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideCompactAction, CompactDecisionInput, firedAtAfter, inFireQuiet, FIRE_QUIET_MS } from "../src/compact-decision.js";

const MIN = 60 * 1000;

// A baseline where nothing is eligible: high occupancy is assumed upstream, the
// agent is idle, economically worth a turn, never asked, no consent on record.
function base(): CompactDecisionInput {
  return {
    idle: true,
    ambiguous: false,
    safeToClear: false,
    consentAgeMs: null,
    consentFreshMs: 15 * MIN,
    economicGreen: true,
    msSinceLastAsk: null,
    askCooldownMs: 30 * MIN,
  };
}

test("ambiguous session never acts — even with fresh consent", () => {
  const r = decideCompactAction({
    ...base(),
    ambiguous: true,
    safeToClear: true,
    consentAgeMs: 1 * MIN,
  });
  assert.deepEqual(r, { kind: "skip", reason: "ambiguous-session" });
});

test("fresh consent + idle → FIRE", () => {
  const r = decideCompactAction({ ...base(), safeToClear: true, consentAgeMs: 2 * MIN });
  assert.deepEqual(r, { kind: "fire" });
});

test("fresh consent fires even with a recent ask still inside cooldown (consent is not starved)", () => {
  const r = decideCompactAction({
    ...base(),
    safeToClear: true,
    consentAgeMs: 1 * MIN,
    msSinceLastAsk: 1 * MIN, // well inside the 30m ask-cooldown
  });
  assert.deepEqual(r, { kind: "fire" }, "FIRE is evaluated before the ask-cooldown");
});

test("consent present but NOT idle → skip (re-check idle at fire time)", () => {
  const r = decideCompactAction({
    ...base(),
    idle: false,
    safeToClear: true,
    consentAgeMs: 1 * MIN,
  });
  assert.deepEqual(r, { kind: "skip", reason: "consented-but-not-idle" });
});

test("stale consent (older than the freshness window) does NOT fire — falls through to ASK", () => {
  const r = decideCompactAction({
    ...base(),
    safeToClear: true,
    consentAgeMs: 20 * MIN, // > 15m window
  });
  assert.deepEqual(r, { kind: "ask" }, "stale yes is ignored; we ask for a fresh one");
});

test("safeToClear=true but no consent timestamp → treated as no consent (ASK)", () => {
  const r = decideCompactAction({ ...base(), safeToClear: true, consentAgeMs: null });
  assert.deepEqual(r, { kind: "ask" });
});

test("no consent + idle + economic + not recently asked → ASK", () => {
  assert.deepEqual(decideCompactAction(base()), { kind: "ask" });
});

test("no consent + NOT idle → skip (don't interrupt to ask)", () => {
  assert.deepEqual(decideCompactAction({ ...base(), idle: false }), {
    kind: "skip",
    reason: "not-idle",
  });
});

test("no consent + idle but economics below overhead → skip (asking costs a turn)", () => {
  assert.deepEqual(decideCompactAction({ ...base(), economicGreen: false }), {
    kind: "skip",
    reason: "economics-below-overhead",
  });
});

test("recently asked (inside cooldown) and no consent yet → skip, don't re-ask", () => {
  assert.deepEqual(
    decideCompactAction({ ...base(), msSinceLastAsk: 5 * MIN }),
    { kind: "skip", reason: "ask-cooldown" }
  );
});

test("asked long ago (past cooldown), still no consent → ASK again", () => {
  assert.deepEqual(
    decideCompactAction({ ...base(), msSinceLastAsk: 31 * MIN }),
    { kind: "ask" }
  );
});

test("a fire that landed starts the quiet period; one that did not leaves it alone", () => {
  assert.equal(firedAtAfter("ok", 5000, 0), 5000);
  assert.equal(firedAtAfter("unknown", 5000, 1000), 5000);
  assert.equal(firedAtAfter("fail", 5000, 1000), 1000);
  assert.equal(firedAtAfter("skip", 5000, 0), 0);
});

test("inFireQuiet: only within the quiet period after a real fire", () => {
  assert.equal(inFireQuiet(0, 10 * MIN), false); // never fired
  assert.equal(inFireQuiet(10 * MIN, 10 * MIN + 32_000), true);
  assert.equal(inFireQuiet(10 * MIN, 10 * MIN + FIRE_QUIET_MS), false);
});

test("32 s after a fire: consent consumed, size still stale, never asked: no second ASK", () => {
  // The 2026-11-20 sequence. The agent consented without being asked, so the
  // ask clock is empty; only the quiet period stands between it and a prompt.
  const firedAt = firedAtAfter("ok", 100 * MIN, 0);
  const now = firedAt + 32_000;
  const r = decideCompactAction({ ...base(), fireQuiet: inFireQuiet(firedAt, now) });
  assert.deepEqual(r, { kind: "skip", reason: "fire-quiet" });
  // Once the quiet period is over the ASK is available again.
  const later = firedAt + FIRE_QUIET_MS;
  assert.deepEqual(decideCompactAction({ ...base(), fireQuiet: inFireQuiet(firedAt, later) }), { kind: "ask" });
});

test("the quiet period never blocks a FIRE on fresh consent", () => {
  const r = decideCompactAction({ ...base(), safeToClear: true, consentAgeMs: 1 * MIN, fireQuiet: true });
  assert.deepEqual(r, { kind: "fire" });
});
