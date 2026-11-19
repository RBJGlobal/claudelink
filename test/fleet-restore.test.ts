import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSnapshot, matchPanes, SnapshotAgent, Pane, Snapshot } from "../src/fleet-restore.js";

const T = 1_800_000_000_000;
const ag = (role: string, cwd: string, idx: number, win = "w1", pane = "old-" + role): SnapshotAgent => ({
  role, sessionId: "sid-" + role, transcriptPath: null, cwd,
  paneUniqueId: pane, paneIdx: idx, windowId: win, capturedAt: T,
});
const pn = (id: string, cwd: string, idx: number, win = "W"): Pane => ({
  windowId: win, paneIdx: idx, uniqueId: id, tty: "/dev/tty" + id, name: "", cwd, idle: true,
});

test("merge: live entry replaces, absent role is kept", () => {
  const old: Snapshot = { version: 1, writtenAt: T, agents: [ag("A", "/a", 1), ag("B", "/b", 2)] };
  const live = [{ ...ag("A", "/a", 1), sessionId: "new", capturedAt: T + 5 }];
  const m = mergeSnapshot(old, live, T + 5);
  assert.equal(m.agents.length, 2);
  assert.equal(m.agents.find((x) => x.role === "A")!.sessionId, "new");
  assert.equal(m.agents.find((x) => x.role === "B")!.sessionId, "sid-B");
});

test("merge: entries older than 14 days age out", () => {
  const old: Snapshot = { version: 1, writtenAt: T, agents: [ag("A", "/a", 1)] };
  assert.equal(mergeSnapshot(old, [], T + 15 * 86400000).agents.length, 0);
});

test("match: surviving pane id wins", () => {
  const m = matchPanes([ag("A", "/a", 1)], [pn("old-A", "/a", 3)]);
  assert.equal(m[0].confidence, "high");
  assert.equal(m[0].reason, "pane-id");
});

test("match: unique folder after ids changed", () => {
  const m = matchPanes([ag("A", "/a", 1), ag("B", "/b", 2)], [pn("x", "/b", 1), pn("y", "/a", 2)]);
  assert.equal(m[0].pane!.uniqueId, "y");
  assert.equal(m[1].pane!.uniqueId, "x");
  assert.equal(m[0].reason, "folder");
});

test("match: two agents sharing a folder pair by pane order, each keeps its own session", () => {
  const m = matchPanes(
    [ag("Advisor", "/c", 1, "w3"), ag("Dev", "/c", 2, "w3")],
    [pn("p1", "/c", 1), pn("p2", "/c", 2)]
  );
  assert.equal(m[0].pane!.uniqueId, "p1");
  assert.equal(m[1].pane!.uniqueId, "p2");
  assert.equal(m[0].confidence, "medium");
  assert.equal(m[0].agent.sessionId, "sid-Advisor");
});

test("match: agent sharing a folder with a plain shell takes its own pane, shell is left alone", () => {
  const m = matchPanes([ag("Me", "/d", 3)], [pn("p3", "/d", 3), pn("p4", "/d", 4)]);
  assert.equal(m[0].pane!.uniqueId, "p3");
  assert.equal(m[0].confidence, "medium");
});

test("match: shared folder spread over two windows is not guessed", () => {
  const m = matchPanes(
    [ag("A", "/c", 1), ag("B", "/c", 2)],
    [pn("p1", "/c", 1, "W1"), pn("p2", "/c", 1, "W2")]
  );
  assert.equal(m[0].pane, null);
  assert.equal(m[1].pane, null);
});

test("match: no pane in the folder stays unmatched, no pane used twice", () => {
  const m = matchPanes([ag("A", "/a", 1), ag("B", "/zzz", 2)], [pn("x", "/a", 1)]);
  assert.equal(m[0].pane!.uniqueId, "x");
  assert.equal(m[1].pane, null);
  assert.equal(m[1].confidence, "none");
});

// ---- planRestore: what --go would type ------------------------------------

import { planRestore, Match as M2 } from "../src/fleet-restore.js";

