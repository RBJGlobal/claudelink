// Pins who counts as ready after "Prepare for restart": an agent whose
// checkpoint stamp is newer than the click.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prepStatus, RESTART_PREP_TEXT } from "../src/restart-prep.js";

const req = {
  at: 1000,
  asked: [{ id: "a", role: "Alpha" }, { id: "b", role: "Beta" }, { id: "c", role: "Gamma" }, { id: "d", role: "Delta" }],
  failed: ["Epsilon"],
};

test("ready means a checkpoint newer than the click", () => {
  const s = prepStatus(req, new Map<string, number | null>([["a", 1500], ["b", 900], ["c", null]]));
  assert.deepEqual(s.ready, ["Alpha"]);
  // older stamp, no stamp, and an agent that is gone all keep waiting
  assert.deepEqual(s.waiting, ["Beta", "Gamma", "Delta"]);
  assert.deepEqual(s.failed, ["Epsilon"]);
});

test("the prompt asks for safe_to_clear=false so it is never compact consent", () => {
  assert.match(RESTART_PREP_TEXT, /safe_to_clear=false/);
  assert.doesNotMatch(RESTART_PREP_TEXT, /safe_to_clear=true/);
  assert.doesNotMatch(RESTART_PREP_TEXT, /["\n]/);
});
