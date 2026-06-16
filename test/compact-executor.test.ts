// Tests for the handoff path validation + placeholder-aware verifyHandoff
// added 2026-06-12. These guard the load-bearing safety properties that no
// agent-supplied path can satisfy the handoff gate with /etc/passwd, and that
// an agent that wrote the template stub verbatim doesn't pass the >200-byte
// check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HANDOFF_DIR,
  HANDOFF_TEMPLATE,
  isHandoffPathSafe,
  verifyHandoff,
  handoffPathFor,
} from "../src/compact-executor.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-test-"));

test("isHandoffPathSafe accepts paths under HANDOFF_DIR", () => {
  assert.equal(isHandoffPathSafe(path.join(HANDOFF_DIR, "agent.md")), true);
  assert.equal(isHandoffPathSafe(path.join(HANDOFF_DIR, "sub", "agent.md")), true);
  assert.equal(isHandoffPathSafe(HANDOFF_DIR), true); // the dir itself
});

test("isHandoffPathSafe REJECTS paths outside HANDOFF_DIR", () => {
  assert.equal(isHandoffPathSafe("/etc/passwd"), false);
  assert.equal(isHandoffPathSafe("/tmp/handoff.md"), false);
  assert.equal(isHandoffPathSafe(path.join(os.homedir(), "handoff.md")), false);
});

test("isHandoffPathSafe rejects a path that LOOKS LIKE a sibling of HANDOFF_DIR", () => {
  // The straight-string-prefix bug: ~/.claudelink/handoffs-evil/foo would
  // start with the HANDOFF_DIR prefix but be a different directory. We use
  // path.resolve + the path.sep check to catch this.
  const sibling = HANDOFF_DIR + "-evil";
  assert.equal(isHandoffPathSafe(sibling), false);
  assert.equal(isHandoffPathSafe(path.join(sibling, "foo.md")), false);
});

test("isHandoffPathSafe rejects relative-traversal attempts", () => {
  // A relative path resolved against the watcher's cwd. The semantics here
  // are that an agent MUST send an absolute path under HANDOFF_DIR — relative
  // paths that resolve elsewhere are rejected. (A relative path that happens
  // to resolve under HANDOFF_DIR would pass, but that requires the watcher's
  // cwd to be inside ~/.claudelink/handoffs/ which we never do.)
  assert.equal(isHandoffPathSafe("../etc/passwd"), false);
  assert.equal(isHandoffPathSafe("handoff.md"), false);
});

test("isHandoffPathSafe doesn't crash on weird input", () => {
  assert.equal(isHandoffPathSafe(""), false);
});

test("verifyHandoff rejects missing files", () => {
  const v = verifyHandoff(path.join(TMP_ROOT, "does-not-exist.md"));
  assert.equal(v.ok, false);
  assert.equal(v.bytes, 0);
});

test("verifyHandoff rejects files under 200 bytes", () => {
  const f = path.join(TMP_ROOT, "tiny.md");
  fs.writeFileSync(f, "short");
  const v = verifyHandoff(f);
  assert.equal(v.ok, false);
});

test("verifyHandoff REJECTS the HANDOFF_TEMPLATE verbatim — the regression that motivated this", () => {
  // The original gate was just `>200 bytes`. HANDOFF_TEMPLATE itself is
  // ~270 bytes. An agent that copied the template and didn't fill anything
  // in would pass the original byte check. The placeholder scan must
  // reject this.
  const f = path.join(TMP_ROOT, "template-only.md");
  fs.writeFileSync(f, HANDOFF_TEMPLATE);
  assert.ok(HANDOFF_TEMPLATE.length > 200, "template should be >200 bytes — guard the test");
  const v = verifyHandoff(f);
  assert.equal(v.ok, false, "template stub MUST be rejected");
  assert.ok(v.bytes > 200, "but the byte count must be reported truthfully");
});

test("verifyHandoff REJECTS partial fill-in (one placeholder remaining)", () => {
  // Even if the agent filled in most sections, an unfilled placeholder
  // anywhere means the handoff is incomplete.
  const f = path.join(TMP_ROOT, "partial.md");
  fs.writeFileSync(
    f,
    `# Handoff
## Current task & progress
Working on the auth refactor, midway through.
Lots of detail here about what was decided and the rationale for each choice,
this fills enough content to exceed the 200-byte threshold by a comfortable margin.

## Key decisions / context you must NOT lose
<constraints, choices already made, facts that won't be re-derivable>

## Exact next step
Run the test suite and confirm green.
`
  );
  const v = verifyHandoff(f);
  assert.equal(v.ok, false, "partial fill MUST be rejected when ANY placeholder remains");
});

test("verifyHandoff ACCEPTS a fully-filled handoff", () => {
  const f = path.join(TMP_ROOT, "filled.md");
  fs.writeFileSync(
    f,
    `# Handoff for the auth-refactor branch
## Current task & progress
Working on the JWT refresh flow, three of four endpoints converted to the new
shape, the fourth (PATCH /session) needs the test-fixture update before it
can land. PR currently 80% reviewed.

## Key decisions / context you must NOT lose
- We chose RS256 over HS256 for the signing algorithm; symmetric secrets
  rotation is too painful at scale.
- Refresh tokens are HttpOnly + SameSite=Lax; mobile clients use a separate
  bearer flow.

## Exact next step
Finish the PATCH /session migration and rerun the integration suite.

## Open threads
Awaiting product on whether to deprecate the v1 endpoints in this release
or hold them through Q3.
`
  );
  const v = verifyHandoff(f);
  assert.equal(v.ok, true, "filled handoff must pass");
});

test("handoffPathFor returns a path under HANDOFF_DIR", () => {
  const p = handoffPathFor("agent-1234");
  assert.ok(p.startsWith(HANDOFF_DIR), `${p} should start with ${HANDOFF_DIR}`);
  // And the returned path is itself safe (round-trip property)
  assert.equal(isHandoffPathSafe(p), true);
});
