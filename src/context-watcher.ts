// Context-hygiene watcher — monitors each live agent's CURRENT context
// occupancy (read from its Claude Code transcript) and, at a threshold, nudges
// /compact so the agent stops re-reading a huge context every turn. The meter
// showed the burn is ~97% cache-reads (re-sent context); this automates the
// manual /compact discipline a human can't sustain across 15-20 terminals.
//
// SAFETY POSTURE (this types into LIVE terminals once armed):
//   - mode "observe" (default): detect + log "would-nudge" + project savings.
//     NEVER injects. Zero risk to the working fleet.
//   - mode "inject" (ARMED, founder-gated): types s.message (default /compact)
//     into a terminal ONLY when ALL gates hold — economic (perTurnCost over
//     threshold) + fresh consent (a signal_checkpoint within K real turns) +
//     idle (last turn ENDED, not mid-turn) + verified handoff + not an
//     ambiguous shared-repo session. With oneShot (default), it fires once then
//     auto-disables (latch) so arming can't become a standing fleet loop.
//   - Settings default to enabled=false: nothing runs/injects until the
//     operator explicitly enables + flips mode to inject.
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
  cacheReadPricePerMtok,
} from "./usage-reader.js";
import {
  readContextWatcherSettings,
  writeContextWatcherSettings,
  ContextWatcherSettings,
} from "./context-watcher-settings.js";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";
import { verifyHandoff } from "./compact-executor.js";

// Safety gate for armed inject: the agent's consent signal must be within this
// many real turns of "now" (it hasn't worked far past the checkpoint its
// handoff describes). Turns, not wall-clock — an idle agent that signaled and
// hasn't moved is still at its safe checkpoint.
const MAX_TURNS_SINCE_SIGNAL = 5;

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

interface WatchedAgent {
  id: string;
  role: string;
  pid: number;
  tty: string | null;
  terminal_app: string | null;
  pane_id: string | null;
  session_id: string | null;
  transcript_path: string | null;
  checkpoint_ts: number | null;
  checkpoint_safe_to_clear: number;
  checkpoint_handoff_path: string | null;
}

// Safety-gate freshness for the OBSERVE correlation log. A coarse time window;
// the armed phase uses the precise "within K turns of the signal" test.
const CHECKPOINT_FRESH_MS = 10 * 60 * 1000;

// Maximum staleness for a v3-captured transcript_path before we treat it as
// suspect and fall back to the heuristic + ambiguous flag. Sessions can be
// replaced under the same TTY without the hook re-firing (Claude Code session
// restart, /resume to a different session, etc.), and the watcher must NOT
// inject /compact into a transcript that the captured path is now wrong about.
// 30 min is generous — a legitimately-active session writes to its transcript
// well within that window; anything older means the agent is idle (no harm in
// falling back) or the path is stale (correct to fall back).
const TRANSCRIPT_STALE_MS = 30 * 60 * 1000;

// Resolve an agent's session transcript. EXACT path (v3): if the hook captured
// this agent's transcript_path, use it directly — unambiguous even in a shared
// repo dir, and the source of truth for injection targeting. Otherwise fall
// back to the most-recent transcript in the project dir (flagged ambiguous when
// the dir has >1 recently-active session, since we can't tell which is whose).
//
// RECENCY CHECK: even when v3 path is captured, verify the file's mtime is
// recent (< TRANSCRIPT_STALE_MS) before trusting it. Otherwise a session that
// was replaced in the same terminal (no re-register fired the hook) could let
// the watcher score gates against a dead transcript and inject /compact into a
// LIVE different session in the same terminal. Stale path → drop to the
// ambiguous heuristic path.
function resolveSession(agent: WatchedAgent): SessionRef | null {
  if (agent.transcript_path) {
    try {
      const st = fs.statSync(agent.transcript_path);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs < TRANSCRIPT_STALE_MS) {
        return { file: agent.transcript_path, ambiguous: false };
      }
      // Path exists but is stale — fall through and force the heuristic. If
      // the heuristic picks the same file we'll still treat it as ambiguous
      // (the v3 path was the only authority on non-ambiguity).
    } catch {
      /* fall through to heuristic */
    }
  }
  return mostRecentSession(agent.pid);
}

