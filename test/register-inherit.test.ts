// Pins mail inheritance across a re-registration. An agent that exits and
// registers again gets a new id; unread mail sent to the old id must follow it.
// Found in the 2026-11-19 fleet restore test: a message sent seconds before the
// re-registration stayed unread on the dead id and read_inbox said "no unread".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-inherit-"));
const TMP_DB = path.join(TMP_DIR, "nexus.db");
process.env.CLAUDELINK_DB_PATH = TMP_DB;

import { NexusDB, registeredBeforeBoot } from "../src/db.js";

const DEAD_A = 999_991;
const DEAD_B = 999_992;
const opts = (tty: string) => ({ tty, terminalApp: "iterm2", paneId: null, autonomousReply: true });

function freshDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    if (fs.existsSync(TMP_DB + ext)) fs.unlinkSync(TMP_DB + ext);
  }
  return new NexusDB();
}
const raw = (sql: string, ...p: any[]) => {
  const d = new Database(TMP_DB, { readonly: true });
  try { return d.prepare(sql).all(...p); } finally { d.close(); }
};

test("unread mail sent to a dead id follows the role to its new id", () => {
  const db = freshDb();
  const sender = db.registerAgent("Sender", null, process.pid, opts("/dev/ttys800"));
  const oldId = db.registerAgent("Advisor", null, DEAD_A, opts("/dev/ttys801"));
  db.sendMessage(sender, "Advisor", "sent while the advisor was restarting");
  const newId = db.registerAgent("Advisor", null, process.pid, opts("/dev/ttys801"));
  assert.notEqual(newId, oldId);
  const inbox = db.readInbox(newId);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "sent while the advisor was restarting");
  assert.equal(raw(`SELECT 1 FROM agents WHERE id = ?`, oldId).length, 0);
  db.close();
});

test("after a restart, the first agent to register does not strand the others' mail", () => {
  const db = freshDb();
  // Both alive while the message is sent, then the machine "restarts".
  const a = db.registerAgent("Alpha", null, process.pid, opts("/dev/ttys810"));
  const b = db.registerAgent("Beta", null, process.pid, opts("/dev/ttys811"));
  db.sendMessage(a, "Beta", "for beta, unread at restart");
  const w = new Database(TMP_DB);
  w.prepare(`UPDATE agents SET pid = ? WHERE id = ?`).run(DEAD_A, a);
  w.prepare(`UPDATE agents SET pid = ? WHERE id = ?`).run(DEAD_B, b);
  w.close();
  // Alpha comes back first; its register prunes dead rows.
  const a2 = db.registerAgent("Alpha", null, process.pid, opts("/dev/ttys810"));
  // Beta's dead row is kept because mail is waiting for it.
  assert.equal(raw(`SELECT 1 FROM agents WHERE id = ?`, b).length, 1);
  const b2 = db.registerAgent("Beta", null, process.pid, opts("/dev/ttys811"));
  const inbox = db.readInbox(b2);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "for beta, unread at restart");
  // The sender shown is Alpha's new id, since Alpha's old id is gone.
  assert.equal(inbox[0].from_agent, a2);
  assert.equal(raw(`SELECT 1 FROM agents WHERE id IN (?, ?)`, a, b).length, 0);
  db.close();
});

test("a dead agent with no unread mail is still pruned", () => {
  const db = freshDb();
  const dead = db.registerAgent("Ghost", null, DEAD_A, opts("/dev/ttys820"));
  db.registerAgent("Live", null, process.pid, opts("/dev/ttys821"));
  assert.equal(raw(`SELECT 1 FROM agents WHERE id = ?`, dead).length, 0);
  db.close();
});

test("mail already read is not handed to the new id", () => {
  const db = freshDb();
  const sender = db.registerAgent("Sender", null, process.pid, opts("/dev/ttys830"));
  const oldId = db.registerAgent("Advisor", null, DEAD_A, opts("/dev/ttys831"));
  db.sendMessage(sender, "Advisor", "old news");
  db.readInbox(oldId);
  const newId = db.registerAgent("Advisor", null, process.pid, opts("/dev/ttys831"));
  assert.equal(db.readInbox(newId).length, 0);
  db.close();
});

