// Fleet restore. Keeps a snapshot of which agent sat in which iTerm2 pane with
// which Claude session, and pairs restored panes with agents after a restart.
// Everything is read-only except runRestore(), which types into panes and is
// reached only through `claudelink restore --go`.
//
// The snapshot is per-role "last known": a restart (no live agents) never
// erases it, and one agent restarting only refreshes its own entry.

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { cwdForPid } from "./usage-reader.js";
import { injectKeystroke } from "./scheduler.js";

const DIR = path.join(os.homedir(), ".claudelink");
export const SNAPSHOT_PATH = path.join(DIR, "fleet-snapshot.json");
const DB_PATH = path.join(DIR, "nexus.db");
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export interface Pane {
  windowId: string; // stable only within one capture
  paneIdx: number; // 1-based order inside its window
  uniqueId: string;
  tty: string;
  name: string;
  cwd: string | null; // cwd of the pane's login shell
  idle: boolean; // only the shell is in the foreground
}

export interface SnapshotAgent {
  role: string;
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  paneUniqueId: string | null;
  paneIdx: number | null;
  windowId: string | null;
  capturedAt: number;
}

export interface Snapshot {
  version: 1;
  writtenAt: number;
  agents: SnapshotAgent[];
}

export interface Match {
  agent: SnapshotAgent;
  pane: Pane | null;
  confidence: "high" | "medium" | "none";
  reason: string;
}

// Keep the newest entry per role; live entries replace old ones, roles that
// are not live right now are retained until they age out.
export function mergeSnapshot(old: Snapshot | null, live: SnapshotAgent[], now: number): Snapshot {
  const byRole = new Map<string, SnapshotAgent>();
  for (const a of old?.agents ?? []) {
    if (now - a.capturedAt <= MAX_AGE_MS) byRole.set(a.role, a);
  }
  for (const a of live) byRole.set(a.role, a);
  return {
    version: 1,
    writtenAt: now,
    agents: [...byRole.values()].sort((x, y) => x.role.localeCompare(y.role)),
  };
}

// Pair each snapshot agent with at most one current pane. Never guesses: an
// agent without unambiguous evidence stays unmatched.
export function matchPanes(agents: SnapshotAgent[], panes: Pane[]): Match[] {
  const used = new Set<string>();
  const out = new Map<string, Match>();

  // 1. iTerm2 pane id (only meaningful if it survives a restart).
  for (const a of agents) {
    if (!a.paneUniqueId) continue;
    const p = panes.find((x) => x.uniqueId === a.paneUniqueId && !used.has(x.uniqueId));
    if (!p) continue;
    used.add(p.uniqueId);
    const sameDir = !a.cwd || !p.cwd || a.cwd === p.cwd;
    out.set(a.role, {
      agent: a,
      pane: p,
      confidence: sameDir ? "high" : "medium",
      reason: sameDir ? "pane-id" : "pane-id (folder differs)",
    });
  }

  // 2. Folder, then pane order for panes that share a folder.
  const rest = agents.filter((a) => !out.has(a.role));
  const dirs = new Set(rest.map((a) => a.cwd).filter(Boolean) as string[]);
  for (const dir of dirs) {
    const as = rest.filter((a) => a.cwd === dir);
    const ps = panes.filter((p) => p.cwd === dir && !used.has(p.uniqueId));
    if (as.length === 1 && ps.length === 1) {
      used.add(ps[0].uniqueId);
      out.set(as[0].role, { agent: as[0], pane: ps[0], confidence: "high", reason: "folder" });
      continue;
    }
    const oneWindow = new Set(ps.map((p) => p.windowId)).size === 1;
    const oneOldWindow = new Set(as.map((a) => a.windowId)).size === 1;
    for (const a of as) {
      const p =
        oneWindow && oneOldWindow && a.paneIdx != null
          ? ps.find((x) => x.paneIdx === a.paneIdx && !used.has(x.uniqueId))
          : undefined;
      if (p) {
        used.add(p.uniqueId);
        out.set(a.role, { agent: a, pane: p, confidence: "medium", reason: "folder + pane order" });
      } else {
        out.set(a.role, {
          agent: a,
          pane: null,
          confidence: "none",
          reason: ps.length === 0 ? "no pane in this folder" : "several panes share this folder",
        });
      }
    }
  }
  for (const a of rest) {
    if (!out.has(a.role))
      out.set(a.role, { agent: a, pane: null, confidence: "none", reason: "folder unknown" });
  }
  return agents.map((a) => out.get(a.role)!);
}

