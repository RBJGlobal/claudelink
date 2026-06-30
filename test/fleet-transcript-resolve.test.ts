// Regression for the shared-repo misattribution bug (2026-06-30).
//
// In a project dir shared by several agents, every agent's transcript is a
// separate .jsonl. The fleet display used to return the agent's own captured
// transcript_path ONLY while its mtime was fresh (<30min); once stale it fell
// back to "most-recent .jsonl in the dir" — which in a shared repo is ANOTHER
// agent's session. Symptom in practice: several idle terminals sharing one repo
// (real ~70–82K context each) all displayed a single peer's much larger ~572K
// number, because that peer's transcript was the newest file in the shared dir.
//
// The fix: the read-only display resolver trusts the agent's OWN transcript_path
// whenever the file EXISTS, regardless of mtime. A stale own-transcript is the
// terminal's real last size (unchanged because it's idle) — correct — whereas the
// dir-heuristic fallback misattributes a peer's context. (The mtime-staleness
// fallback stays in the INJECTION path, resolveSession, where targeting a wrong
// live session is a write hazard; observation has no such risk.)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findFleetTranscript } from "../src/ui-server.js";

test("findFleetTranscript returns the agent's OWN transcript even when it is older than a peer's in the same dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-fleet-resolve-"));
  const own = path.join(dir, "own-session.jsonl");
  const peer = path.join(dir, "peer-session.jsonl");

  // Both files exist; the agent's OWN file is OLDER than the peer's (the exact
  // shape that used to trip the staleness fallback into returning the peer).
  fs.writeFileSync(own, "{}\n");
  fs.writeFileSync(peer, "{}\n");
  const old = Date.now() / 1000 - 60 * 60; // 1h ago, well past the old 30min gate
  const recent = Date.now() / 1000 - 30; // 30s ago
  fs.utimesSync(own, old, old);
  fs.utimesSync(peer, recent, recent);

  const resolved = findFleetTranscript({ pid: process.pid, transcript_path: own });
  assert.equal(
    resolved,
    own,
    "must return the agent's own (older) transcript, not the newer peer's — no cross-agent misattribution"
  );
});

test("findFleetTranscript falls back to the dir heuristic only when the own path is missing", () => {
  // No own transcript_path → pre-v3 agent; the resolver may use the dir heuristic
  // (which needs a live cwd for `pid`). With a path that does not exist, it must
  // NOT return that dead path — it falls through. We assert it does not echo the
  // bogus path back (heuristic result depends on the live process, so we only pin
  // the "don't return the missing own path" contract).
  const missing = path.join(os.tmpdir(), "definitely-not-here-" + process.pid + ".jsonl");
  const resolved = findFleetTranscript({ pid: process.pid, transcript_path: missing });
  assert.notEqual(resolved, missing, "a non-existent own path must never be returned as-is");
});
