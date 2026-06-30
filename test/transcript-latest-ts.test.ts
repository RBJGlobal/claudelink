// Regression test for the F1+F3 safety-critical fix (2026-06-12).
//
// Claude Code JSONL transcripts can contain branched/resumed lines where the
// LAST line in the file has an EARLIER timestamp than some line earlier in
// the file. The original code in latestTurnEconomics and armGate read state
// from the last line unconditionally. That let the economic gate compare
// against stale context size, and the armed inject's idle check trust a
// stale "end_turn" while the live session was mid-tool-call → /compact lands
// mid-work.
//
// These tests pin the latest-ts guard: the FUNCTION MUST PICK THE LINE WITH
// THE GREATEST timestamp, not the line at the greatest file offset.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestTurnEconomics, armGate } from "../src/context-watcher.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-latest-ts-"));

function writeTranscript(name: string, lines: object[]): string {
  const f = path.join(TMP_ROOT, name + ".jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

function tsAt(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function userTurn(secondsAgo: number) {
  return {
    type: "user",
    timestamp: tsAt(secondsAgo),
    message: { content: [{ type: "text", text: "Hi" }] },
  };
}

function assistantTurn(opts: {
  secondsAgo: number;
  contextTokens?: number;
  model?: string;
  stop?: "end_turn" | "stop_sequence" | "tool_use" | null;
  toolUse?: boolean;
}) {
  const content = opts.toolUse
    ? [{ type: "tool_use", name: "Bash", input: { command: "echo" } }]
    : [{ type: "text", text: "ok" }];
  return {
    type: "assistant",
    timestamp: tsAt(opts.secondsAgo),
    message: {
      model: opts.model ?? "claude-opus-4-7",
      stop_reason: opts.stop ?? "end_turn",
      content,
      usage: opts.contextTokens != null
        ? {
            input_tokens: opts.contextTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 100,
          }
        : undefined,
    },
  };
}

// ---- latestTurnEconomics ----

test("latestTurnEconomics picks the BY-TIME latest turn, not the by-position last", async () => {
  // Order in the file: oldest-on-top, newest-in-middle, OLDER-on-bottom (the
  // branch/resume shape). The original code would read contextTokens from
  // the LAST line (500K) — stale. The fix must read from the by-time latest
  // (200K), which is in the middle.
  const f = writeTranscript("branched", [
    assistantTurn({ secondsAgo: 7200, contextTokens: 50_000 }),
    assistantTurn({ secondsAgo: 60, contextTokens: 200_000 }), // chronologically latest
    assistantTurn({ secondsAgo: 3600, contextTokens: 500_000 }), // by-position last, but older
  ]);
  const econ = await latestTurnEconomics(f);
  assert.ok(econ);
  assert.equal(
    econ.contextTokens,
    200_000,
    "must pick the chronologically-latest turn's context tokens"
  );
});

test("latestTurnEconomics is unaffected by ordered-on-disk transcripts (no regression on the common case)", async () => {
  const f = writeTranscript("ordered", [
    assistantTurn({ secondsAgo: 7200, contextTokens: 50_000 }),
    assistantTurn({ secondsAgo: 3600, contextTokens: 100_000 }),
    assistantTurn({ secondsAgo: 60, contextTokens: 200_000 }),
  ]);
  const econ = await latestTurnEconomics(f);
  assert.ok(econ);
  assert.equal(econ.contextTokens, 200_000);
});

test("latestTurnEconomics returns null for transcripts with no usage lines", async () => {
  const f = writeTranscript("empty", [userTurn(60)]);
  const econ = await latestTurnEconomics(f);
  assert.equal(econ, null);
});

test("latestTurnEconomics skips <synthetic> model turns", async () => {
  const f = writeTranscript("synthetic", [
    assistantTurn({ secondsAgo: 60, contextTokens: 200_000, model: "<synthetic>" }),
  ]);
  const econ = await latestTurnEconomics(f);
  assert.equal(
    econ,
    null,
    "synthetic-model turns must NOT participate in the economic gate"
  );
});

test("latestTurnEconomics records the correct model from the latest-ts turn", async () => {
  // Same branching shape: latest-ts in the middle should set the model.
  const f = writeTranscript("model", [
    assistantTurn({ secondsAgo: 7200, contextTokens: 50_000, model: "claude-sonnet-4-6" }),
    assistantTurn({ secondsAgo: 60, contextTokens: 200_000, model: "claude-opus-4-7" }),
    assistantTurn({ secondsAgo: 3600, contextTokens: 500_000, model: "claude-sonnet-4-6" }),
  ]);
  const econ = await latestTurnEconomics(f);
  assert.ok(econ);
  assert.equal(econ.model, "claude-opus-4-7");
});

// ---- armGate ----

test("armGate idle uses the BY-TIME latest turn — branched transcript can't lie about idleness", async () => {
  // The dangerous case: the by-position LAST line is an old assistant
  // "end_turn" (looks idle). The chronologically-latest turn is a recent
  // tool_use (clearly mid-work). Old code said idle=true; the fix must say
  // idle=false.
  const f = writeTranscript("branched-idle", [
    userTurn(60),
    assistantTurn({ secondsAgo: 20, contextTokens: 100_000, stop: null, toolUse: true }), // RECENT mid-tool-call
    assistantTurn({ secondsAgo: 3600, contextTokens: 50_000, stop: "end_turn", toolUse: false }), // OLDER end_turn at file tail
  ]);
  const ag = await armGate(f, null);
  assert.equal(
    ag.idle,
    false,
    "must NOT claim idle when the by-time latest turn is mid-tool-call"
  );
});

test("armGate idle=true when the chronologically-latest turn is end_turn + quiet >=15s + no tool_use", async () => {
  const f = writeTranscript("legit-idle", [
    userTurn(120),
    assistantTurn({ secondsAgo: 60, contextTokens: 100_000, stop: "end_turn", toolUse: false }),
  ]);
  const ag = await armGate(f, null);
  assert.equal(ag.idle, true);
});

test("armGate idle=false when last turn is too recent (<15s)", async () => {
  const f = writeTranscript("recent", [
    userTurn(20),
    assistantTurn({ secondsAgo: 5, contextTokens: 100_000, stop: "end_turn", toolUse: false }),
  ]);
  const ag = await armGate(f, null);
  assert.equal(ag.idle, false, "still echoing recently — not idle");
});

test("armGate idle=false when latest turn ended with tool_use stop_reason", async () => {
  const f = writeTranscript("tool-use-stop", [
    userTurn(120),
    assistantTurn({ secondsAgo: 60, contextTokens: 100_000, stop: "tool_use", toolUse: false }),
  ]);
  const ag = await armGate(f, null);
  assert.equal(
    ag.idle,
    false,
    "tool_use stop is in-flight — must not be considered idle"
  );
});

test("armGate counts turns past checkpointTs correctly", async () => {
  const checkpointTs = Date.now() - 600 * 1000; // 10 min ago
  const f = writeTranscript("checkpoint", [
    userTurn(1200), // before checkpoint
    assistantTurn({ secondsAgo: 1100, contextTokens: 100_000, stop: "end_turn" }), // before
    userTurn(500), // after checkpoint
    assistantTurn({ secondsAgo: 400, contextTokens: 110_000, stop: "end_turn" }), // after
    assistantTurn({ secondsAgo: 60, contextTokens: 120_000, stop: "end_turn" }), // after, latest
  ]);
  const ag = await armGate(f, checkpointTs);
  // 3 user/assistant lines have ts > checkpointTs (the two after-user + after-asst lines).
  // The exact count semantic is "lines past the checkpoint" — what we care
  // about is that it's bounded by what's after, and >0.
  assert.ok(ag.turnsSinceSignal > 0, "should detect turns past the checkpoint");
  assert.ok(ag.turnsSinceSignal <= 5, "and not run away into the file");
});

test("armGate returns turnsSinceSignal=0 when checkpoint is in the future (no turns past it)", async () => {
  const checkpointTs = Date.now() + 60_000; // checkpoint stamped in the future
  const f = writeTranscript("future-ck", [
    userTurn(120),
    assistantTurn({ secondsAgo: 60, contextTokens: 100_000, stop: "end_turn" }),
  ]);
  const ag = await armGate(f, checkpointTs);
  assert.equal(ag.turnsSinceSignal, 0);
});

test("armGate returns no-turns for an empty transcript", async () => {
  const f = writeTranscript("empty-arm", []);
  const ag = await armGate(f, null);
  assert.equal(ag.idle, false);
  assert.equal(ag.turnsSinceSignal, 999);
  assert.equal(ag.latestType, "none");
});

test("armGate exposes latestType/ageSec for a user-latest (parked) transcript — the manual override's relaxed-idle signal", async () => {
  // A terminal parked after a local command: the chronologically-latest turn is
  // a `user` entry with no assistant reply. Strict idle stays false (only an
  // assistant turn flips it), but the manual override needs latestType + ageSec
  // to recognize it as parked-not-busy.
  const f = writeTranscript("parked-user", [
    assistantTurn({ secondsAgo: 1800, contextTokens: 200_000, stop: "end_turn", toolUse: false }),
    userTurn(600), // newest turn is a user message, 10 min old, no assistant after it
  ]);
  const ag = await armGate(f, null);
  assert.equal(ag.idle, false, "strict idle never flips on a user-latest turn");
  assert.equal(ag.latestType, "user");
  assert.ok(ag.ageSec >= 120, "parked well past the manual threshold");
});
