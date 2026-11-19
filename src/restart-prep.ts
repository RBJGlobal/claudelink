// "Prepare for restart": one click in the Command Center types a prompt into
// every live agent's terminal asking it to bring its handoff up to date, then
// tracks which agents have confirmed. An agent confirms by calling
// signal_checkpoint, which stamps agents.checkpoint_ts; a stamp newer than the
// click counts as ready. The prompt asks for safe_to_clear=false so the
// confirmation never doubles as consent to a /compact.

import Database from "better-sqlite3";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";
import { waitForIterm, paneContents } from "./iterm.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A phrase from the prompt, used to see whether it reached a pane.
const MARKER = "about to restart this computer";

// Types the prompt into one terminal. On an iTerm2 timeout the pane is read:
// the prompt is typed again only when it is not on the screen. Returns true
// when the prompt reached the terminal (or the terminal app gives no way to
// check and accepted the keystroke).
async function askOne(c: NudgeCandidate): Promise<boolean> {
  const isIterm = (c.terminal_app || "").toLowerCase() === "iterm2";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (isIterm) await waitForIterm(30000);
    const r = injectKeystroke(c, RESTART_PREP_TEXT);
    if (r === "ok") return true;
    if (r !== "unknown") return false;
    await sleep(4000);
    await waitForIterm(30000);
    const seen = paneContents(c.tty);
    if (seen !== null && seen.replace(/\s+/g, " ").includes(MARKER)) return true;
    if (seen === null) return false; // cannot tell; do not type twice
  }
  return false;
}

async function askMany(rows: NudgeCandidate[], req: PrepRequest): Promise<void> {
  for (const c of rows) {
    if (!isAlive(c.pid)) continue;
    if (await askOne(c)) req.asked.push({ id: c.id, role: c.role });
    else req.failed.push(c.role);
  }
}

const liveRows = (db: Database.Database) =>
  db
    .prepare(
      `SELECT id, role, tty, terminal_app, pane_id, pid FROM agents
       WHERE tty IS NOT NULL AND tty != ''`
    )
    .all() as NudgeCandidate[];

export async function askAllToPrepare(db: Database.Database): Promise<PrepStatus> {
  const req: PrepRequest = { at: Date.now(), asked: [], failed: [] };
  await askMany(liveRows(db), req);
  current = req;
  return prepStatus(req, new Map());
}

// Asks again only the terminals the last request could not reach. The click
// time is kept, so agents that already confirmed stay ready.
export async function retryNotReached(db: Database.Database): Promise<PrepStatus | null> {
  if (!current) return null;
  const want = new Set(current.failed);
  current.failed = [];
  await askMany(liveRows(db).filter((c) => want.has(c.role)), current);
  return currentPrepStatus(db);
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
