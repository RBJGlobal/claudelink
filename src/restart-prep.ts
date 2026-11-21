// "Prepare for restart": one click in the Command Center types a prompt into
// every live agent's terminal asking it to bring its handoff up to date, then
// tracks which agents have confirmed. An agent confirms by calling
// signal_checkpoint, which stamps agents.checkpoint_ts; a stamp newer than the
// click counts as ready. The prompt asks for safe_to_clear=false so the
// confirmation never doubles as consent to a /compact.

import Database from "better-sqlite3";
import * as fs from "fs";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";
import { waitForIterm, paneContents } from "./iterm.js";
import { isAgentAlive } from "./liveness.js";

export const RESTART_PREP_TEXT =
  "The operator is about to restart this computer. Finish or park any step in flight, " +
  "bring your handoff file and memory up to date so you can resume without anyone retelling it. " +
  "Copy anything you still need out of your session scratchpad, because the restart empties it, " +
  "and list in the handoff any watches or scheduled wake-ups you have armed, because they do not survive. " +
  "Then call signal_checkpoint with safe_to_clear=false and the note: ready for restart. " +
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
  rows?: PrepRow[];
  safe?: boolean;
}

// One line per terminal in the "is everyone parked?" view.
export interface PrepRow {
  role: string;
  state: "parked" | "waiting" | "not-reached";
  unread: number;
  unreadHigh: number;
  // The terminal's transcript changed well after it confirmed: it kept working.
  activeAfterPark: boolean;
}

export interface PrepFacts {
  checkpointTs: number | null;
  unread: number;
  unreadHigh: number;
  lastActivityMs: number | null; // transcript last-modified, when known
  // False when the confirmation came from a server too old to record its
  // time; then "kept working" cannot be judged and is not claimed.
  confirmTimeKnown?: boolean;
}

// Pure. When did this agent confirm, as far as the row can tell?
//  - signalTs is written only by signal_checkpoint (servers from 1.6.19).
//  - An older server leaves signalTs empty but still writes the note. The
//    note is cleared when the prompt is typed, so a note that is back means
//    signal_checkpoint was called after the click; the time is not known.
export function confirmation(
  signalTs: number | null | undefined,
  note: string | null | undefined,
  clickAt: number
): { ts: number | null; timeKnown: boolean } {
  if (signalTs != null) return { ts: signalTs, timeKnown: true };
  if (note != null && note !== "") return { ts: clickAt + 1, timeKnown: false };
  return { ts: null, timeKnown: false };
}

// The checkpoint call and its reply are themselves written to the transcript,
// so activity only counts when it is clearly later than the confirmation.
export const PARK_ACTIVITY_SLACK_MS = 2 * 60 * 1000;

// Pure. `facts` is keyed by agent id; `byRole` holds the same facts keyed by
// role, for terminals the prompt did not reach or that have a new id since.
// checkpointTs must be the time of the agent's own signal_checkpoint call.
export function prepRows(
  req: PrepRequest,
  facts: Map<string, PrepFacts>,
  failedFacts: Map<string, PrepFacts> = new Map()
): PrepRow[] {
  const rows: PrepRow[] = [];
  for (const a of req.asked) {
    // A terminal that re-registered since the click has a new id and its mail
    // moved with it: show the role's current mail, but it stays "waiting".
    const own = facts.get(a.id);
    const f = own ?? failedFacts.get(a.role);
    const ts = own?.checkpointTs ?? null;
    const parked = ts != null && ts > req.at;
    rows.push({
      role: a.role,
      state: parked ? "parked" : "waiting",
      unread: f?.unread ?? 0,
      unreadHigh: f?.unreadHigh ?? 0,
      activeAfterPark:
        parked && own?.confirmTimeKnown !== false && f?.lastActivityMs != null &&
        f.lastActivityMs > (ts as number) + PARK_ACTIVITY_SLACK_MS,
    });
  }
  for (const role of req.failed) {
    const f = failedFacts.get(role);
    rows.push({
      role,
      state: "not-reached",
      unread: f?.unread ?? 0,
      unreadHigh: f?.unreadHigh ?? 0,
      activeAfterPark: false,
    });
  }
  return rows;
}

// Pure. Safe to restart only when at least one terminal was asked, every one
// is parked and none has kept working or holds an unread high-priority message.
export function prepSafe(rows: PrepRow[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((r) => r.state === "parked" && !r.activeAfterPark && r.unreadHigh === 0)
  );
}

