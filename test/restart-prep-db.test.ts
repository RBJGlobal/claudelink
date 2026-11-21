// Runs the per-terminal query of the parked view against the real schema, so
// a column rename cannot silently drop the view (the query sits in a
// try/catch that would hide it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-prep-"));
process.env.CLAUDELINK_DB_PATH = path.join(TMP_DIR, "nexus.db");

import { NexusDB } from "../src/db.js";
import { askAllToPrepare, currentPrepStatus } from "../src/restart-prep.js";

test("the parked view query runs on the current schema", async () => {
  const nexus = new NexusDB();
  // No tty: the prompt is typed to nobody, so nothing is sent to a terminal.
  nexus.registerAgent("Alpha", "", process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const db = new Database(process.env.CLAUDELINK_DB_PATH as string);
  await askAllToPrepare(db);
  const s = currentPrepStatus(db);
  assert.ok(s);
  assert.deepEqual(s.rows, []); // undefined here would mean the query failed
  assert.equal(s.safe, false);
  db.close();
});

test("a turn ending does not count as confirming; signal_checkpoint does", () => {
  const nexus = new NexusDB();
  const agentId = nexus.registerAgent("Beta", "", process.pid, {
    tty: null, terminalApp: null, paneId: null, autonomousReply: true,
  });
  const db = new Database(process.env.CLAUDELINK_DB_PATH as string);
  const signal = () =>
    (db.prepare(`SELECT checkpoint_signal_ts AS t FROM agents WHERE id = ?`).get(agentId) as { t: number | null }).t;
  nexus.touchCheckpoint(agentId); // what the Stop hook does
  assert.equal(signal(), null);
  nexus.setCheckpoint(agentId, { safeToClear: false, handoffPath: null, note: "ready for restart" });
  assert.ok((signal() as number) > 0);
  db.close();
});
