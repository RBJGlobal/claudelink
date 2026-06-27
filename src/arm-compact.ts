#!/usr/bin/env node
// One-shot armed compact — types /compact into ONE consenting, idle agent's
// terminal. SAFETY-CRITICAL + founder-gated. Deliberately a standalone one-shot
// CLI (no auto-loop, no watcher wiring) so the first armed injection is a
// single supervised action, not a background behavior.
//
//   DRY by default: prints every gate + the "would-inject" line and touches
//   NOTHING. Pass --fire to actually inject (one shot). The dry path never
//   reaches injectKeystroke.
//
//   Gates (ALL must pass before --fire will inject):
//     1. handoff file present + non-trivial (the agent's resume state);
//     2. transcript-idle — the agent's last turn ENDED (end_turn) and has been
//        quiet, i.e. it's waiting at the prompt, not mid-turn / mid-tool-call;
//     3. scrollback tail printed for the operator's own visual idle confirm.
//
//   Kill-switch: the operator can Ctrl-C / interrupt the target terminal at any
//   moment. This injects ONE /compact and exits.
//
// Usage:  node dist/arm-compact.js "<agent role>" [--fire]

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import Database from "better-sqlite3";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";
import { captureScrollback } from "./recovery-watcher.js";
import { verifyHandoff } from "./compact-executor.js";
import { cwdForPid, projectIdFromCwd, PROJECTS_DIR } from "./usage-reader.js";

const DB_PATH = path.join(os.homedir(), ".claudelink", "nexus.db");
const KEYSTROKE = "/compact"; // Path A: compact (keeps a model summary), conservative
const IDLE_MIN_QUIET_SEC = 15; // last end_turn must be at least this old

function log(s: string) {
  console.log(s);
}

interface AgentRow {
  id: string;
  role: string;
  pid: number;
  tty: string | null;
  terminal_app: string | null;
  pane_id: string | null;
  checkpoint_safe_to_clear: number | null;
  checkpoint_handoff_path: string | null;
}

// Idle iff the agent's most-recent transcript's LAST real turn is an assistant
// turn that ENDED (end_turn / stop_sequence) with nothing after it — i.e. the
// agent is waiting at the prompt, not mid-turn or awaiting a tool result.
async function transcriptIdle(pid: number): Promise<{ idle: boolean; detail: string }> {
  const cwd = cwdForPid(pid);
  if (!cwd) return { idle: false, detail: "no cwd (can't locate transcript)" };
  const dir = path.join(PROJECTS_DIR, projectIdFromCwd(cwd));
  let files: { f: string; m: number }[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return { idle: false, detail: "no project dir" };
  }
  if (!files.length) return { idle: false, detail: "no transcript" };
  let last: { type: string; stop: string | null; ts: number; toolUse: boolean } | null = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(files[0].f, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.indexOf('"type"') === -1) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const m = o.message || {};
    let toolUse = false;
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "tool_use") toolUse = true;
    last = { type: o.type, stop: m.stop_reason ?? null, ts: Date.parse(o.timestamp || "") || 0, toolUse };
  }
  if (!last) return { idle: false, detail: "no real turns found" };
  const ageSec = (Date.now() - last.ts) / 1000;
  const ended =
    last.type === "assistant" &&
    (last.stop === "end_turn" || last.stop === "stop_sequence") &&
    !last.toolUse;
  const idle = ended && ageSec >= IDLE_MIN_QUIET_SEC;
  return {
    idle,
    detail: `last turn: ${last.type} stop_reason=${last.stop} toolUse=${last.toolUse} age=${ageSec.toFixed(0)}s`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fire = args.includes("--fire");
  const role = args.filter((a) => !a.startsWith("--"))[0];
  if (!role) {
    log('usage: node dist/arm-compact.js "<agent role>" [--fire]');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const row = db
    .prepare(
      `SELECT id, role, pid, tty, terminal_app, pane_id,
              checkpoint_safe_to_clear, checkpoint_handoff_path
         FROM agents WHERE role = ?`
    )
    .get(role) as AgentRow | undefined;
  db.close();

  log(`=== arm-compact ${fire ? "[FIRE]" : "[DRY-RUN]"} — role="${role}" ===`);
  if (!row) {
    log(`✗ no agent registered with role "${role}"`);
    process.exit(1);
  }

  let alive = false;
  try {
    process.kill(row.pid, 0);
    alive = true;
  } catch {}
  log(`agent: pid=${row.pid} alive=${alive} tty=${row.tty} terminal=${row.terminal_app}`);
  let ok = alive;
  if (!alive) log("✗ agent process not alive");

  // gate 1 — handoff present + non-trivial
  const handoff = row.checkpoint_handoff_path;
  const hv = handoff ? verifyHandoff(handoff) : { ok: false, bytes: 0 };
  log(`gate 1 — handoff: ${handoff || "(none)"} → ${hv.ok ? "OK (" + hv.bytes + "b)" : "MISSING/trivial"}`);
  if (!hv.ok) ok = false;
  log(`consent: safe_to_clear=${row.checkpoint_safe_to_clear}`);

  // gate 2 — transcript-idle
  const ti = await transcriptIdle(row.pid);
  log(`gate 2 — transcript-idle: ${ti.detail} → ${ti.idle ? "IDLE" : "BUSY"}`);
  if (!ti.idle) ok = false;

  // gate 3 — scrollback tail (operator eyeballs for an idle prompt)
  const cand: NudgeCandidate = {
    id: row.id,
    role: row.role,
    tty: row.tty || "",
    terminal_app: row.terminal_app,
    pane_id: row.pane_id,
    pid: row.pid,
  };
  let sb: string | null = null;
  try {
    sb = captureScrollback(cand);
  } catch {
    sb = null;
  }
  if (sb) {
    log(`gate 3 — scrollback tail (confirm it shows an idle prompt):\n   …${sb.slice(-240).replace(/\n/g, " ⏎ ")}`);
  } else {
    log("gate 3 — scrollback: (could not capture; rely on transcript-idle + your own view)");
  }

  log(`\nplanned keystroke: ${JSON.stringify(KEYSTROKE)}  →  ${row.terminal_app} tty=${row.tty}`);

  if (!ok) {
    log("\n✗ NOT all gates passed — refusing to fire.");
    process.exit(2);
  }
  if (!fire) {
    log(`\n✓ all gates passed. DRY-RUN — WOULD inject ${JSON.stringify(KEYSTROKE)} into ${row.tty}. Nothing was touched.`);
    log('   To actually fire (one shot): re-run with --fire');
    return;
  }

  log(`\n▶ FIRING: injecting ${JSON.stringify(KEYSTROKE)} into ${row.tty} …`);
  const result = injectKeystroke(cand, KEYSTROKE);
  log(`  injectKeystroke → ${result}`);
  log(result === "ok" ? "✓ injected /compact. Watch the terminal." : "✗ injection did not succeed");
}

main().catch((e) => {
  console.error("arm-compact error:", e?.message ?? e);
  process.exit(1);
});
