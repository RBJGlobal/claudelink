// Recovery Watcher pattern regression tests. This is where false-positives /
// false-negatives have crept in repeatedly (v1.4.0/1/2 each fixed one). The
// distance-from-end guard + the per-pattern shape constraints together are
// the load-bearing safety properties; this test pins them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectError } from "../src/recovery-watcher.js";

// Realistic CLI chrome that lives BELOW a real error in the visible buffer
// (empty prompt + separator + auto-mode footer). The distance-from-end
// guard is calibrated against this shape.
const CHROME =
  "\n\n────────────────────────────────────────────────────\n>  \n\n   ⏵⏵ auto mode on \n";

// ---- The new (2026-05-29) safety-classifier auto-mode pattern (commit ad7ef82) ----

test("fires on verbatim Opus/WebFetch classifier failure", () => {
  const body =
    "claude-opus-4-7 is temporarily unavailable, so auto mode cannot determine the safety of WebFetch right now. Wait briefly and then try this action again." +
    CHROME;
  const r = detectError(body);
  assert.ok(r, "must match the verbatim classifier-down error near tail");
});

test("fires on Sonnet/Bash variant", () => {
  const body =
    "claude-sonnet-4-6 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait briefly." +
    CHROME;
  const r = detectError(body);
  assert.ok(r, "model name and tool name vary; the clause is invariant");
});

test("fires on Opus/WebSearch variant", () => {
  const body =
    "claude-opus-4-7 is temporarily unavailable, so auto mode cannot determine the safety of WebSearch right now." +
    CHROME;
  const r = detectError(body);
  assert.ok(r);
});

test("does NOT fire on prose mention buried 1500+ chars from tail", () => {
  // The agent could be writing about the error in conversation. The
  // distance-from-end guard must keep this case quiet.
  const body =
    "Yes the agent reported the classifier error, 'is temporarily unavailable, so auto mode cannot determine the safety of WebFetch', yesterday and I retried it.\n" +
    "x".repeat(1500) +
    "\n>  \n";
  const r = detectError(body);
  assert.equal(r, null, "buried prose mention must NOT fire");
});

// ---- Existing rate-limit pattern regressions ----

test("fires on the canonical 'Server is temporarily limiting requests' line", () => {
  const body = "API Error: Server is temporarily limiting requests" + CHROME;
  const r = detectError(body);
  assert.ok(r);
});

test("fires on 'API Error: ... rate_limit_error'", () => {
  const body = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}' + CHROME;
  const r = detectError(body);
  assert.ok(r);
});

test("fires on 'API Error: 529 overloaded_error' multi-line shape (soft-wrap)", () => {
  // iTerm2 wraps long error lines with real \n. The pattern uses lazy
  // [\\s\\S]{0,N}? to bridge the wrap; this regression test pins that.
  const body =
    'API Error: 529 \n{"type":"error",\n"error":{"type":"overloaded_error",\n"message":"server overloaded"}}' +
    CHROME;
  const r = detectError(body);
  assert.ok(r);
});

test("does NOT fire on unrelated text", () => {
  const body = "All quiet on the western front, agent working on src/index.ts.\n>  \n";
  const r = detectError(body);
  assert.equal(r, null);
});

test("does NOT fire on someone discussing rate-limiting in prose, not as a CLI error", () => {
  // The design rule: rate-limit patterns require an "Error:" prefix near
  // the keyword. Without it, an agent describing rate-limiting in chat
  // (e.g. a build-log writer) shouldn't trigger.
  const body =
    "Talking about how the rate limit on Anthropic's API works — when you hit the rate_limit_error you should wait briefly.\n" +
    CHROME;
  const r = detectError(body);
  assert.equal(r, null, "prose mention without Error: prefix must NOT fire");
});

test("fires on the closest-to-end match when the SAME error appears twice (v1.4.2 regression)", () => {
  // v1.4.0/1 used scrollback.match() which locked onto the FIRST occurrence;
  // when Claude Code rendered the same error twice (initial failure + retry)
  // the first one was OUT OF RANGE, the second was IN RANGE, but match()
  // returned the first → no fire. The fix walks all matches and picks the
  // nearest-to-end. This test pins that behavior.
  const oldCopy = "API Error: 429 Too Many Requests";
  const newCopy = "API Error: 429 Too Many Requests";
  // Old copy far above; new copy near tail.
  const body =
    oldCopy + "\n" + "x".repeat(2000) + "\n" + newCopy + CHROME;
  const r = detectError(body);
  assert.ok(r, "must catch the nearer-to-tail copy");
});

// ---- Signature canonicalization (de-dup correctness) ----

test("same error with different (hex) request IDs has the SAME canonicalized signature", () => {
  // Without canonicalization, every retry attempt would have a fresh request
  // ID → fresh signature → de-dup fails → repeated re-fires. The canonical
  // form replaces ≥8-char hex tokens with #, so two hex IDs collapse to the
  // same signature. (Real Anthropic request IDs ARE hex.)
  const a =
    "API Error: 429 (req_id: abc12345def67890) Server is temporarily limiting requests" +
    CHROME;
  const b =
    "API Error: 429 (req_id: deadbeefcafe1234) Server is temporarily limiting requests" +
    CHROME;
  const ra = detectError(a);
  const rb = detectError(b);
  assert.ok(ra && rb, "both must fire");
  assert.equal(
    ra.signature,
    rb.signature,
    "different hex request IDs must collapse to the same canonical signature"
  );
});
