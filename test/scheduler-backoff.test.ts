// Pins the unanswered-nudge backoff: a terminal that does not read its inbox
// is nudged a few times, then left alone until a newer message arrives or the
// terminal shows activity. Without it one idle terminal was nudged 531 times
// in a night.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  nudgeDecision,
  unreadSnapshot,
  MAX_UNANSWERED_NUDGES,
  NudgeState,
} from "../src/scheduler.js";

// Simulates the scheduler: decide, and on a nudge record the attempt.
function attempt(prev: NudgeState | undefined, newest: number, active: number | null, now: number) {
  const d = nudgeDecision(prev, newest, active);
  if (d.nudge) {
    d.state.attempts++;
    d.state.lastAttemptAt = now;
  }
  return d;
}

test("first sight of unread mail nudges", () => {
  assert.equal(nudgeDecision(undefined, 5, null).nudge, true);
});

test("stops after the limit when nothing changes", () => {
  let st: NudgeState | undefined;
  const results: boolean[] = [];
  for (let i = 0; i < MAX_UNANSWERED_NUDGES + 4; i++) {
    const d = attempt(st, 5, null, 1000 + i);
    st = d.state;
    results.push(d.nudge);
  }
  assert.equal(results.filter(Boolean).length, MAX_UNANSWERED_NUDGES);
  assert.deepEqual(results.slice(MAX_UNANSWERED_NUDGES), [false, false, false, false]);
});

test("a newer message starts the count again", () => {
  let st: NudgeState | undefined;
  for (let i = 0; i < MAX_UNANSWERED_NUDGES + 1; i++) st = attempt(st, 5, null, 1000 + i).state;
  assert.equal(nudgeDecision(st, 5, null).nudge, false);
  const d = nudgeDecision(st, 6, null);
  assert.equal(d.nudge, true);
  assert.equal(d.state.attempts, 0);
  assert.equal(d.state.newestUnreadId, 6);
});

test("terminal activity after the last attempt starts the count again", () => {
  let st: NudgeState | undefined;
  for (let i = 0; i < MAX_UNANSWERED_NUDGES; i++) st = attempt(st, 5, 500, 1000 + i).state;
  assert.equal(nudgeDecision(st, 5, 500).nudge, false); // activity older than attempts
  const d = nudgeDecision(st, 5, 9000);
  assert.equal(d.nudge, true);
  assert.equal(d.state.attempts, 0);
});

test("activity does not reset the count before any attempt was made", () => {
  const st: NudgeState = { newestUnreadId: 5, attempts: 0, lastAttemptAt: 0, backoffLogged: true };
  const d = nudgeDecision(st, 5, 9000);
  assert.equal(d.nudge, true);
  assert.equal(d.state, st); // same state object, not a reset
});

test("unreadSnapshot returns the newest unread id and the activity stamp", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, last_seen_active_ts INTEGER);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT, read INTEGER DEFAULT 0
    );
    INSERT INTO agents VALUES ('a', 777), ('b', NULL);
    INSERT INTO messages (from_agent, to_agent, read) VALUES
      ('b', 'a', 1), ('b', 'a', 0), ('b', NULL, 0), ('a', 'a', 0), ('a', NULL, 0);
  `);
  // a: directed id 2 and b's broadcast id 3 count; a's own (4, 5) do not.
  assert.deepEqual(unreadSnapshot(db, "a"), { newestUnreadId: 3, lastActiveTs: 777 });
  // b: only a's broadcast id 5 counts.
  assert.deepEqual(unreadSnapshot(db, "b"), { newestUnreadId: 5, lastActiveTs: null });
  db.exec(`UPDATE messages SET read = 1`);
  assert.equal(unreadSnapshot(db, "a"), null);
});

test("unreadSnapshot tolerates a database without the activity column", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT, read INTEGER DEFAULT 0
    );
    INSERT INTO agents VALUES ('a');
    INSERT INTO messages (from_agent, to_agent) VALUES ('b', 'a');
  `);
  assert.deepEqual(unreadSnapshot(db, "a"), { newestUnreadId: 1, lastActiveTs: null });
});
