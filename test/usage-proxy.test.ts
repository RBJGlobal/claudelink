// Tests for buildQuotaRecord — the pure header→QuotaRecord parser behind the
// subscription usage meter. The subtle, safety-relevant branch is the CLOBBER
// GUARD: a response with no unified rate-limit headers must return null so the
// proxy never overwrites a good quota.json with an empty snapshot (e.g. from a
// non-/v1/messages call that happens to carry a retry-after).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuotaRecord, mergeFableForward } from "../src/usage-proxy.js";

test("parses a full 5h + 7d snapshot", () => {
  const rec = buildQuotaRecord(
    {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-reset": "1783328400",
      "anthropic-ratelimit-unified-5h-utilization": "0.12",
      "anthropic-ratelimit-unified-7d-status": "allowed_warning",
      "anthropic-ratelimit-unified-7d-reset": "1783483200",
      "anthropic-ratelimit-unified-7d-utilization": "0.26",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "content-type": "application/json",
    },
    1783312752980
  );
  assert.ok(rec);
  assert.equal(rec.capturedAtMs, 1783312752980);
  assert.equal(rec.overallStatus, "allowed");
  assert.equal(rec.binding, "five_hour");
  assert.deepEqual(rec.session, {
    utilization: 0.12,
    resetEpoch: 1783328400,
    status: "allowed",
  });
  assert.deepEqual(rec.weekly, {
    utilization: 0.26,
    resetEpoch: 1783483200,
    status: "allowed_warning",
  });
  // raw captures only rate-limit headers, never unrelated ones like content-type
  assert.equal(rec.raw["anthropic-ratelimit-unified-5h-utilization"], "0.12");
  assert.equal("content-type" in rec.raw, false);
});

test("CLOBBER GUARD: no unified headers → null (even with retry-after present)", () => {
  const rec = buildQuotaRecord(
    { "content-type": "application/json", "retry-after": "5" },
    1
  );
  assert.equal(
    rec,
    null,
    "must not manufacture a record from a response with no unified quota headers"
  );
});

test("returns a record when only the 5h window is present (weekly null)", () => {
  const rec = buildQuotaRecord(
    {
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": "1783328400",
      "anthropic-ratelimit-unified-5h-status": "allowed",
    },
    1
  );
  assert.ok(rec);
  assert.equal(rec.session?.utilization, 0.5);
  assert.equal(rec.weekly, null);
});

test("handles array-valued headers (IncomingHttpHeaders can be string[])", () => {
  const rec = buildQuotaRecord(
    {
      "anthropic-ratelimit-unified-5h-utilization": ["0.33"] as any,
      "anthropic-ratelimit-unified-5h-status": ["allowed"] as any,
    },
    1
  );
  assert.ok(rec);
  assert.equal(rec.session?.utilization, 0.33);
  assert.equal(rec.session?.status, "allowed");
});

test("a status-only window yields a record with null utilization (not dropped)", () => {
  const rec = buildQuotaRecord(
    { "anthropic-ratelimit-unified-7d-status": "rejected" },
    1
  );
  assert.ok(rec);
  assert.equal(rec.session, null);
  assert.equal(rec.weekly?.utilization, null);
  assert.equal(rec.weekly?.status, "rejected");
});

// ---- Fable weekly pool (unified-7d_oi-*) ----

test("parses the Fable weekly pool (7d_oi) with its own capturedAtMs", () => {
  const rec = buildQuotaRecord(
    {
      "anthropic-ratelimit-unified-5h-utilization": "0.17",
      "anthropic-ratelimit-unified-7d-utilization": "0.27",
      "anthropic-ratelimit-unified-7d_oi-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-reset": "1783483200",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.08",
    },
    5000
  );
  assert.ok(rec);
  assert.deepEqual(rec.fable, {
    utilization: 0.08,
    resetEpoch: 1783483200,
    status: "allowed",
    capturedAtMs: 5000,
  });
});

test("a Fable-only response (no 5h/7d) still yields a record", () => {
  // Defensive: the hasFable branch of the clobber gate keeps a Fable reading.
  const rec = buildQuotaRecord(
    { "anthropic-ratelimit-unified-7d_oi-utilization": "0.08" },
    1
  );
  assert.ok(rec);
  assert.equal(rec.fable?.utilization, 0.08);
  assert.equal(rec.session, null);
  assert.equal(rec.weekly, null);
});

test("mergeFableForward carries a prior Fable reading onto a non-Fable record", () => {
  const prev = buildQuotaRecord(
    {
      "anthropic-ratelimit-unified-7d-utilization": "0.27",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.08",
      "anthropic-ratelimit-unified-7d_oi-reset": "1783483200",
    },
    1000
  );
  // A later Haiku/Opus call — no 7d_oi header this time.
  const next = buildQuotaRecord(
    { "anthropic-ratelimit-unified-7d-utilization": "0.30" },
    9000
  );
  assert.ok(prev && next);
  assert.equal(next.fable, null, "the fresh non-Fable record has no fable of its own");
  const merged = mergeFableForward(prev, next);
  assert.equal(merged.weekly?.utilization, 0.3, "fresh weekly is kept");
  assert.equal(merged.fable?.utilization, 0.08, "prior Fable reading is carried forward");
  assert.equal(merged.fable?.capturedAtMs, 1000, "carried-forward Fable keeps its own timestamp");
});

test("mergeFableForward prefers a fresh Fable reading over the prior one", () => {
  const prev = buildQuotaRecord(
    { "anthropic-ratelimit-unified-7d_oi-utilization": "0.08" },
    1000
  );
  const next = buildQuotaRecord(
    { "anthropic-ratelimit-unified-7d_oi-utilization": "0.11" },
    9000
  );
  assert.ok(prev && next);
  const merged = mergeFableForward(prev, next);
  assert.equal(merged.fable?.utilization, 0.11);
  assert.equal(merged.fable?.capturedAtMs, 9000);
});
