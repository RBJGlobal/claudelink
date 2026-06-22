// Stage 0 P0: per-tick gate-status log is the instrument-first foundation for
// the next standing-on rollout. Pins the line schema so a refactor can't
// silently break the operator's grep tooling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGateStatus, GateStatusFields } from "../src/context-watcher.js";

function base(): GateStatusFields {
  return {
    role: "dev-a",
    agent_id: "agent-123",
    mode: "observe",
    decision: "below-threshold",
  };
}

test("formatGateStatus always leads with 'gate-status' and core fields in fixed order", () => {
  const line = formatGateStatus(base());
  assert.match(
    line,
    /^gate-status role=dev-a agent_id=agent-123 mode=observe decision=below-threshold/
  );
});

test("formatGateStatus emits decision keyword that the operator can grep verbatim", () => {
  // Common keywords from prior log generations stay grep-compatible because
  // they're embedded as the decision= value. Tooling that greps `would-nudge`
  // or `inject-ARMED-FIRE` must still match.
  for (const dec of [
    "would-nudge",
    "observe-hold",
    "inject-skip-allowlist",
    "inject-skip-safety",
    "inject-ARMED-FIRE",
    "inject-LATCH-FAILED",
    "skip-cooldown",
    "skip-no-session",
    "skip-no-econ",
    "below-threshold",
  ]) {
    const line = formatGateStatus({ ...base(), decision: dec });
    assert.ok(
      line.includes(`decision=${dec}`),
      `decision keyword ${dec} must appear verbatim`
    );
  }
});

test("formatGateStatus formats numeric fields with stable precision", () => {
  const line = formatGateStatus({
    ...base(),
    context: 123456,
    occupancy_pct: 51.7382,
    per_turn_usd: 0.456,
    turns_per_hr: 12.345,
    net_saved_usd: 1.234,
  });
  assert.ok(line.includes("context=123456"));
  assert.ok(line.includes("occupancy_pct=51.7"));
  assert.ok(line.includes("per_turn_usd=0.46"));
  assert.ok(line.includes("turns_per_hr=12.3"));
  assert.ok(line.includes("net_saved_usd=1.23"));
});

test("formatGateStatus emits boolean gates in canonical true/false form", () => {
  const line = formatGateStatus({
    ...base(),
    progressing: true,
    ambiguous: false,
    allowlisted: true,
    idle: false,
    fresh_consent: true,
    handoff_ok: false,
    economic_gate: true,
  });
  for (const kv of [
    "progressing=true",
    "ambiguous=false",
    "allowlisted=true",
    "idle=false",
    "fresh_consent=true",
    "handoff_ok=false",
    "economic_gate=true",
  ]) {
    assert.ok(line.includes(kv), `expected '${kv}' in: ${line}`);
  }
});

test("formatGateStatus signal_age_min sentinel: null logs as 'none'", () => {
  const lineNull = formatGateStatus({ ...base(), signal_age_min: null });
  assert.ok(lineNull.includes("signal_age_min=none"));

  const lineNum = formatGateStatus({ ...base(), signal_age_min: 12.3456 });
  assert.ok(lineNum.includes("signal_age_min=12.3"));
});

test("formatGateStatus model field is shortened (drops 'claude-' prefix)", () => {
  const line = formatGateStatus({ ...base(), model: "claude-opus-4-7" });
  assert.ok(
    line.includes("model=opus-4-7"),
    "model should be shortened for log scannability"
  );
});

test("formatGateStatus is a single physical line (no embedded newlines)", () => {
  const line = formatGateStatus({
    ...base(),
    context: 100_000,
    occupancy_pct: 50,
    model: "claude-opus-4-7",
    per_turn_usd: 0.15,
    turns_per_hr: 10,
    progressing: true,
    signal_age_min: 5.5,
    signal_age_turns: 2,
    safe_to_clear: 1,
    economic_gate: true,
    ambiguous: false,
    allowlisted: true,
    idle: true,
    fresh_consent: true,
    handoff_ok: true,
    net_saved_usd: 0.42,
  });
  assert.ok(!line.includes("\n"), "must be a single physical line");
});

test("formatGateStatus omits fields that aren't set (no empty key=)", () => {
  // The early-exit decisions (skip-no-session) emit only header fields. The
  // formatter must NOT emit `context=undefined` or `model=`.
  const line = formatGateStatus({
    role: "x",
    agent_id: "y",
    mode: "observe",
    decision: "skip-no-session",
  });
  assert.ok(!line.match(/=undefined/), `no 'undefined' in output: ${line}`);
  assert.ok(!line.match(/=(\s|$)/), `no empty values in output: ${line}`);
});

test("formatGateStatus reason field is preserved verbatim", () => {
  const line = formatGateStatus({
    ...base(),
    reason: "savings<overhead",
  });
  assert.ok(line.includes("reason=savings<overhead"));
});

test("formatGateStatus inject mode is distinguishable from observe in the log", () => {
  const obs = formatGateStatus({ ...base(), mode: "observe" });
  const inj = formatGateStatus({ ...base(), mode: "inject" });
  assert.ok(obs.includes("mode=observe"));
  assert.ok(inj.includes("mode=inject"));
});
