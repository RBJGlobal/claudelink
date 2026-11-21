// Pins who counts as ready after "Prepare for restart": an agent whose
// checkpoint stamp is newer than the click.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prepStatus, prepRows, prepSafe, confirmation, PARK_ACTIVITY_SLACK_MS, RESTART_PREP_TEXT } from "../src/restart-prep.js";

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

const f = (checkpointTs: number | null, unread = 0, unreadHigh = 0, lastActivityMs: number | null = null) =>
  ({ checkpointTs, unread, unreadHigh, lastActivityMs });

test("one row per terminal: parked, waiting, not reached", () => {
  const rows = prepRows(
    req,
    new Map([["a", f(1500, 2, 0)], ["b", f(900)], ["c", f(null, 1, 1)]]),
    new Map([["Epsilon", f(null, 3, 1)]])
  );
  assert.deepEqual(rows.map((r) => [r.role, r.state, r.unread, r.unreadHigh]), [
    ["Alpha", "parked", 2, 0],
    ["Beta", "waiting", 0, 0],
    ["Gamma", "waiting", 1, 1],
    ["Delta", "waiting", 0, 0], // agent row is gone
    ["Epsilon", "not-reached", 3, 1],
  ]);
  assert.equal(prepSafe(rows), false);
});

test("safe only when every terminal is parked, quiet and has no unread high-priority mail", () => {
  const one = { at: 1000, asked: [{ id: "a", role: "Alpha" }], failed: [] as string[] };
  const safe = (x: ReturnType<typeof f>) => prepSafe(prepRows(one, new Map([["a", x]])));
  assert.equal(safe(f(1500, 4, 0)), true); // ordinary unread mail does not block
  assert.equal(safe(f(1500, 1, 1)), false); // unread high-priority mail blocks
  assert.equal(safe(f(900)), false);
  assert.equal(prepSafe([]), false); // nobody asked is not "safe"
  assert.equal(prepSafe(prepRows({ ...one, failed: ["Beta"] }, new Map([["a", f(1500)]]))), false);
});

test("work clearly after the confirmation marks the terminal as still active", () => {
  const one = { at: 1000, asked: [{ id: "a", role: "Alpha" }], failed: [] as string[] };
  const row = (last: number | null, ts: number | null = 1500) =>
    prepRows(one, new Map([["a", f(ts, 0, 0, last)]]))[0];
  assert.equal(row(1500 + PARK_ACTIVITY_SLACK_MS).activeAfterPark, false); // the reply itself
  assert.equal(row(1500 + PARK_ACTIVITY_SLACK_MS + 1).activeAfterPark, true);
  assert.equal(row(null).activeAfterPark, false); // no transcript known
  assert.equal(row(999999999, 900).activeAfterPark, false); // not parked: already "waiting"
  assert.equal(prepSafe([row(1500 + PARK_ACTIVITY_SLACK_MS + 1)]), false);
});

test("a terminal with a new id since the click shows the role's mail and stays waiting", () => {
  const one = { at: 1000, asked: [{ id: "old", role: "Alpha" }], failed: [] as string[] };
  const rows = prepRows(one, new Map(), new Map([["Alpha", f(null, 2, 1)]]));
  assert.deepEqual(rows.map((r) => [r.state, r.unread, r.unreadHigh]), [["waiting", 2, 1]]);
});

test("confirmation comes from the agent's own signal, never from a turn ending", () => {
  // a 1.6.19 server stamps the signal time
  assert.deepEqual(confirmation(1500, "ready for restart", 1000), { ts: 1500, timeKnown: true });
  // signalled before the click: the old time is kept, so it reads as waiting
  assert.deepEqual(confirmation(900, null, 1000), { ts: 900, timeKnown: true });
  // an older server: the note was cleared at the click and is back
  assert.deepEqual(confirmation(null, "ready for restart", 1000), { ts: 1001, timeKnown: false });
  // nothing since the click
  assert.deepEqual(confirmation(null, null, 1000), { ts: null, timeKnown: false });
  assert.deepEqual(confirmation(undefined, "", 1000), { ts: null, timeKnown: false });
});

test("without a known confirmation time, kept-working is not claimed", () => {
  const one = { at: 1000, asked: [{ id: "a", role: "Alpha" }], failed: [] as string[] };
  const row = prepRows(one, new Map([["a", { ...f(1001, 0, 0, 99999999), confirmTimeKnown: false }]]))[0];
  assert.equal(row.state, "parked");
  assert.equal(row.activeAfterPark, false);
});