// ---- I/O (read-only) -------------------------------------------------------

// Uncached on purpose: a shell's folder changes when the operator runs cd.
function liveCwd(pid: number): string | null {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1).trim() : null;
  } catch {
    return null;
  }
}

function paneShell(tty: string): { cwd: string | null; idle: boolean } {
  try {
    const short = tty.replace("/dev/", "");
    const rows = execFileSync("ps", ["-t", short, "-o", "pid=,stat=,comm="], {
      timeout: 2000,
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length >= 3);
    const shell = rows.find((r) => r[2].startsWith("-"));
    const fg = rows.filter((r) => r[1].includes("+"));
    const idle = !!shell && fg.length > 0 && fg.every((r) => r[0] === shell[0]);
    return { cwd: shell ? liveCwd(Number(shell[0])) : null, idle };
  } catch {
    return { cwd: null, idle: false };
  }
}

// null = iTerm2 could not be read this time (busy or not running).
export function listItermPanes(): Pane[] | null {
  const script = `tell application "iTerm2"
    set out to ""
    set d to (ASCII character 9)
    repeat with w in windows
      set n to 0
      repeat with t in tabs of w
        repeat with s in sessions of t
          set n to n + 1
          set out to out & (id of w) & d & n & d & (unique id of s) & d & (tty of s) & d & (name of s) & linefeed
        end repeat
      end repeat
    end repeat
    return out
  end tell`;
  let raw: string;
  try {
    raw = execFileSync("osascript", ["-e", script], { timeout: 5000, encoding: "utf8" });
  } catch {
    return null;
  }
  const panes: Pane[] = [];
  for (const line of raw.split("\n")) {
    const f = line.split("\t");
    if (f.length < 5 || !f[3].startsWith("/dev/")) continue;
    const sh = paneShell(f[3]);
    panes.push({
      windowId: f[0],
      paneIdx: Number(f[1]),
      uniqueId: f[2],
      tty: f[3],
      name: f.slice(4).join("\t").trim(),
      cwd: sh.cwd,
      idle: sh.idle,
    });
  }
  return panes;
}

export function readSnapshot(file = SNAPSHOT_PATH): Snapshot | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return s && s.version === 1 && Array.isArray(s.agents) ? s : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// One capture: live agents joined to their panes by tty. Returns the number of
// live agents captured, or -1 when iTerm2 could not be read (nothing written).
export function captureSnapshot(): number {
  const panes = listItermPanes();
  if (panes === null) return -1;
  let rows: any[];
  const db = new Database(DB_PATH, { readonly: true });
  try {
    rows = db
      .prepare(
        `SELECT role, pid, tty, session_id, transcript_path FROM agents
         WHERE session_id IS NOT NULL AND tty IS NOT NULL AND tty != ''`
      )
      .all();
  } finally {
    db.close();
  }
  const now = Date.now();
  const live: SnapshotAgent[] = [];
  for (const r of rows) {
    if (!isAlive(r.pid)) continue;
    const p = panes.find((x) => x.tty === r.tty);
    live.push({
      role: r.role,
      sessionId: r.session_id,
      transcriptPath: r.transcript_path ?? null,
      cwd: cwdForPid(r.pid) ?? p?.cwd ?? null,
      paneUniqueId: p?.uniqueId ?? null,
      paneIdx: p?.paneIdx ?? null,
      windowId: p?.windowId ?? null,
      capturedAt: now,
    });
  }
  if (live.length === 0) return 0; // e.g. just after a restart: keep what we have
  const merged = mergeSnapshot(readSnapshot(), live, now);
  const tmp = SNAPSHOT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SNAPSHOT_PATH);
  return live.length;
}

