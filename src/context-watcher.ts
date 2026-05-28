// Context-hygiene watcher — monitors each live agent's CURRENT context
// occupancy (read from its Claude Code transcript) and, at a threshold, nudges
// /compact so the agent stops re-reading a huge context every turn. The meter
// showed the burn is ~97% cache-reads (re-sent context); this automates the
// manual /compact discipline a human can't sustain across 15-20 terminals.
//
// SAFETY POSTURE (this types into LIVE terminals once armed):
//   - mode "observe" (default): detect + log "would-nudge" + project savings.
//     NEVER injects. This is what runs now — zero risk to the working fleet.
//   - mode "inject": currently a GUARDED STUB. It logs that injection is not
//     yet armed rather than typing into terminals. The real injection path
//     (idle-gate via scrollback + injectKeystroke + cooldown + escalate) is
//     built and soak-tested under founder supervision before this is armed —
//     a /compact landing mid-turn would corrupt that turn.
//
// Detection metric: a turn's input-side tokens (input + cache_read +
// cache_creation) = the prompt size being re-sent = context occupancy.
// Verified empirically to grow monotonically turn-over-turn (no sawtooth), so
// a single-tick read is a stable signal.

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import Database from "better-sqlite3";
import {
  cwdForPid,
  projectIdFromCwd,
  PROJECTS_DIR,
  OPUS_CACHE_READ_PER_MTOK,
} from "./usage-reader.js";
import {
  readContextWatcherSettings,
  ContextWatcherSettings,
} from "./context-watcher-settings.js";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DB_PATH = path.join(NEXUS_DIR, "nexus.db");
const LOG_PATH = path.join(NEXUS_DIR, "context-watcher.log");

function logLine(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging never breaks the watcher */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SessionRef {
  file: string;
  ambiguous: boolean; // true if the project dir has >1 recently-active session
}

// The most-recently-modified transcript in an agent's project dir. For a
// single-agent project this is unambiguously that agent's live session; for a
// shared project (several agents in one repo) we flag it ambiguous — observe
// can still read it, but injection must NOT target it until session->agent
// mapping lands (register-time sessionId capture).
function mostRecentSession(pid: number): SessionRef | null {
  const cwd = cwdForPid(pid);
  if (!cwd) return null;
  const dir = path.join(PROJECTS_DIR, projectIdFromCwd(cwd));
  let files: { file: string; mtime: number }[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const full = path.join(dir, f);
        return { file: full, mtime: fs.statSync(full).mtimeMs };
      });
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  const recentCutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
  const recent = files.filter((f) => f.mtime >= recentCutoff);
  return { file: files[0].file, ambiguous: recent.length > 1 };
}

function inputSideTokens(u: any): number {
  return (
    (Number(u.input_tokens) || 0) +
    (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0)
  );
}

// Current context occupancy = input-side tokens of the LAST real assistant turn
// in the transcript. Streams the file keeping only the last value.
async function latestContextTokens(file: string): Promise<number | null> {
  let last: number | null = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.indexOf('"usage"') === -1) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o?.message;
    if (!msg?.usage || !msg?.model || msg.model === "<synthetic>") continue;
    last = inputSideTokens(msg.usage);
  }
  return last;
}

export interface CompactOpportunity {
  windowDays: number;
  thresholdTokens: number;
  compactBaselineTokens: number;
  flaggedTurns: number;
  // Upper-bound: assumes a compact at threshold and no re-growth. The real soak
  // measures the actual delta; this is the opportunity ceiling.
  excessTokensUpperBound: number;
  estUsdUpperBound: number;
  perProject: { label: string; roles: string[]; flaggedTurns: number; excessTokens: number }[];
}

interface AgentRef {
  role: string;
  pid: number;
}