// The most-recently-modified transcript in an agent's project dir. For a
// single-agent project this is unambiguously that agent's live session; for a
// shared project (several agents in one repo) we flag it ambiguous — observe
// can still read it, but injection must NOT target it until session->agent
// mapping (v3 transcript_path) is populated for that agent.
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

interface TurnEconomics {
  contextTokens: number; // input-side tokens of the last real turn = occupancy
  model: string;
  lastTurnTs: number; // epoch ms of the last real turn (activity signal)
  turnsPerHour: number; // burn rate over the recent turns (forward-exposure)
}

// Reads the economic state of a session's most-recent real turns: current
// context occupancy + model (for $/turn pricing) + last activity + recent
// turns/hour (rate-of-burn). Streams the file keeping a small rolling tail.
//
// LATEST-TS GUARD: Claude Code's JSONL transcripts contain interleaved branches
// (resumes/forks) where a later-written line can have an EARLIER timestamp than
// some line earlier in the file. So "the last line in the file" is not the same
// as "the latest turn by time." We must only overwrite contextTokens+model when
// the line's timestamp is >= the latest we've seen — otherwise the economic
// gate compares against stale data from an older branch.
//
// STREAM CLEANUP: try/finally with explicit rl.close() so a transient error
// mid-stream doesn't leak the file handle.
async function latestTurnEconomics(file: string): Promise<TurnEconomics | null> {
  let contextTokens: number | null = null;
  let model = "";
  let latestTs = -Infinity;
  const recentTs: number[] = []; // timestamps of recent real turns (rolling)
  const RECENT = 20;
  const input = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
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
      const ts = Date.parse(o.timestamp || "");
      if (!Number.isFinite(ts)) continue;
      if (ts >= latestTs) {
        latestTs = ts;
        contextTokens = inputSideTokens(msg.usage);
        model = msg.model;
      }
      recentTs.push(ts);
      if (recentTs.length > RECENT) recentTs.shift();
    }
  } finally {
    rl.close();
    input.destroy();
  }
  if (contextTokens === null) return null;
  // Use the by-time latest, not the by-position last, for last-activity too —
  // and sort recentTs so the turns/hour denominator reflects real chronology.
  recentTs.sort((a, b) => a - b);
  const lastTurnTs = recentTs.length ? recentTs[recentTs.length - 1] : 0;
  // turns/hour over the recent window (guard against a zero/tiny span).
  let turnsPerHour = 0;
  if (recentTs.length >= 2) {
    const spanMs = recentTs[recentTs.length - 1] - recentTs[0];
    if (spanMs > 1000) turnsPerHour = ((recentTs.length - 1) * 3600000) / spanMs;
  }
  return { contextTokens, model, lastTurnTs, turnsPerHour };
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

