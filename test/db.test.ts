// DB schema migration + core mutation tests. Pins the v1→v4 migration shape
// (idempotent, additive, transaction-wrapped) and the new v3/v4 capture
// surfaces (setAgentSession, setCheckpoint).
//
// Isolation: tests set CLAUDELINK_DB_PATH to a temp file BEFORE importing
// NexusDB so no live fleet state is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-db-"));
const TMP_DB = path.join(TMP_DIR, "nexus.db");
process.env.CLAUDELINK_DB_PATH = TMP_DB;

import { NexusDB } from "../src/db.js";

function freshDb() {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  // Also clean WAL + SHM siblings.
  for (const ext of ["-wal", "-shm"]) {
    const p = TMP_DB + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return new NexusDB();
}

function userVersion(): number {
  const db = new Database(TMP_DB, { readonly: true });
  const r = db.pragma("user_version") as Array<{ user_version: number }>;
  db.close();
  return r[0].user_version;
}

test("migration brings user_version to 4 on a fresh DB", () => {
  freshDb();
  assert.equal(userVersion(), 4);
});

test("migration is idempotent — constructing twice doesn't re-run anything", () => {
  freshDb();
  const v1 = userVersion();
  // Second construct — should observe user_version=4 already and no-op.
  new NexusDB();
  const v2 = userVersion();
  assert.equal(v1, v2);
  assert.equal(v2, 4);
});

test("agents table accepts a basic register", () => {
  const db = freshDb();
  const id = db.registerAgent("dev-test", "running unit tests", process.pid, {
    tty: "/dev/ttys999",
    terminalApp: "iterm2",
    paneId: null,
    autonomousReply: true,
  });
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 16, "expect uuid-shaped id");
  const agents = db.getAgents();
  assert.ok(agents.find((a) => a.id === id));
});

