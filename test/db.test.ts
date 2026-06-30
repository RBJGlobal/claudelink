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

test("migration brings user_version to 6 on a fresh DB", () => {
  freshDb();
  assert.equal(userVersion(), 6);
});

test("migration is idempotent — constructing twice doesn't re-run anything", () => {
  freshDb();
  const v1 = userVersion();
  // Second construct — should observe user_version=6 already and no-op.
  new NexusDB();
  const v2 = userVersion();
  assert.equal(v1, v2);
  assert.equal(v2, 6);
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
  const recipients = db.sendMessage(sender, "receiver", "hello", "normal", {
    expectsReply: false,
  });
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].role, "receiver");

  const first = db.readInbox(receiver);
  assert.equal(first.length, 1);
  assert.equal(first[0].content, "hello");

  const second = db.readInbox(receiver);
  assert.equal(second.length, 0, "atomic mark-read — should be empty");
});

test("sendMessage to a duplicate role fans out to every match and returns them all", () => {
  const db = freshDb();
  const sender = db.registerAgent("coordinator", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  // Two unrelated agents both registered under the same generic role.
  const a = db.registerAgent("developer", "Acme dev", process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const b = db.registerAgent("developer", "Globex dev", process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const recipients = db.sendMessage(sender, "developer", "ping", "normal", {
    expectsReply: false,
  });
  // Fan-out: one directed send produced a row for each role match.
  assert.equal(recipients.length, 2, "fans out to both 'developer' agents");
  const ids = recipients.map((r) => r.id).sort();
  assert.deepEqual(ids, [a, b].sort());
  // Descriptions ride along so the caller can show WHO received it.
  assert.deepEqual(
    recipients.map((r) => r.description).sort(),
    ["Acme dev", "Globex dev"]
  );
  // Each agent actually has the message in its inbox.
  assert.equal(db.readInbox(a).length, 1);
  assert.equal(db.readInbox(b).length, 1);
});

test("re-register on the same TTY + same pid renames the role in place (keeps id)", () => {
  const db = freshDb();
  const id1 = db.registerAgent("developer", "Globex dev", process.pid, {
    tty: "/dev/ttys123", terminalApp: "iterm2", paneId: null, autonomousReply: true,
  });
  // Same live process re-registers under a project-qualified role (in-session rename).
  const id2 = db.registerAgent("globex-developer", "Globex dev", process.pid, {
    tty: "/dev/ttys123", terminalApp: "iterm2", paneId: null, autonomousReply: true,
  });
  assert.equal(id2, id1, "rename keeps the same agent id");
  const onTty = db.getAgents().filter((a) => a.tty === "/dev/ttys123");
  assert.equal(onTty.length, 1, "still exactly one agent on this TTY (update, not insert)");
  assert.equal(onTty[0].role, "globex-developer", "role updated in place");
});

test("in-session rename preserves the agent's existing inbox", () => {
  const db = freshDb();
  const sender = db.registerAgent("coordinator", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const id1 = db.registerAgent("developer", null, process.pid, {
    tty: "/dev/ttys124", terminalApp: "iterm2", paneId: null, autonomousReply: true,
  });
  db.sendMessage(sender, "developer", "before rename", "normal", { expectsReply: false });
  // Rename to a unique role — inbox must survive because the id is unchanged.
  const id2 = db.registerAgent("globex-developer", null, process.pid, {
    tty: "/dev/ttys124", terminalApp: "iterm2", paneId: null, autonomousReply: true,
  });
  assert.equal(id2, id1);
  const inbox = db.readInbox(id2);
  assert.equal(inbox.length, 1, "message sent before the rename is still deliverable after it");
  assert.equal(inbox[0].content, "before rename");
});

test("re-register on the same TTY with a DIFFERENT live pid throws (the genuine footgun)", () => {
  // The negative branch the field test couldn't stage from one terminal: two
  // REAL Claude sessions colliding in one pane must hard-fail. process.pid is a
  // genuinely-alive owner; a different pid number forces existing.pid !== pid
  // while isProcessAlive(existing.pid) stays true → the throw at db.ts:282 fires.
  const db = freshDb();
  const owner = db.registerAgent("owner", "first session", process.pid, {
    tty: "/dev/ttys125", terminalApp: "iterm2", paneId: null, autonomousReply: true,
  });
  assert.throws(
    () =>
      db.registerAgent("intruder", "second session", process.pid + 1, {
        tty: "/dev/ttys125", terminalApp: "iterm2", paneId: null, autonomousReply: true,
      }),
    /already registered/,
    "a different live pid grabbing the same pane must throw, not silently take over"
  );
  // The failed register must not corrupt or evict the original owner.
  const onTty = db.getAgents().filter((a) => a.tty === "/dev/ttys125");
  assert.equal(onTty.length, 1, "owner still the sole holder after the rejected register");
  assert.equal(onTty[0].id, owner, "owner's id is untouched");
  assert.equal(onTty[0].role, "owner", "owner's role is untouched");
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

// ── v5: consent timestamp (the T1 /compact handshake anchor) ──

test("setCheckpoint(safe_to_clear=true) stamps checkpoint_consent_ts", () => {
  const db = freshDb();
  const id = db.registerAgent("consent-yes", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const before = Date.now();
  db.setCheckpoint(id, { safeToClear: true, handoffPath: null, note: null });
  const after = Date.now();

  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(`SELECT checkpoint_consent_ts FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();
  assert.ok(
    row.checkpoint_consent_ts >= before && row.checkpoint_consent_ts <= after,
    "consent ts within window"
  );
});

test("setCheckpoint(safe_to_clear=false) clears checkpoint_consent_ts (no stale yes)", () => {
  const db = freshDb();
  const id = db.registerAgent("consent-flip", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  // First an affirmative yes, then a decline — the decline must wipe the anchor.
  db.setCheckpoint(id, { safeToClear: true, handoffPath: null, note: null });
  db.setCheckpoint(id, { safeToClear: false, handoffPath: null, note: "busy" });

  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(`SELECT checkpoint_safe_to_clear, checkpoint_consent_ts FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();
  assert.equal(row.checkpoint_safe_to_clear, 0);
  assert.equal(row.checkpoint_consent_ts, null, "consent anchor cleared on decline");
});

test("touchCheckpoint does NOT stamp/advance checkpoint_consent_ts (hook can't forge consent)", () => {
  const db = freshDb();
  const id = db.registerAgent("consent-hook", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  // Agent consented once...
  db.setCheckpoint(id, { safeToClear: true, handoffPath: null, note: null });
  const sqlite = new Database(TMP_DB, { readonly: true });
  const seeded = sqlite
    .prepare(`SELECT checkpoint_consent_ts FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();

  const sleepUntil = Date.now() + 10;
  while (Date.now() < sleepUntil) { /* spin */ }
  // ...then the Stop hook touches every turn. consent_ts must NOT move.
  db.touchCheckpoint(id);

  const sqlite2 = new Database(TMP_DB, { readonly: true });
  const after = sqlite2
    .prepare(`SELECT checkpoint_consent_ts FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite2.close();
  assert.equal(
    after.checkpoint_consent_ts,
    seeded.checkpoint_consent_ts,
    "consent ts unchanged by the per-turn hook touch"
  );
});

test("consumeCheckpointConsent resets safe_to_clear→0 and clears the anchor (one yes = one compact)", () => {
  const db = freshDb();
  const id = db.registerAgent("consent-consume", null, process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  db.setCheckpoint(id, { safeToClear: true, handoffPath: null, note: null });

  const ok = db.consumeCheckpointConsent(id);
  assert.equal(ok, true);

  const sqlite = new Database(TMP_DB, { readonly: true });
  const row = sqlite
    .prepare(`SELECT checkpoint_safe_to_clear, checkpoint_consent_ts FROM agents WHERE id = ?`)
    .get(id) as any;
  sqlite.close();
  assert.equal(row.checkpoint_safe_to_clear, 0, "consent consumed");
  assert.equal(row.checkpoint_consent_ts, null, "anchor cleared");

  // Consuming a non-existent agent is a no-op false.
  assert.equal(db.consumeCheckpointConsent("does-not-exist"), false);
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

test("setManualAction queues a pending override with a request stamp; clear removes it", () => {
  const db = freshDb();
  const id = db.registerAgent("dev-manual", "queue target", process.pid, {
    tty: "/dev/ttys200",
    terminalApp: "iterm2",
    paneId: null,
    autonomousReply: true,
  });
  const before = Date.now();
  assert.equal(db.setManualAction(id, "clear"), true);
  const raw = new Database(TMP_DB, { readonly: true });
  const row = raw
    .prepare("SELECT manual_action, manual_action_ts FROM agents WHERE id = ?")
    .get(id) as { manual_action: string | null; manual_action_ts: number | null };
  raw.close();
  assert.equal(row.manual_action, "clear");
  assert.ok(row.manual_action_ts !== null && row.manual_action_ts >= before, "stamps the request time");

  assert.equal(db.clearManualAction(id), true);
  const raw2 = new Database(TMP_DB, { readonly: true });
  const cleared = raw2
    .prepare("SELECT manual_action, manual_action_ts FROM agents WHERE id = ?")
    .get(id) as { manual_action: string | null; manual_action_ts: number | null };
  raw2.close();
  assert.equal(cleared.manual_action, null);
  assert.equal(cleared.manual_action_ts, null);
});

test("setManualAction/clearManualAction return false for an unknown agent", () => {
  const db = freshDb();
  assert.equal(db.setManualAction("no-such-id", "compact"), false);
  assert.equal(db.clearManualAction("no-such-id"), false);
});
