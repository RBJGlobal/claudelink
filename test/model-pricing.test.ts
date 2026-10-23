// Pins model list prices (USD per 1M tokens, checked 2026-10-23). The old
// table matched only "opus" / "haiku" and sent everything else to Sonnet, so
// current Opus showed ~3x too expensive and Fable ~3.3x too cheap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFor, cacheReadPricePerMtok, MAX_CACHE_READ_PER_MTOK } from "../src/usage-reader.js";

const io = (m: string) => {
  const p = priceFor(m);
  return p ? [p.input, p.output] : null;
};

test("current Opus generations are $5/$25, Opus 5.5 is $4/$20", () => {
  for (const m of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"]) {
    assert.deepEqual(io(m), [5, 25], m);
  }
  assert.deepEqual(io("claude-opus-5-5"), [4, 20]);
});

test("Fable is priced above Opus, not as Sonnet", () => {
  assert.deepEqual(io("claude-fable-5"), [10, 50]);
  assert.deepEqual(io("claude-fable-5-1"), [10, 50]);
  assert.deepEqual(io("claude-mythos-5-1"), [10, 50]);
});

test("Sonnet and Haiku generations", () => {
  assert.deepEqual(io("claude-sonnet-5-5"), [2, 10]);
  assert.deepEqual(io("claude-sonnet-5"), [2, 10]);
  assert.deepEqual(io("claude-sonnet-4-6"), [3, 15]);
  assert.deepEqual(io("claude-haiku-4-5-20251001"), [1, 5]);
  assert.deepEqual(io("claude-haiku-5-5"), [0.1, 0.5]);
});

test("older Opus keeps the old price", () => {
  assert.deepEqual(io("claude-opus-4-1-20250805"), [15, 75]);
});

test("published cache-read prices override the 0.1x default", () => {
  assert.equal(cacheReadPricePerMtok("claude-opus-5-5"), 0.2);
  assert.equal(cacheReadPricePerMtok("claude-sonnet-5-5"), 0.2);
  assert.equal(cacheReadPricePerMtok("claude-fable-5-1"), 0.25);
  assert.equal(cacheReadPricePerMtok("claude-opus-5"), 0.5);
});

test("cache writes are 1.25x input", () => {
  assert.equal(priceFor("claude-opus-5")!.cacheWrite, 6.25);
});

test("unknown ids and bare aliases are unpriced, never given Sonnet's price", () => {
  assert.equal(priceFor("some-new-model"), null);
  assert.equal(priceFor(""), null);
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) assert.equal(priceFor(alias), null, alias);
  assert.equal(cacheReadPricePerMtok("some-new-model"), 0);
});

test("the upper-bound cache-read price is the most expensive priced model", () => {
  assert.equal(MAX_CACHE_READ_PER_MTOK, 1.5);
});