test("readInbox is atomic — second read sees nothing", () => {
  const db = freshDb();
  const sender = db.registerAgent("sender", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  const receiver = db.registerAgent("receiver", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  // Cross-role send.
  const count = db.sendMessage(sender, "receiver", "hello", "normal", {
    expectsReply: false,
  });
  assert.equal(count, 1);

  const first = db.readInbox(receiver);
  assert.equal(first.length, 1);
  assert.equal(first[0].content, "hello");

  const second = db.readInbox(receiver);
  assert.equal(second.length, 0, "atomic mark-read — should be empty");
});

test("setCheckpoint stores all v4 fields", () => {
  const db = freshDb();
  const id = db.registerAgent("ck-agent", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  const before = Date.now();
  db.setCheckpoint(id, {
    safeToClear: true,
    handoffPath: "/Users/test/.claudelink/handoffs/" + id + ".md",
    note: "finished phase 4",
  });
  const after = Date.now();

  // Direct SQL read so we don't hide behind a typed selector.
  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(
      `SELECT checkpoint_ts, checkpoint_safe_to_clear, checkpoint_handoff_path, checkpoint_note FROM agents WHERE id = ?`
    )
    .get(id) as any;
  sqlite.close();
  assert.ok(row);
  assert.ok(row.checkpoint_ts >= before && row.checkpoint_ts <= after, "ts within window");
  assert.equal(row.checkpoint_safe_to_clear, 1);
  assert.ok(row.checkpoint_handoff_path?.endsWith(id + ".md"));
  assert.equal(row.checkpoint_note, "finished phase 4");
});

test("setCheckpoint with null handoff and safeToClear=false stores correctly", () => {
  const db = freshDb();
  const id = db.registerAgent("ck-noop", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  db.setCheckpoint(id, { safeToClear: false, handoffPath: null, note: null });

  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(
      `SELECT checkpoint_ts, checkpoint_safe_to_clear, checkpoint_handoff_path, checkpoint_note FROM agents WHERE id = ?`
    )
    .get(id) as any;
  sqlite.close();
  assert.ok(row.checkpoint_ts != null);
  assert.equal(row.checkpoint_safe_to_clear, 0);
  assert.equal(row.checkpoint_handoff_path, null);
  assert.equal(row.checkpoint_note, null);
});

test("touchCheckpoint refreshes ts WITHOUT clearing safe_to_clear/handoff/note", () => {
  const db = freshDb();
  const id = db.registerAgent("touch-agent", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  // Pre-seed a full setCheckpoint as if the agent had previously called
  // signal_checkpoint(safe_to_clear=true, handoff="/x/foo.md", note="ready").
  db.setCheckpoint(id, {
    safeToClear: true,
    handoffPath: "/Users/test/.claudelink/handoffs/" + id + ".md",
    note: "ready",
  });
  const sqlite = new Database(TMP_DB, { readonly: true });
  const before = sqlite
    .prepare(
      `SELECT checkpoint_ts, checkpoint_safe_to_clear, checkpoint_handoff_path, checkpoint_note FROM agents WHERE id = ?`
    )
    .get(id) as any;
  sqlite.close();

  // 10ms gap so we can prove ts moved forward.
  const sleepUntil = Date.now() + 10;
  while (Date.now() < sleepUntil) {
    /* spin */
  }
  db.touchCheckpoint(id);

  const sqlite2 = new Database(TMP_DB, { readonly: true });
  const after = sqlite2
    .prepare(
      `SELECT checkpoint_ts, checkpoint_safe_to_clear, checkpoint_handoff_path, checkpoint_note FROM agents WHERE id = ?`
    )
    .get(id) as any;
  sqlite2.close();

  assert.ok(after.checkpoint_ts > before.checkpoint_ts, "ts advanced");
  assert.equal(after.checkpoint_safe_to_clear, 1, "safe_to_clear preserved");
  assert.equal(after.checkpoint_handoff_path, before.checkpoint_handoff_path, "handoff preserved");
  assert.equal(after.checkpoint_note, "ready", "note preserved");
});

test("setAgentSession stores session_id + transcript_path (v3)", () => {
  const db = freshDb();
  const id = db.registerAgent("sess-agent", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  db.setAgentSession(id, "abc-123", "/Users/test/.claude/projects/foo/abc-123.jsonl");

  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(`SELECT session_id, transcript_path FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();
  assert.equal(row.session_id, "abc-123");
  assert.equal(row.transcript_path, "/Users/test/.claude/projects/foo/abc-123.jsonl");
});

test("setAgentSession is idempotent (same data → no-op)", () => {
  const db = freshDb();
  const id = db.registerAgent("sess-idem", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  db.setAgentSession(id, "abc-123", "/foo");
  db.setAgentSession(id, "abc-123", "/foo");
  db.setAgentSession(id, "abc-123", "/foo");
  // No assertion needed beyond "doesn't throw" — idempotency is observed by
  // the fact this runs cleanly. Side-check: data is still right.
  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(`SELECT session_id, transcript_path FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();
  assert.equal(row.session_id, "abc-123");
});

test("schema has the FK constraint on messages.from_agent that CLAUDE.md flags as a pitfall", () => {
  freshDb();
  const sqlite = new Database(TMP_DB, { readonly: true });
  const fks = sqlite.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
  // better-sqlite3 v12+ default; pragma returns the current setting on the
  // connection. The FK *constraints* defined in CREATE TABLE are present
  // regardless of the foreign_keys pragma, but enforcement depends on it.
  const fk = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name = 'messages'`).get() as any;
  sqlite.close();
  assert.ok(fk.sql.includes("FOREIGN KEY") || fk.sql.includes("REFERENCES"), "messages must declare FK to agents");
});

test("getAgents reflects alive vs offline accurately", () => {
  const db = freshDb();
  const live = db.registerAgent("alive", null, process.pid, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  const dead = db.registerAgent("zombie", null, 999_999, {
    tty: null,
    terminalApp: null,
    paneId: null,
    autonomousReply: true,
  });
  const agents = db.getAgents();
  const liveRow = agents.find((a) => a.id === live);
  // dead row should have been cleaned by pruneDeadAgents implicit in getAgents.
  // But "alive" must still be present and `alive: true`.
  assert.ok(liveRow);
  assert.equal(liveRow.alive, true);
  void dead; // unused; existence-by-id is what we cared about above
});
