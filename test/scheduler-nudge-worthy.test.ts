// Pins which unread messages wake an agent. A nudge forces a full turn, and
// every turn re-reads the agent's whole context, so waking an agent for an
// FYI is pure quota burn. FYIs are surfaced on the operator's next prompt by
// the UserPromptSubmit hook instead. High priority still wakes, so explicit
// wake-ups and urgent FYIs keep working.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { selectCandidates, hasUnreadMail } from "../src/scheduler.js";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, role TEXT, tty TEXT, terminal_app TEXT,
      pane_id TEXT, pid INTEGER, autonomous_reply INTEGER DEFAULT 1
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT,
      content TEXT, priority TEXT DEFAULT 'normal', read INTEGER DEFAULT 0,
      expects_reply INTEGER NOT NULL DEFAULT 1
    );
  `);
  const ins = db.prepare(
    `INSERT INTO agents (id, role, tty, terminal_app, pid) VALUES (?, ?, ?, 'iterm2', ?)`
  );
  // process.pid so the liveness filter keeps them.
  ins.run("sender", "Sender", "/dev/ttys900", process.pid);
  ins.run("recipient", "Recipient", "/dev/ttys901", process.pid);
  return db;
}

function send(db: Database.Database, opts: { to?: string | null; expectsReply: 0 | 1; priority?: string }) {
  db.prepare(
    `INSERT INTO messages (from_agent, to_agent, content, priority, expects_reply)
     VALUES ('sender', ?, 'x', ?, ?)`
  ).run(opts.to === undefined ? "recipient" : opts.to, opts.priority ?? "normal", opts.expectsReply);
}

const roles = (db: Database.Database) => selectCandidates(db).map((c) => c.role).sort();

test("a message that expects a reply wakes the recipient", () => {
  const db = freshDb();
  send(db, { expectsReply: 1 });
  assert.deepEqual(roles(db), ["Recipient"]);
  assert.equal(hasUnreadMail(db, "recipient"), true);
});

test("a normal-priority FYI does NOT wake the recipient", () => {
  const db = freshDb();
  send(db, { expectsReply: 0 });
  assert.deepEqual(roles(db), []);
  assert.equal(hasUnreadMail(db, "recipient"), false);
});

test("a low-priority FYI does NOT wake the recipient", () => {
  const db = freshDb();
  send(db, { expectsReply: 0, priority: "low" });
  assert.deepEqual(roles(db), []);
});

test("a high-priority FYI still wakes, so explicit wake-ups keep working", () => {
  const db = freshDb();
  send(db, { expectsReply: 0, priority: "high" });
  assert.deepEqual(roles(db), ["Recipient"]);
  assert.equal(hasUnreadMail(db, "recipient"), true);
});

test("an FYI broadcast wakes no one; a reply-expected broadcast wakes everyone but the sender", () => {
  const db = freshDb();
  send(db, { to: null, expectsReply: 0 });
  assert.deepEqual(roles(db), []);
  send(db, { to: null, expectsReply: 1 });
  assert.deepEqual(roles(db), ["Recipient"]);
});

test("an FYI alongside a reply-expected message still wakes for the latter", () => {
  const db = freshDb();
  send(db, { expectsReply: 0 });
  send(db, { expectsReply: 1 });
  assert.deepEqual(roles(db), ["Recipient"]);
});