test("a different role taking over a dead agent's terminal does not inherit its mail", () => {
  const db = freshDb();
  const sender = db.registerAgent("Sender", null, process.pid, opts("/dev/ttys840"));
  db.registerAgent("Advisor", null, DEAD_A, opts("/dev/ttys841"));
  db.sendMessage(sender, "Advisor", "for the advisor only");
  const other = db.registerAgent("Developer", null, process.pid, opts("/dev/ttys841"));
  assert.equal(db.readInbox(other).length, 0);
  db.close();
});

test("registeredBeforeBoot: only a readable timestamp older than boot (with slack) counts", () => {
  const boot = Date.parse("2026-11-20T15:00:00Z");
  assert.equal(registeredBeforeBoot("2026-11-20 14:00:00", boot), true);
  assert.equal(registeredBeforeBoot("2026-11-20 14:59:30", boot), false); // inside the 60 s slack
  assert.equal(registeredBeforeBoot("2026-11-20 15:05:00", boot), false);
  assert.equal(registeredBeforeBoot(null, boot), false);
  assert.equal(registeredBeforeBoot("not a date", boot), false);
});

test("after a reboot, an old row whose pid number is in use again is still a predecessor", () => {
  const db = freshDb();
  const sender = db.registerAgent("Sender", null, process.pid, opts("/dev/ttys820"));
  // Old registration: its pid number now belongs to a live process (this one),
  // but it was made long before the machine booted.
  const oldId = db.registerAgent("Advisor", null, DEAD_A, opts("/dev/ttys821"));
  db.sendMessage(sender, "Advisor", "sent before the reboot");
  const w = new Database(TMP_DB);
  w.prepare(`UPDATE agents SET pid = ?, registered_at = '2001-01-01 00:00:00', last_seen = '2001-01-01 00:00:00' WHERE id = ?`).run(process.pid, oldId);
  w.close();
  assert.equal(db.getAgents().find((a) => a.id === oldId)?.alive, false);
  const newId = db.registerAgent("Advisor", null, process.pid, opts("/dev/ttys821"));
  assert.notEqual(newId, oldId);
  assert.equal(db.lastRegisterCarriedOver, 1);
  const inbox = db.readInbox(newId);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "sent before the reboot");
  assert.equal(raw(`SELECT 1 FROM agents WHERE id = ?`, oldId).length, 0);
  db.close();
});

test("a register with nothing to inherit reports zero carried over", () => {
  const db = freshDb();
  db.registerAgent("Solo", null, process.pid, opts("/dev/ttys830"));
  assert.equal(db.lastRegisterCarriedOver, 0);
  db.close();
});

test("a live agent with an old registered_at but a fresh heartbeat stays alive", () => {
  // A wall-clock step forward moves the computed boot time; registered_at is
  // written once and must not be what decides liveness.
  const db = freshDb();
  const id = db.registerAgent("Longrunner", null, process.pid, opts("/dev/ttys840"));
  const w = new Database(TMP_DB);
  w.prepare(`UPDATE agents SET registered_at = '2001-01-01 00:00:00' WHERE id = ?`).run(id);
  w.close();
  assert.equal(db.getAgents().find((a) => a.id === id)?.alive, true);
  db.close();
});

test("a dead row of another role on a reused tty keeps its mail for its own role", () => {
  const db = freshDb();
  const sender = db.registerAgent("Sender", null, process.pid, opts("/dev/ttys850"));
  const oldAdvisor = db.registerAgent("Advisor", null, DEAD_A, opts("/dev/ttys851"));
  db.sendMessage(sender, "Advisor", "waiting for the advisor");
  // After the restart a different seat lands on the advisor's old tty first.
  const dev = db.registerAgent("Developer", null, process.pid, opts("/dev/ttys851"));
  assert.equal(db.readInbox(dev).length, 0);
  assert.equal(raw(`SELECT tty FROM agents WHERE id = ?`, oldAdvisor).length, 1);
  const newAdvisor = db.registerAgent("Advisor", null, process.pid, opts("/dev/ttys852"));
  assert.equal(db.lastRegisterCarriedOver, 1);
  const inbox = db.readInbox(newAdvisor);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].content, "waiting for the advisor");
  assert.equal(raw(`SELECT 1 FROM agents WHERE id = ?`, oldAdvisor).length, 0);
  db.close();
});
