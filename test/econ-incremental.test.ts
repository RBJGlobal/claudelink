// Pins incremental transcript economics: latestTurnEconomics keeps its fold
// state per file and reads only appended bytes. Results must match a fresh
// full scan, a partially written last line must be read once it completes,
// and a shrunk file must be rescanned from the start.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestTurnEconomics } from "../src/context-watcher.js";

const turn = (ts: string, input: number, model = "claude-opus-5") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { model, usage: { input_tokens: input, output_tokens: 1 } } }) + "\n";

test("appends are folded incrementally and match the latest turn", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  fs.writeFileSync(f, turn("2026-10-23T10:00:00Z", 1000));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 1000);

  fs.appendFileSync(f, turn("2026-10-23T10:05:00Z", 5000, "claude-opus-5-5"));
  const r = await latestTurnEconomics(f);
  assert.equal(r!.contextTokens, 5000);
  assert.equal(r!.model, "claude-opus-5-5");
});

test("an older-timestamp line appended later does not win (latest-ts guard)", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  fs.writeFileSync(f, turn("2026-10-23T10:05:00Z", 5000));
  await latestTurnEconomics(f);
  fs.appendFileSync(f, turn("2026-10-23T09:00:00Z", 999));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 5000);
});

test("a partial last line is picked up once complete, exactly once", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  fs.writeFileSync(f, turn("2026-10-23T10:00:00Z", 1000));
  const next = turn("2026-10-23T10:10:00Z", 7000);
  fs.appendFileSync(f, next.slice(0, 30));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 1000);
  fs.appendFileSync(f, next.slice(30));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 7000);
});

test("a compact boundary appended later sets post-compact occupancy", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  fs.writeFileSync(f, turn("2026-10-23T10:00:00Z", 164000));
  await latestTurnEconomics(f);
  fs.appendFileSync(
    f,
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-23T10:01:00Z", compactMetadata: { postTokens: 12000 } }) + "\n"
  );
  const r = await latestTurnEconomics(f);
  assert.equal(r!.contextTokens, 12000);
  assert.equal(r!.model, "claude-opus-5");
});

test("a shrunk file is rescanned from the start", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  fs.writeFileSync(f, turn("2026-10-23T10:00:00Z", 1000) + turn("2026-10-23T10:01:00Z", 2000));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 2000);
  fs.writeFileSync(f, turn("2026-10-23T11:00:00Z", 300));
  assert.equal((await latestTurnEconomics(f))!.contextTokens, 300);
});

test("concurrent calls on one file agree and don't double-count", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-econ-")), "t.jsonl");
  let body = "";
  for (let i = 0; i < 50; i++) body += turn(`2026-10-23T10:${String(i).padStart(2, "0")}:00Z`, 1000 + i);
  fs.writeFileSync(f, body);
  const rs = await Promise.all([latestTurnEconomics(f), latestTurnEconomics(f), latestTurnEconomics(f)]);
  for (const r of rs) assert.equal(r!.contextTokens, 1049);
  // turns/hour over the last 20 one-minute-apart turns = 60/h.
  assert.equal(Math.round(rs[0]!.turnsPerHour), 60);
});