let current: PrepRequest | null = null;

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

async function askMany(db: Database.Database, rows: NudgeCandidate[], req: PrepRequest): Promise<void> {
  for (const c of rows) {
    if (!isAgentAlive(c)) continue;
    // Clear the last checkpoint note before asking, so a note seen later was
    // written after this click (see `confirmation`).
    try { db.prepare(`UPDATE agents SET checkpoint_note = NULL WHERE id = ?`).run(c.id); } catch { /* older schema */ }
    if (await askOne(c)) req.asked.push({ id: c.id, role: c.role });
    else req.failed.push(c.role);
  }
}

const liveRows = (db: Database.Database) =>
  db
    .prepare(
      `SELECT id, role, tty, terminal_app, pane_id, pid, last_seen FROM agents
       WHERE tty IS NOT NULL AND tty != ''`
    )
    .all() as NudgeCandidate[];

export async function askAllToPrepare(db: Database.Database): Promise<PrepStatus> {
  const req: PrepRequest = { at: Date.now(), asked: [], failed: [] };
  await askMany(db, liveRows(db), req);
  current = req;
  return prepStatus(req, new Map());
}

// Asks again only the terminals the last request could not reach. The click
// time is kept, so agents that already confirmed stay ready.
export async function retryNotReached(db: Database.Database): Promise<PrepStatus | null> {
  if (!current) return null;
  const want = new Set(current.failed);
  current.failed = [];
  await askMany(db, liveRows(db).filter((c) => want.has(c.role)), current);
  return currentPrepStatus(db);
}

export function currentPrepStatus(db: Database.Database): PrepStatus | null {
  if (!current) return null;
  // A request older than 6 hours is no longer shown.
  if (Date.now() - current.at > 6 * 3600 * 1000) { current = null; return null; }
  const stamps = new Map<string, number | null>();
  const timeKnown = new Map<string, boolean>();
  const facts = new Map<string, PrepFacts>();
  const failedFacts = new Map<string, PrepFacts>();
  // checkpoint_ts is not used: the Stop hook refreshes it at every turn end,
  // which would count a terminal as confirmed before it had read the prompt.
  let rows: { id: string; signal_ts: number | null; note: string | null }[] = [];
  try {
    rows = db.prepare(`SELECT id, checkpoint_signal_ts AS signal_ts, checkpoint_note AS note FROM agents`).all() as typeof rows;
  } catch {
    try {
      // no server from 1.6.19 has opened this file yet: the column is absent
      rows = db.prepare(`SELECT id, NULL AS signal_ts, checkpoint_note AS note FROM agents`).all() as typeof rows;
    } catch {
      // older schema still: nobody can confirm; all stay "waiting"
    }
  }
  for (const r of rows) {
    const c = confirmation(r.signal_ts, r.note, current.at);
    stamps.set(r.id, c.ts);
    timeKnown.set(r.id, c.timeKnown);
  }
  const status = prepStatus(current, stamps);
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.role, a.transcript_path,
                (SELECT COUNT(*) FROM messages m WHERE m.to_agent = a.id AND m.read = 0) AS unread,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.to_agent = a.id AND m.read = 0 AND m.priority = 'high') AS unread_high
         FROM agents a`
      )
      .all() as { id: string; role: string; transcript_path: string | null; unread: number; unread_high: number }[];
    for (const r of rows) {
      const f: PrepFacts = {
        checkpointTs: stamps.get(r.id) ?? null,
        unread: r.unread,
        unreadHigh: r.unread_high,
        lastActivityMs: transcriptMtime(r.transcript_path),
        confirmTimeKnown: timeKnown.get(r.id) ?? false,
      };
      facts.set(r.id, f);
      // Several rows can share a role; add their unread counts together.
      const prev = failedFacts.get(r.role);
      failedFacts.set(r.role, {
        checkpointTs: null,
        lastActivityMs: null,
        unread: (prev?.unread ?? 0) + f.unread,
        unreadHigh: (prev?.unreadHigh ?? 0) + f.unreadHigh,
      });
    }
    status.rows = prepRows(current, facts, failedFacts);
    status.safe = prepSafe(status.rows);
  } catch {
    // older schema: the per-terminal view is left out, the summary still works
  }
  return status;
}

function transcriptMtime(file: string | null): number | null {
  if (!file) return null;
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}
