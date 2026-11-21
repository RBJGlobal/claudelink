// Pins how a server finds its terminal: the parent first, then a few
// ancestors, for CLIs that start MCP servers from a helper without a tty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findTty, psLookup, ProcInfo, isCodexCliHelper, pickSessionTty } from "../src/tty-detect.js";

const table = (t: Record<number, ProcInfo>) => (pid: number) => t[pid] ?? null;

test("the parent's tty is used when it has one", () => {
  assert.equal(findTty(10, table({ 10: { ppid: 5, tty: "/dev/ttys001" }, 5: { ppid: 1, tty: "/dev/ttys009" } })), "/dev/ttys001");
});

test("a helper without a tty is skipped and its parent's tty is used", () => {
  assert.equal(findTty(20, table({ 20: { ppid: 10, tty: null }, 10: { ppid: 5, tty: "/dev/ttys013" } })), "/dev/ttys013");
});

test("no tty anywhere, a missing process, or pid 1 gives null", () => {
  assert.equal(findTty(20, table({ 20: { ppid: 10, tty: null }, 10: { ppid: 1, tty: null } })), null);
  assert.equal(findTty(20, table({})), null);
  assert.equal(findTty(1, table({ 1: { ppid: 0, tty: "/dev/ttys001" } })), null);
});

test("the walk stops after a few ancestors", () => {
  const t: Record<number, ProcInfo> = {};
  for (let i = 100; i > 90; i--) t[i] = { ppid: i - 1, tty: null };
  t[90] = { ppid: 2, tty: "/dev/ttys001" };
  assert.equal(findTty(100, table(t)), null);
});

test("psLookup reads this test's own process", () => {
  const me = psLookup(process.pid);
  assert.ok(me);
  assert.equal(me.ppid, process.ppid);
});

test("only the Codex CLI helper triggers the working-directory match", () => {
  assert.equal(isCodexCliHelper("/Users/x/.codex/packages/app-server-daemon/bin/codex app-server --listen unix:/tmp/s"), true);
  assert.equal(isCodexCliHelper("codex -c a=b app-server"), true);
  // the desktop app has no pane
  assert.equal(isCodexCliHelper("/Applications/Some.app/Contents/Resources/cli/codex -c a=b app-server"), false);
  assert.equal(isCodexCliHelper("codex resume abc"), false);
  assert.equal(isCodexCliHelper("node /usr/local/bin/claude"), false);
  assert.equal(isCodexCliHelper(null), false);
});

test("the pane is the one session in the same directory, or nothing", () => {
  const a = { tty: "/dev/ttys013", cwd: "/work/a" };
  const b = { tty: "/dev/ttys014", cwd: "/work/b" };
  assert.equal(pickSessionTty("/work/a", [a, b]), "/dev/ttys013");
  assert.equal(pickSessionTty("/work/c", [a, b]), null);
  assert.equal(pickSessionTty("/work/a", []), null);
  // two sessions in one directory: cannot tell them apart
  assert.equal(pickSessionTty("/work/a", [a, { tty: "/dev/ttys015", cwd: "/work/a" }]), null);
  // two processes of one session on the same pane are one match
  assert.equal(pickSessionTty("/work/a", [a, { ...a }]), "/dev/ttys013");
  assert.equal(pickSessionTty("/work/a", [{ tty: "/dev/ttys013", cwd: null }]), null);
});
