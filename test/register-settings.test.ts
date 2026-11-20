// Registration settings survive a restart: an omitted option falls back to
// what the role registered with last time. Found in the 2026-11-20 restart:
// an advisor seat had to recall that it registers with autonomousReply false.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-rolesettings-"));
process.env.CLAUDELINK_DB_PATH = path.join(TMP_DIR, "nexus.db");

import { NexusDB } from "../src/db.js";
import { resolveRegisterSettings } from "../src/register-settings.js";

test("first registration: defaults, nothing restored", () => {
  assert.deepEqual(resolveRegisterSettings({}, null), {
    description: null,
    autonomousReply: true,
    restored: [],
  });
});

test("omitted options fall back to the previous registration", () => {
  const r = resolveRegisterSettings({}, { description: "advises the founder", autonomousReply: false });
  assert.equal(r.description, "advises the founder");
  assert.equal(r.autonomousReply, false);
  assert.deepEqual(r.restored, ["description", "autonomousReply=false"]);
});

test("an explicit value always wins over the previous registration", () => {
  const r = resolveRegisterSettings(
    { description: "new work", autonomousReply: true },
    { description: "old work", autonomousReply: false }
  );
  assert.deepEqual(r, { description: "new work", autonomousReply: true, restored: [] });
  const off = resolveRegisterSettings({ autonomousReply: false }, { description: null, autonomousReply: true });
  assert.equal(off.autonomousReply, false);
});

test("a previous autonomousReply=true is kept silently", () => {
  const r = resolveRegisterSettings({}, { description: null, autonomousReply: true });
  assert.deepEqual(r, { description: null, autonomousReply: true, restored: [] });
});

test("role settings persist in the database and are overwritten by the next save", () => {
  const db = new NexusDB();
  assert.equal(db.getRoleSettings("Advisor"), null);
  db.saveRoleSettings("Advisor", "advises", false);
  assert.deepEqual(db.getRoleSettings("Advisor"), { description: "advises", autonomousReply: false });
  db.saveRoleSettings("Advisor", null, true);
  assert.deepEqual(db.getRoleSettings("Advisor"), { description: null, autonomousReply: true });
  db.close();
  // A second connection (another terminal, or the same one after a restart) sees it.
  const db2 = new NexusDB();
  assert.deepEqual(db2.getRoleSettings("Advisor"), { description: null, autonomousReply: true });
  db2.close();
});

test("an explicit empty description clears the stored one", () => {
  const r = resolveRegisterSettings({ description: "" }, { description: "old work", autonomousReply: true });
  assert.equal(r.description, null);
  assert.deepEqual(r.restored, []);
});
