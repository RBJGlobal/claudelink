// Pins which unread messages wake an agent: every message from another agent,
// FYIs included, so a task mislabeled as an FYI never sits unread waiting for
// the operator's next prompt. An agent's messages to itself never wake it.

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

test("a normal-priority FYI wakes the recipient", () => {
  const db = freshDb();
  send(db, { expectsReply: 0 });
  assert.deepEqual(roles(db), ["Recipient"]);
  assert.equal(hasUnreadMail(db, "recipient"), true);
});

test("a low-priority FYI wakes the recipient", () => {
  const db = freshDb();
  send(db, { expectsReply: 0, priority: "low" });
  assert.deepEqual(roles(db), ["Recipient"]);
});

test("an FYI broadcast wakes everyone but the sender", () => {
  const db = freshDb();
  send(db, { to: null, expectsReply: 0 });
  assert.deepEqual(roles(db), ["Recipient"]);
  assert.equal(hasUnreadMail(db, "sender"), false);
});

test("a message an agent sent to itself does not wake it", () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO messages (from_agent, to_agent, content, expects_reply) VALUES ('recipient', 'recipient', 'x', 0)`
  ).run();
  assert.deepEqual(roles(db), []);
  assert.equal(hasUnreadMail(db, "recipient"), false);
});

test("a read message does not wake anyone", () => {
  const db = freshDb();
  send(db, { expectsReply: 0 });
  db.prepare(`UPDATE messages SET read = 1`).run();
  assert.deepEqual(roles(db), []);
});