// Armed-inject safety read: is the agent idle (last turn ENDED, quiet ≥15s,
// not mid-tool-call) and how many real turns has it taken since its consent
// signal? Streams the session transcript once. Used only in the inject path.
//
// LATEST-TS GUARD: same as latestTurnEconomics — JSONL transcripts can have
// branched/resumed lines whose by-position order is not by-time order. The
// idle decision must compare against the chronologically-latest turn, not the
// last line in the file. Without this guard an older "end_turn" line that
// happens to be last in the file lets the gate think the agent is idle while
// the live session is mid-tool-call → /compact lands mid-work.
//
// STREAM CLEANUP: try/finally with explicit rl.close() + input.destroy().
async function armGate(
  file: string,
  checkpointTs: number | null
): Promise<{ idle: boolean; turnsSinceSignal: number; detail: string }> {
  let latest: {
    type: string;
    stop: string | null;
    ts: number;
    toolUse: boolean;
  } | null = null;
  let turnsSince = 0;
  const input = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
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
      if (Array.isArray(m.content))
        for (const b of m.content) if (b && b.type === "tool_use") toolUse = true;
      const ts = Date.parse(o.timestamp || "");
      if (!Number.isFinite(ts)) continue;
      if (latest === null || ts >= latest.ts) {
        latest = { type: o.type, stop: m.stop_reason ?? null, ts, toolUse };
      }
      if (checkpointTs != null && ts > checkpointTs) turnsSince++;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  if (!latest)
    return { idle: false, turnsSinceSignal: 999, detail: "no real turns" };
  const ageSec = (Date.now() - latest.ts) / 1000;
  const idle =
    latest.type === "assistant" &&
    (latest.stop === "end_turn" || latest.stop === "stop_sequence") &&
    !latest.toolUse &&
    ageSec >= 15;
  return {
    idle,
    turnsSinceSignal: turnsSince,
    detail: `last=${latest.type}/${latest.stop} age=${ageSec.toFixed(0)}s turnsSinceSignal=${turnsSince}`,
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

  const liveAgents = (): WatchedAgent[] => {
    const rows = openDb()
      .prepare(
        `SELECT id, role, pid, tty, terminal_app, pane_id, session_id, transcript_path,
                checkpoint_ts, checkpoint_safe_to_clear, checkpoint_handoff_path
           FROM agents`
      )
      .all() as WatchedAgent[];
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
        const session = resolveSession(a);
        if (!session) continue;
        let econ: TurnEconomics | null;
        try {
          econ = await latestTurnEconomics(session.file);
        } catch {
          continue;
        }
        if (econ === null) continue;

        // ── TRIGGER (arms): projected per-turn cache-read cost crosses $threshold.
        const cacheReadPrice = cacheReadPricePerMtok(econ.model);
        const perTurnCostUsd = (econ.contextTokens * cacheReadPrice) / 1_000_000;
        if (perTurnCostUsd <= s.dollarPerTurnThreshold) continue;
        summary.flagged++;

        const st = state.get(a.role) || { lastNudgedAt: 0, nudgeCount: 0 };
        if (now - st.lastNudgedAt < cooldownMs) continue; // recently (would-)nudged

        // ── DECISION (fires): only act when forward savings clearly beat the
        // handshake overhead, AND the session is actively progressing (else a
        // session about to idle pays overhead for nothing), weighting rate-of-burn.
        const activelyProgressing = now - econ.lastTurnTs < s.activeWindowMin * 60 * 1000;
        // Forward exposure horizon: rate-of-burn over the active window (how many
        // more turns we'd expect to re-read this context before a natural stop).
        // Conservative: cap at the turns the active window could hold.
        const horizonTurns = Math.max(1, Math.min(
          (econ.turnsPerHour * s.activeWindowMin) / 60,
          s.activeWindowMin // hard cap so a runaway rate can't inflate savings
        ));
        const savedTokensPerTurn = Math.max(0, econ.contextTokens - s.compactBaselineTokens);
        const forwardSavedTokens = savedTokensPerTurn * horizonTurns;
        const netSavedTokens = forwardSavedTokens - s.handshakeOverheadTokens;
        const netSavedUsd = (netSavedTokens * cacheReadPrice) / 1_000_000;
        const netPositive = netSavedTokens > 0;

        // SAFETY gate (observe correlation): is there a fresh agent-consented
        // checkpoint signal? Economic-armed means little if the agent hasn't
        // marked a safe boundary. both-gates-green = act-worthy in the armed
        // phase; logged here so the cadence/alignment is visible pre-deploy.
        const economicGreen = activelyProgressing && netPositive;
        const safetyFresh = a.checkpoint_ts != null && now - a.checkpoint_ts < CHECKPOINT_FRESH_MS;
        const ckMin = a.checkpoint_ts != null ? ((now - a.checkpoint_ts) / 60000).toFixed(1) : "none";
        const bothGreen = economicGreen && safetyFresh;

        const econStr =
          `context=${econ.contextTokens} model=${econ.model.replace("claude-", "")} ` +
          `per_turn_usd=${perTurnCostUsd.toFixed(2)} turns_per_hr=${econ.turnsPerHour.toFixed(1)} ` +
          `horizon=${horizonTurns.toFixed(1)} net_saved_usd=${netSavedUsd.toFixed(2)} ` +
          `progressing=${activelyProgressing} ambiguous=${session.ambiguous} ` +
          `signal_age_min=${ckMin} safe_to_clear=${a.checkpoint_safe_to_clear} ` +
          `safety_gate=${safetyFresh} economic_gate=${economicGreen} both_gates_green=${bothGreen}`;

        if (s.mode === "observe") {
          // Nudge path: gate on the session being actively progressing (don't
          // pay handshake overhead on one about to idle) + net-positive.
          if (!(activelyProgressing && netPositive)) {
            logLine(`hold role=${a.role} ${econStr} reason=${!activelyProgressing ? "idle" : "savings<overhead"}`);
            continue;
          }
          summary.wouldNudge++;
          st.lastNudgedAt = now;
          st.nudgeCount++;
          state.set(a.role, st);
          logLine(`would-nudge role=${a.role} ${econStr} count=${st.nudgeCount}`);
        } else {
          // ARMED INJECT (mode "inject"). FAIL-CLOSED ALLOWLIST FIRST: only
          // roles the operator explicitly put on injectAllowlist are ever
          // auto-compacted. An empty/unset list arms NO ONE — this is what makes
          // a standing-on rollout a controlled subset, not fleet-wide. Checked
          // before the transcript scan so non-listed agents are skipped cheaply.
          if (!s.injectAllowlist.includes(a.role)) {
            logLine(`inject-skip role=${a.role} reason=not-in-allowlist allowlist=${JSON.stringify(s.injectAllowlist)}`);
            continue;
          }
          // Then the SAFETY stack — and note compaction wants the agent IDLE,
          // the opposite of the nudge path. ALL must hold before we type into a
          // live terminal:
          //   - fresh consent: agent signaled a checkpoint within K real turns
          //     (it hasn't worked far past the handoff it wrote);
          //   - idle: last turn ENDED + quiet (not mid-turn / mid-tool-call);
          //   - handoff verified non-trivial;
          //   - NOT an ambiguous shared-repo session (can't safely target it).
          const ag = await armGate(session.file, a.checkpoint_ts);
          const freshConsent =
            a.checkpoint_ts != null && ag.turnsSinceSignal <= MAX_TURNS_SINCE_SIGNAL;
          const handoffOk = !!a.checkpoint_handoff_path && verifyHandoff(a.checkpoint_handoff_path).ok;
          const gates = `idle=${ag.idle} freshConsent=${freshConsent}(${ag.detail}) handoff=${handoffOk} ambiguous=${session.ambiguous}`;
          if (!(ag.idle && freshConsent && handoffOk && !session.ambiguous)) {
            logLine(`inject-skip role=${a.role} ${econStr} ${gates}`);
            continue;
          }
          // ALL GATES GREEN — inject the consented action (one shot).
          const candidate: NudgeCandidate = {
            id: a.id,
            role: a.role,
            tty: a.tty || "",
            terminal_app: a.terminal_app,
            pane_id: a.pane_id,
            pid: a.pid,
          };
          // LATCH FIRST: persist enabled=false BEFORE injecting. If the process
          // crashes between the inject and the latch, it must NOT re-fire on
          // restart — so the latch lands first. Injection failing is recoverable
          // (re-enable manually); a double-inject is not (you can't un-inject).
          //
          // LATCH FAILURE GUARD: writeContextWatcherSettings can throw on a
          // full disk / permission error. If the latch fails we MUST NOT
          // proceed to inject — otherwise the entire latch-first design is
          // defeated (next tick re-passes gates, fires again, etc.). Skip
          // this agent and log loudly so the operator notices.
          if (s.oneShot) {
            try {
              writeContextWatcherSettings({ enabled: false });
              logLine(`ONE-SHOT LATCH set (enabled=false) before firing ${a.role}`);
            } catch (e: any) {
              logLine(
                `LATCH-FAILED role=${a.role} reason=${e?.message ?? String(e)} ${econStr} ${gates} action=skip-inject`
              );
              continue;
            }
          }
          const result = injectKeystroke(candidate, s.message);
          summary.injected++;
          st.lastNudgedAt = now;
          st.nudgeCount++;
          state.set(a.role, st);
          logLine(`ARMED-FIRE role=${a.role} action=${JSON.stringify(s.message)} result=${result} ${econStr} ${gates}`);
          if (s.oneShot) break;
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
