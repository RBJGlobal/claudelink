// Role-collision UX guards (#2 register warning, #3 send fan-out notice).
// The formatters are pure, so the wording + the "no collision" null path are
// pinned here independently of the MCP server boot path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  roleCollisionWarning,
  fanoutNotice,
} from "../src/role-collision.js";

// ---- #2 roleCollisionWarning ----

test("roleCollisionWarning returns null when the role has no other live holders", () => {
  assert.equal(roleCollisionWarning("developer", []), null);
});

test("roleCollisionWarning names the colliding siblings and the count", () => {
  const w = roleCollisionWarning("developer", [
    { role: "developer", description: "Acme dev" },
    { role: "developer", description: "Globex dev" },
  ]);
  assert.ok(w);
  assert.match(w!, /already held by 2 other live agent/);
  assert.match(w!, /Acme dev/);
  assert.match(w!, /Globex dev/);
  // Steers the operator toward the fix.
  assert.match(w!, /unique, project-qualified role/);
});

test("roleCollisionWarning falls back to the role when a sibling has no description", () => {
  const w = roleCollisionWarning("developer", [{ role: "developer", description: null }]);
  assert.ok(w);
  assert.match(w!, /• developer/);
});

test("roleCollisionWarning truncates an over-long description", () => {
  const long = "x".repeat(200);
  const w = roleCollisionWarning("dev", [{ role: "dev", description: long }]);
  assert.ok(w);
  assert.match(w!, /\.\.\./);
  assert.ok(!w!.includes(long), "full 200-char description must not appear verbatim");
});

// ---- #3 fanoutNotice ----

test("fanoutNotice returns null for the normal single-recipient send", () => {
  assert.equal(fanoutNotice("reviewer", [{ role: "reviewer", description: "the one" }]), null);
  assert.equal(fanoutNotice("reviewer", []), null);
});

test("fanoutNotice lists every recipient when a role matched more than one", () => {
  const n = fanoutNotice("developer", [
    { role: "developer", description: "Acme dev" },
    { role: "developer", description: "ClaudeLink dev" },
    { role: "developer", description: "Globex dev" },
  ]);
  assert.ok(n);
  assert.match(n!, /matched 3 agents/);
  assert.match(n!, /Acme dev/);
  assert.match(n!, /ClaudeLink dev/);
  assert.match(n!, /Globex dev/);
  assert.match(n!, /target a unique role/);
});