export interface FleetSnapshotHandle { stop: () => void }

export function startFleetSnapshot(): FleetSnapshotHandle {
  const tick = () => { try { captureSnapshot(); } catch { /* never breaks the UI */ } };
  const first = setTimeout(tick, 15000);
  const timer = setInterval(tick, 60000);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

export function formatPreview(matches: Match[], panes: Pane[], snap: Snapshot): string {
  const home = os.homedir();
  const short = (p: string | null) => (p ? p.replace(home, "~") : "?");
  const lines = [
    `Fleet restore preview (dry run, nothing is typed). Snapshot written ${new Date(snap.writtenAt).toLocaleString()}.`,
    "",
  ];
  for (const m of matches) {
    const age = Math.round((Date.now() - m.agent.capturedAt) / 60000);
    lines.push(
      `${m.confidence === "none" ? "UNMATCHED" : m.confidence.toUpperCase().padEnd(9)} ${m.agent.role}`,
      `          session ${m.agent.sessionId.slice(0, 8)}  folder ${short(m.agent.cwd)}  seen ${age} min ago`,
      m.pane
        ? `          -> pane ${m.pane.tty} (${m.reason}) ${m.pane.idle ? "at shell prompt" : "BUSY, would be skipped"}`
        : `          -> no pane: ${m.reason}`
    );
  }
  const taken = new Set(matches.filter((m) => m.pane).map((m) => m.pane!.uniqueId));
  const spare = panes.filter((p) => !taken.has(p.uniqueId));
  if (spare.length) {
    lines.push("", "Panes left alone:");
    for (const p of spare) lines.push(`          ${p.tty}  ${short(p.cwd)}`);
  }
  return lines.join("\n");
}

// ---- Restore (types into panes) --------------------------------------------

export interface RestoreOptions {
  only?: string[]; // role names; empty or missing = every agent
  allowMedium?: boolean; // also act on "medium" matches
}

export interface RestoreAction {
  role: string;
  tty: string;
  command: string; // typed at the shell prompt
  registerText: string; // typed into Claude once it is running
}

export interface RestorePlan {
  actions: RestoreAction[];
  skipped: { role: string; reason: string }[];
}

// Everything typed at a shell prompt is built from the snapshot and the agents
// table, which other agents can write to (a role name is whatever an agent
// registered as). So each value is checked against a strict shape, and anything
// else is skipped, never escaped-and-hoped.
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const PATH_RE = /^\/[A-Za-z0-9 ._\/@+-]*$/;

// Pure: decides what would be typed where. No I/O.
export function planRestore(matches: Match[], opts: RestoreOptions = {}): RestorePlan {
  const only = (opts.only ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
  const plan: RestorePlan = { actions: [], skipped: [] };
  const skip = (role: string, reason: string) => plan.skipped.push({ role, reason });
  for (const m of matches) {
    const a = m.agent;
    if (only.length && !only.includes(a.role.toLowerCase())) continue;
    if (!m.pane || m.confidence === "none") { skip(a.role, `no pane: ${m.reason}`); continue; }
    if (m.confidence === "medium" && !opts.allowMedium) {
      skip(a.role, `match is only medium (${m.reason}); pass --allow-medium to include it`);
      continue;
    }
    if (!m.pane.idle) { skip(a.role, "pane is busy (not at a shell prompt)"); continue; }
    if (!SESSION_RE.test(a.sessionId)) { skip(a.role, "session id has an unexpected shape"); continue; }
    if (!ROLE_RE.test(a.role)) { skip(a.role, "role name has characters that are not typed into a shell"); continue; }
    if (!a.cwd || !PATH_RE.test(a.cwd)) { skip(a.role, "folder is unknown or has unusual characters"); continue; }
    plan.actions.push({
      role: a.role,
      tty: m.pane.tty,
      command: `cd '${a.cwd}' && claude-metered --resume ${a.sessionId}`,
      registerText: `Register yourself as ${a.role}, then read your handoff and resume.`,
    });
  }
  if (only.length) {
    const known = new Set(matches.map((m) => m.agent.role.toLowerCase()));
    for (const r of only) if (!known.has(r)) skip(r, "no such role in the snapshot");
  }
  return plan;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function type(tty: string, role: string, text: string): "ok" | "skip" | "fail" | "unknown" {
  return injectKeystroke(
    { id: "", role, tty, terminal_app: "iterm2", pane_id: null, pid: 0 },
    text
  );
}

function registeredOnTty(role: string, tty: string): boolean {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT pid FROM agents WHERE role = ? AND tty = ?`)
      .all(role, tty) as { pid: number }[];
    return rows.some((r) => isAlive(r.pid));
  } finally {
    db.close();
  }
}

// Types the resume command into each planned pane, waits for Claude to start,
// then types the register line. Never retries a keystroke: a timed-out write
// may still land. `log` receives one line per event.
export async function runRestore(
  plan: RestorePlan,
  log: (line: string) => void,
  settleSec = 20,
  verifySec = 180
): Promise<{ registered: string[]; notConfirmed: string[] }> {
  const started: RestoreAction[] = [];
  for (const a of plan.actions) {
    // Re-check right before typing: the operator may have started something.
    if (!paneShell(a.tty).idle) { log(`skip  ${a.role}: pane became busy`); continue; }
    const r = type(a.tty, a.role, a.command);
    if (r === "fail" || r === "skip") { log(`fail  ${a.role}: could not type into ${a.tty}`); continue; }
    log(`typed ${a.role}: resume command into ${a.tty}${r === "unknown" ? " (iTerm2 slow, delivery unconfirmed)" : ""}`);
    started.push(a);
  }

  // Wait for Claude to take over each pane (the shell is no longer in front).
  const running: RestoreAction[] = [];
  const deadline = Date.now() + 60000;
  let waiting = [...started];
  while (waiting.length && Date.now() < deadline) {
    await sleep(2000);
    waiting = waiting.filter((a) => {
      if (paneShell(a.tty).idle) return true;
      running.push(a);
      return false;
    });
  }
  for (const a of waiting) log(`fail  ${a.role}: Claude did not start in ${a.tty}; nothing more typed there`);
  if (!running.length) return { registered: [], notConfirmed: started.map((a) => a.role) };

  log(`wait  ${settleSec}s for Claude to finish loading`);
  await sleep(settleSec * 1000);
  const asked: RestoreAction[] = [];
  for (const a of running) {
    // Only type the register line while Claude still owns the pane; if it
    // exited, the text would land at the shell prompt.
    if (paneShell(a.tty).idle) { log(`fail  ${a.role}: Claude exited in ${a.tty}; register line not typed`); continue; }
    const r = type(a.tty, a.role, a.registerText);
    if (r === "fail" || r === "skip") { log(`fail  ${a.role}: could not type the register line`); continue; }
    log(`typed ${a.role}: register line`);
    asked.push(a);
  }

  const registered: string[] = [];
  let pending = [...asked];
  const vDeadline = Date.now() + verifySec * 1000;
  while (pending.length && Date.now() < vDeadline) {
    await sleep(3000);
    pending = pending.filter((a) => {
      let ok = false;
      try { ok = registeredOnTty(a.role, a.tty); } catch { /* retry next round */ }
      if (ok) { registered.push(a.role); log(`ok    ${a.role}: registered on ${a.tty}`); }
      return !ok;
    });
  }
  for (const a of pending) log(`check ${a.role}: not registered after ${verifySec}s, look at ${a.tty}`);
  const done = new Set(registered);
  return { registered, notConfirmed: started.map((a) => a.role).filter((r) => !done.has(r)) };
}
