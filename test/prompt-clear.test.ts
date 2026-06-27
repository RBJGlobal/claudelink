// Stage 1: prompt-clear formatter — the single source of truth shared by the
// `claudelink prompt-clear` CLI subcommand and the Command Center fleet view's
// "Copy prompt" button. The exact text the operator pastes must be stable
// across releases; pin it here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptClearText } from "../src/prompt-clear.js";

test("buildPromptClearText includes role / model / context / pct / $ in the comment header", () => {
  const t = buildPromptClearText({
    role: "dev-a",
    model: "claude-opus-4-7",
    contextTokens: 100_000,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  });
  assert.match(t, /^# Agent: dev-a /);
  assert.match(t, /opus-4-7/);
  assert.match(t, /context ~100K/);
  assert.match(t, /50% of window/);
  assert.match(t, /\$0\.15/);
});

test("buildPromptClearText body uses the operator's manual phrasing", () => {
  const t = buildPromptClearText({
    role: "dev-a",
    model: "claude-opus-4-7",
    contextTokens: 100_000,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  });
  // The exact opening words match what the operator types manually. This is
  // load-bearing — agents are tuned to respond to this phrasing.
  assert.match(t, /You've been working a while/);
  assert.match(t, /Please assess: are you at a safe stopping point\?/);
  assert.match(t, /Update HANDOVER\.md/);
  assert.match(t, /Update MEMORY\.md/);
  assert.match(t, /\/compact .*\/clear/);
});

test("buildPromptClearText strips the claude- prefix in the model field for scannability", () => {
  const t = buildPromptClearText({
    role: "x",
    model: "claude-sonnet-4-6",
    contextTokens: 50_000,
    windowTokens: 200_000,
    perTurnUsd: 0.04,
  });
  assert.match(t, /\(sonnet-4-6\)/);
  assert.ok(!t.includes("claude-sonnet-4-6"), "raw model id should be shortened");
});

test("buildPromptClearText handles 1M-window agents (pct < 100)", () => {
  const t = buildPromptClearText({
    role: "big",
    model: "claude-opus-4-7[1m]",
    contextTokens: 300_000,
    windowTokens: 1_000_000,
    perTurnUsd: 0.45,
  });
  assert.match(t, /30% of window/);
  assert.match(t, /context ~300K/);
});

test("buildPromptClearText handles over-window context (pct > 100)", () => {
  // Some agents in the live fleet are way over the standard 200K window —
  // the prompt must still render without crashing or hiding the overflow.
  const t = buildPromptClearText({
    role: "huge",
    model: "claude-opus-4-8",
    contextTokens: 537_000,
    windowTokens: 200_000,
    perTurnUsd: 0.81,
  });
  assert.match(t, /269% of window/);
  assert.match(t, /context ~537K/);
});

test("buildPromptClearText is byte-stable for a given input (no rng / no date)", () => {
  const args = {
    role: "stable",
    model: "claude-opus-4-7",
    contextTokens: 100_000,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  };
  const a = buildPromptClearText(args);
  const b = buildPromptClearText(args);
  assert.equal(a, b, "same inputs → same output, every time");
});

test("buildPromptClearText output is a single multi-line string (joined with \\n)", () => {
  const t = buildPromptClearText({
    role: "x",
    model: "claude-opus-4-7",
    contextTokens: 100_000,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  });
  // Must be paste-ready into a terminal — newlines but no \r\n surprises.
  assert.ok(t.includes("\n"));
  assert.ok(!t.includes("\r"), "no CR — keep it pure LF for terminal paste");
});

test("buildPromptClearText rounds context to nearest K", () => {
  const a = buildPromptClearText({
    role: "x",
    model: "claude-opus-4-7",
    contextTokens: 100_499,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  });
  assert.match(a, /context ~100K/);
  const b = buildPromptClearText({
    role: "x",
    model: "claude-opus-4-7",
    contextTokens: 100_500,
    windowTokens: 200_000,
    perTurnUsd: 0.15,
  });
  assert.match(b, /context ~101K/);
});