// Retrospective what-if: across the window, for every turn whose context
// exceeds the threshold, count the excess over the post-compact baseline as
// tokens that would NOT have been re-read had the session compacted at the
// threshold. Deduped across forked sessions (message.id + requestId), same as
// the meter. This is the case-study BASELINE opportunity — explicitly an
// upper bound.
export async function projectCompactOpportunity(
  agents: AgentRef[],
  windowDays = 7,
  thresholdTokens = 200000,
  compactBaselineTokens = 60000
): Promise<CompactOpportunity> {
  const windowStartMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();

  // Group agents by project dir (dedupe shared repos), same as the meter.
  const byProject = new Map<string, { roles: string[]; cwd: string }>();
  for (const a of agents) {
    const cwd = cwdForPid(a.pid);
    if (!cwd) continue;
    const id = projectIdFromCwd(cwd);
    const e = byProject.get(id) || { roles: [], cwd };
    e.roles.push(a.role);
    byProject.set(id, e);
  }

  let flaggedTurns = 0;
  let excess = 0;
  const perProject: CompactOpportunity["perProject"] = [];

  for (const [id, { roles, cwd }] of byProject) {
    const dir = path.join(PROJECTS_DIR, id);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    let pFlagged = 0;
    let pExcess = 0;
    for (const file of files) {
      try {
        if (fs.statSync(file).mtimeMs < windowStartMs) continue;
      } catch {
        continue;
      }
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (line.indexOf('"usage"') === -1) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = o?.message;
        if (!msg?.usage || !msg?.model || msg.model === "<synthetic>") continue;
        if (msg.id && o.requestId) {
          const key = msg.id + "::" + o.requestId;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const ts = Date.parse(o.timestamp || "");
        if (!Number.isFinite(ts) || ts < windowStartMs) continue;
        const ctx = inputSideTokens(msg.usage);
        if (ctx > thresholdTokens) {
          pFlagged++;
          pExcess += Math.max(0, ctx - compactBaselineTokens);
        }
      }
    }
    if (pFlagged > 0) {
      flaggedTurns += pFlagged;
      excess += pExcess;
      perProject.push({
        label: roles.length === 1 ? roles[0] : `${path.basename(cwd)} (${roles.length} agents)`,
        roles,
        flaggedTurns: pFlagged,
        excessTokens: pExcess,
      });
    }
  }

  perProject.sort((a, b) => b.excessTokens - a.excessTokens);
  return {
    windowDays,
    thresholdTokens,
    compactBaselineTokens,
    flaggedTurns,
    excessTokensUpperBound: excess,
    estUsdUpperBound: (excess * OPUS_CACHE_READ_PER_MTOK) / 1_000_000,
    perProject,
  };
}

interface SessionState {
  lastNudgedAt: number;
  nudgeCount: number;
}

export interface ContextWatcherHandle {
  reschedule: () => void;
  stop: () => void;
  tickNow: () => Promise<{ checked: number; flagged: number; wouldNudge: number; injected: number }>;
}

export function startContextWatcher(): ContextWatcherHandle {
  let db: Database.Database | null = null;
  let timer: NodeJS.Timeout | null = null;
  let tickInProgress = false;
  const state = new Map<string, SessionState>();

  const openDb = (): Database.Database => {
    if (!db) db = new Database(DB_PATH, { readonly: true });
    return db;
  };

  const liveAgents = (): { role: string; pid: number }[] => {
    const rows = openDb().prepare(`SELECT role, pid FROM agents`).all() as {
      role: string;
      pid: number;
    }[];
    return rows.filter((r) => isProcessAlive(r.pid));
  };

  const tick = async () => {
    const summary = { checked: 0, flagged: 0, wouldNudge: 0, injected: 0 };
    if (tickInProgress) {
      logLine("skip-tick: previous tick still in flight");
      return summary;
    }
    tickInProgress = true;
    try {
      const s = readContextWatcherSettings();
      if (!s.enabled) return summary;
      const now = Date.now();
      const cooldownMs = s.cooldownMin * 60 * 1000;

      for (const a of liveAgents()) {
        summary.checked++;
        const session = mostRecentSession(a.pid);
        if (!session) continue;
        let ctx: number | null;
        try {
          ctx = await latestContextTokens(session.file);
        } catch {
          continue;
        }
        if (ctx === null || ctx <= s.thresholdTokens) continue;
        summary.flagged++;

        const st = state.get(a.role) || { lastNudgedAt: 0, nudgeCount: 0 };
        if (now - st.lastNudgedAt < cooldownMs) continue; // recently (would-)nudged

        const excess = Math.max(0, ctx - s.compactBaselineTokens);
        const projUsd = ((excess * OPUS_CACHE_READ_PER_MTOK) / 1_000_000).toFixed(2);

        if (s.mode === "observe") {
          summary.wouldNudge++;
          st.lastNudgedAt = now;
          st.nudgeCount++;
          state.set(a.role, st);
          logLine(
            `would-nudge role=${a.role} context=${ctx} threshold=${s.thresholdTokens} ` +
              `excess=${excess} proj_saved_usd=${projUsd} ambiguous=${session.ambiguous} count=${st.nudgeCount}`
          );
        } else {
          // mode === "inject": NOT YET ARMED. The idle-gated injection path is
          // built + soak-tested under founder supervision before this fires.
          // Until then, log the intent and do nothing to live terminals.
          logLine(
            `inject-requested-NOT-ARMED role=${a.role} context=${ctx} ambiguous=${session.ambiguous} ` +
              `(injection is gated pending founder-supervised soak)`
          );
          st.lastNudgedAt = now;
          state.set(a.role, st);
        }
      }
      return summary;
    } finally {
      tickInProgress = false;
    }
  };

  const reschedule = (): void => {
    const s = readContextWatcherSettings();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!s.enabled) {
      logLine("reschedule: disabled");
      return;
    }
    timer = setInterval(() => {
      tick().catch((e: any) => logLine(`tick-uncaught: ${e?.message ?? String(e)}`));
    }, s.intervalSec * 1000);
    logLine(
      `reschedule: enabled mode=${s.mode} intervalSec=${s.intervalSec} ` +
        `thresholdTokens=${s.thresholdTokens} cooldownMin=${s.cooldownMin}`
    );
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      db = null;
    }
  };

  reschedule();
  return { reschedule, stop, tickNow: tick };
}
