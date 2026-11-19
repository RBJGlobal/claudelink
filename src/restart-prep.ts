// "Prepare for restart": one click in the Command Center types a prompt into
// every live agent's terminal asking it to bring its handoff up to date, then
// tracks which agents have confirmed. An agent confirms by calling
// signal_checkpoint, which stamps agents.checkpoint_ts; a stamp newer than the
// click counts as ready. The prompt asks for safe_to_clear=false so the
// confirmation never doubles as consent to a /compact.

import Database from "better-sqlite3";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";

export const RESTART_PREP_TEXT =
  "The operator is about to restart this computer. Finish or park any step in flight, " +
  "bring your handoff file and memory up to date so you can resume without anyone retelling it, " +
  "then call signal_checkpoint with safe_to_clear=false and the note: ready for restart. " +
  "Start no new work after that.";

export interface PrepRequest {
  at: number; // ms epoch of the click
  asked: { id: string; role: string }[];
  failed: string[]; // roles the prompt could not be typed to
}

export interface PrepStatus {
  at: number;
  ready: string[];
  waiting: string[];
  failed: string[];
}

let current: PrepRequest | null = null;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Pure. `stamps` maps agent id -> checkpoint_ts (ms) for agents that still exist.
export function prepStatus(req: PrepRequest, stamps: Map<string, number | null>): PrepStatus {
  const ready: string[] = [];
  const waiting: string[] = [];
  for (const a of req.asked) {
    const ts = stamps.get(a.id);
    (ts != null && ts > req.at ? ready : waiting).push(a.role);
  }
  return { at: req.at, ready, waiting, failed: req.failed };
}

export function askAllToPrepare(db: Database.Database): PrepStatus {
  const rows = db
    .prepare(
      `SELECT id, role, tty, terminal_app, pane_id, pid FROM agents
       WHERE tty IS NOT NULL AND tty != ''`
    )
    .all() as NudgeCandidate[];
  const req: PrepRequest = { at: Date.now(), asked: [], failed: [] };
  for (const c of rows) {
    if (!isAlive(c.pid)) continue;
    const r = injectKeystroke(c, RESTART_PREP_TEXT);
    // "unknown" = iTerm2 timed out after taking the text; it may have landed,
    // so wait for that agent rather than typing twice.
    if (r === "ok" || r === "unknown") req.asked.push({ id: c.id, role: c.role });
    else req.failed.push(c.role);
  }
  current = req;
  return prepStatus(req, new Map());
}

export function currentPrepStatus(db: Database.Database): PrepStatus | null {
  if (!current) return null;
  // A request older than 6 hours is no longer shown.
  if (Date.now() - current.at > 6 * 3600 * 1000) { current = null; return null; }
  const stamps = new Map<string, number | null>();
  try {
    const rows = db.prepare(`SELECT id, checkpoint_ts FROM agents`).all() as {
      id: string; checkpoint_ts: number | null;
    }[];
    for (const r of rows) stamps.set(r.id, r.checkpoint_ts);
  } catch {
    // pre-v3 schema: nobody can confirm; all stay "waiting"
  }
  return prepStatus(current, stamps);
}
