// Pins the actionable message shown when the SQLite native addon is missing
// (npm 11.19+ skips dependency install scripts by default) or was built for a
// different Node.js ABI. Without it the MCP server dies with an opaque
// "Could not locate the bindings file" that users only find in client logs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { explainSqliteLoadError } from "../src/db.js";

test("missing addon explains npm's blocked install script and the fix", () => {
  const hint = explainSqliteLoadError(
    new Error("Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node")
  );
  assert.ok(hint);
  assert.match(hint!, /install scripts/);
  assert.match(hint!, /npm install -g claudelink --allow-scripts=better-sqlite3/);
});

test("ABI mismatch is recognized by code and by message", () => {
  const byCode = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
  assert.match(explainSqliteLoadError(byCode)!, /different Node\.js version/);
  const byMsg = new Error(
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127."
  );
  assert.match(explainSqliteLoadError(byMsg)!, /--allow-scripts=better-sqlite3/);
});

test("unrelated errors pass through untouched", () => {
  assert.equal(explainSqliteLoadError(new Error("SQLITE_BUSY: database is locked")), null);
  assert.equal(explainSqliteLoadError("weird"), null);
});