const SID = "38f9d94b-1c1f-4cd6-b8aa-326ba3b93540";
function mk(over: {
  role?: string; sessionId?: string; cwd?: string | null;
  confidence?: "high" | "medium" | "none"; idle?: boolean; noPane?: boolean;
}): M2 {
  return {
    agent: {
      role: over.role ?? "Dev One", sessionId: over.sessionId ?? SID,
      transcriptPath: null, cwd: over.cwd === undefined ? "/Users/x/My Apps/proj" : over.cwd,
      paneUniqueId: "u1", paneIdx: 1, windowId: "w1", capturedAt: 0,
    },
    pane: over.noPane ? null : {
      windowId: "w1", paneIdx: 1, uniqueId: "u1", tty: "/dev/ttys900", name: "",
      cwd: "/Users/x/My Apps/proj", idle: over.idle ?? true,
    },
    confidence: over.confidence ?? "high",
    reason: "pane-id",
  };
}

test("planRestore builds the resume command and register line for an idle high match", () => {
  const p = planRestore([mk({})]);
  assert.equal(p.skipped.length, 0);
  assert.deepEqual(p.actions, [{
    role: "Dev One",
    tty: "/dev/ttys900",
    command: `cd '/Users/x/My Apps/proj' && claude-metered --resume ${SID}`,
    registerText: "Register yourself as Dev One, then read your handoff and resume.",
  }]);
});

test("planRestore never types into a busy pane", () => {
  const p = planRestore([mk({ idle: false })]);
  assert.equal(p.actions.length, 0);
  assert.match(p.skipped[0].reason, /busy/);
});

test("planRestore skips medium matches unless allowed, and never unmatched ones", () => {
  assert.equal(planRestore([mk({ confidence: "medium" })]).actions.length, 0);
  assert.equal(planRestore([mk({ confidence: "medium" })], { allowMedium: true }).actions.length, 1);
  assert.equal(planRestore([mk({ confidence: "none", noPane: true })], { allowMedium: true }).actions.length, 0);
});

test("planRestore refuses values that could run something else at the shell", () => {
  for (const bad of [
    mk({ role: "Dev; rm -rf ~" }),
    mk({ role: "Dev $(whoami)" }),
    mk({ role: "Dev\nls" }),
    mk({ sessionId: "abc; ls" }),
    mk({ sessionId: SID + " --dangerously-skip-permissions" }),
    mk({ cwd: "/Users/x/it's" }),
    mk({ cwd: "/Users/x/$(ls)" }),
    mk({ cwd: "relative/path" }),
    mk({ cwd: null }),
  ]) {
    const p = planRestore([bad]);
    assert.equal(p.actions.length, 0, JSON.stringify(bad.agent));
    assert.equal(p.skipped.length, 1);
  }
});

test("planRestore --only limits to the named roles, case-insensitive, and reports unknown names", () => {
  const p = planRestore([mk({ role: "Dev One" }), mk({ role: "Dev Two" })], { only: ["dev two", "Nobody"] });
  assert.deepEqual(p.actions.map((a) => a.role), ["Dev Two"]);
  assert.deepEqual(p.skipped, [{ role: "nobody", reason: "no such role in the snapshot" }]);
});

// ---- resumeCheck: was a timed-out resume command delivered? ----------------

import { resumeCheck } from "../src/fleet-restore.js";

test("resumeCheck: a pane Claude owns counts as started, whatever it shows", () => {
  assert.equal(resumeCheck(false, null, SID), "started");
  assert.equal(resumeCheck(false, "user@host proj % ", SID), "started");
});

test("resumeCheck: an empty shell prompt means the text never arrived", () => {
  assert.equal(resumeCheck(true, "Last login: Wed\nuser@host proj % \n\n", SID), "retype");
});

test("resumeCheck: the command sitting unsubmitted on the prompt needs only Enter", () => {
  const c = `user@host proj % cd '/x' && claude-metered --resume ${SID}\n`;
  assert.equal(resumeCheck(true, c, SID), "enter");
});

test("resumeCheck: anything else is left alone, never typed over", () => {
  assert.equal(resumeCheck(true, null, SID), "leave"); // pane unreadable
  assert.equal(resumeCheck(true, "user@host proj % cd '/x' && claude-meter", SID), "leave"); // partly typed
  assert.equal(resumeCheck(true, "claude-metered: usage proxy not running. Start it", SID), "leave");
});
