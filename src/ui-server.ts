import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { startScheduler, SchedulerHandle } from "./scheduler.js";
import {
  startRecoveryWatcher,
  RecoveryWatcherHandle,
} from "./recovery-watcher.js";
import {
  readRecoveryWatcherSettings,
  writeRecoveryWatcherSettings,
} from "./recovery-watcher-settings.js";
import {
  readSchedulerSettings,
  writeSchedulerSettings,
} from "./scheduler-settings.js";
import { readFleetUsage, FleetUsage, readAgentTimelines, AgentTimeline } from "./usage-reader.js";
import {
  startContextWatcher,
  ContextWatcherHandle,
  latestTurnEconomics,
} from "./context-watcher.js";
import {
  readContextWatcherSettings,
  writeContextWatcherSettings,
} from "./context-watcher-settings.js";
import { analyzeCompactEvents } from "./compact-analyzer.js";
import {
  modelContextWindow,
  cacheReadPricePerMtok,
  cwdForPid,
  projectIdFromCwd,
  PROJECTS_DIR,
} from "./usage-reader.js";
import { verifyHandoff } from "./compact-executor.js";
import { buildPromptClearText } from "./prompt-clear.js";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DEFAULT_DB_PATH = path.join(NEXUS_DIR, "nexus.db");
// Honors CLAUDELINK_DB_PATH for test isolation. Evaluated at call time
// (not module load) so tests can set the env var AFTER static-import
// hoisting brings this module in.
function DB_PATH(): string {
  return process.env.CLAUDELINK_DB_PATH || DEFAULT_DB_PATH;
}
const LOCK_PATH = path.join(NEXUS_DIR, "ui.lock");

interface ServerProc {
  pid: number;
  tty: string;
  etime: string;
  command: string;
  registeredRole: string | null;
}

// Stage 1 fleet-view enrichment: optional per-agent fields populated from
// the agent's LIVE Claude Code transcript. Additive — existing clients reading
// only id/role/pid stay unaffected. Populated only for alive agents whose
// transcript can be resolved; absent (undefined) when a value can't be
// computed (no transcript, no usage line, dead process). The UI renders "-"
// for absent fields rather than zero, so the operator can tell "no data" from
// "actually zero".
interface AgentFleetMetrics {
  context_tokens: number;
  occupancy_pct: number; // 0–100+ (overflow possible: 1M-context model on 200K default)
  model: string;
  window_tokens: number;
  per_turn_usd: number;
  transcript_path: string | null;
  transcript_mtime_ms: number | null;
  handoff_path: string | null;
  handoff_mtime_ms: number | null;
  handoff_ok: boolean;
  signal_age_min: number | null;
  safe_to_clear: 0 | 1;
}

interface AgentRow {
  id: string;
  role: string;
  description: string | null;
  registered_at: string;
  last_seen: string;
  pid: number;
  alive: boolean;
  autonomous_reply: number;
  msgs_from: number;
  msgs_to: number;
  // Stage 1 — populated by enrichAgentsFleet for alive agents only.
  fleet?: AgentFleetMetrics;
}

interface Health {
  total_agents: number;
  total_messages: number;
  unread_messages: number;
  total_bulletin: number;
  orphan_blocker_count: number;
  fk_violations: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listClaudelinkServers(): ServerProc[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,tty=,etime=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const rows: ServerProc[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("claudelink-server")) continue;
    if (line.includes("grep ") && line.includes("claudelink-server")) continue;
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: parseInt(match[1], 10),
      tty: match[2],
      etime: match[3],
      command: match[4],
      registeredRole: null,
    });
  }
  return rows;
}

function isClaudelinkServerPid(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return out.includes("claudelink-server");
  } catch {
    return false;
  }
}

// Resolve the live transcript for an alive agent. Reuses the watcher's
// recency check (stale captured paths fall back to most-recent-in-project-dir
// rather than scoring the dashboard against a dead transcript).
const FLEET_TRANSCRIPT_STALE_MS = 30 * 60 * 1000;
function findFleetTranscript(opts: {
  pid: number;
  transcript_path: string | null;
}): string | null {
  if (opts.transcript_path) {
    try {
      const st = fs.statSync(opts.transcript_path);
      if (Date.now() - st.mtimeMs < FLEET_TRANSCRIPT_STALE_MS) {
        return opts.transcript_path;
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  const cwd = cwdForPid(opts.pid);
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
  return files[0].file;
}

// Populate AgentRow.fleet for each alive agent. Best-effort: a per-agent
// failure logs and skips that agent rather than failing the whole response.
// All file I/O is read-only; the watcher's enabled/mode setting is unaffected.
async function enrichAgentsFleet(
  agents: AgentRow[],
  checkpointMap: Map<
    string,
    {
      checkpoint_ts: number | null;
      checkpoint_safe_to_clear: number;
      checkpoint_handoff_path: string | null;
      transcript_path: string | null;
    }
  >
): Promise<void> {
  const now = Date.now();
  await Promise.all(
    agents.map(async (a) => {
      if (!a.alive) return;
      const ck = checkpointMap.get(a.id);
      if (!ck) return;
      const transcript = findFleetTranscript({
        pid: a.pid,
        transcript_path: ck.transcript_path,
      });
      if (!transcript) return;
      let mtime: number | null = null;
      try {
        mtime = fs.statSync(transcript).mtimeMs;
      } catch {}
      let econ: Awaited<ReturnType<typeof latestTurnEconomics>>;
      try {
        econ = await latestTurnEconomics(transcript);
      } catch {
        econ = null;
      }
      if (!econ) return;
      const window = modelContextWindow(econ.model);
      const perTurnUsd =
        (econ.contextTokens * cacheReadPricePerMtok(econ.model)) / 1_000_000;
      let handoffOk = false;
      let handoffMtime: number | null = null;
      if (ck.checkpoint_handoff_path) {
        try {
          handoffOk = verifyHandoff(ck.checkpoint_handoff_path).ok;
          handoffMtime = fs.statSync(ck.checkpoint_handoff_path).mtimeMs;
        } catch {
          handoffOk = false;
        }
      }
      const signalAgeMin =
        ck.checkpoint_ts != null ? (now - ck.checkpoint_ts) / 60000 : null;
      a.fleet = {
        context_tokens: econ.contextTokens,
        occupancy_pct: (econ.contextTokens / window) * 100,
        model: econ.model,
        window_tokens: window,
        per_turn_usd: perTurnUsd,
        transcript_path: transcript,
        transcript_mtime_ms: mtime,
        handoff_path: ck.checkpoint_handoff_path,
        handoff_mtime_ms: handoffMtime,
        handoff_ok: handoffOk,
        signal_age_min: signalAgeMin,
        safe_to_clear: ck.checkpoint_safe_to_clear === 1 ? 1 : 0,
      };
    })
  );
}

async function getState(): Promise<{
  servers: ServerProc[];
  agents: AgentRow[];
  health: Health;
  recent_messages: any[];
}> {
  const servers = listClaudelinkServers();
  const db = new Database(DB_PATH(), { readonly: false });

  const agents = db
    .prepare(
      `SELECT a.id, a.role, a.description, a.registered_at, a.last_seen, a.pid,
              a.autonomous_reply,
              (SELECT COUNT(*) FROM messages m WHERE m.from_agent = a.id) AS msgs_from,
              (SELECT COUNT(*) FROM messages m WHERE m.to_agent   = a.id) AS msgs_to
         FROM agents a
         ORDER BY a.registered_at DESC`
    )
    .all() as Omit<AgentRow, "alive">[];

  // Pull the checkpoint columns separately — older DBs may not have them.
  // Wrapped in try so a pre-v3 schema doesn't break the fleet view, just
  // leaves the fleet field undefined for those agents.
  const checkpointMap = new Map<
    string,
    {
      checkpoint_ts: number | null;
      checkpoint_safe_to_clear: number;
      checkpoint_handoff_path: string | null;
      transcript_path: string | null;
    }
  >();
  try {
    const ckRows = db
      .prepare(
        `SELECT id, checkpoint_ts, checkpoint_safe_to_clear,
                checkpoint_handoff_path, transcript_path
           FROM agents`
      )
      .all() as Array<{
      id: string;
      checkpoint_ts: number | null;
      checkpoint_safe_to_clear: number;
      checkpoint_handoff_path: string | null;
      transcript_path: string | null;
    }>;
    for (const r of ckRows) checkpointMap.set(r.id, r);
  } catch {
    /* pre-v3 schema — fleet enrichment will be a no-op */
  }

  const enriched: AgentRow[] = agents.map((a) => ({
    ...a,
    alive: isProcessAlive(a.pid),
  }));

  for (const s of servers) {
    const match = enriched.find((a) => a.pid === s.pid);
    s.registeredRole = match ? match.role : null;
  }

  // Orphan blockers = messages whose sender's PID is dead. These are what
  // would block a future pruneDeadAgents on a pre-fix server.
  const orphanBlockerCount = enriched
    .filter((a) => !a.alive)
    .reduce((sum, a) => sum + a.msgs_from, 0);

  const totalMessages = (db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as any).c;
  const unread = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE read = 0`).get() as any).c;
  const totalBulletin = (db.prepare(`SELECT COUNT(*) AS c FROM bulletin`).get() as any).c;

  let fkViolations = 0;
  try {
    const v = db.prepare(`PRAGMA foreign_key_check`).all();
    fkViolations = v.length;
  } catch {}

  const recent = db
    .prepare(
      `SELECT m.id, m.from_agent, a.role AS from_role, m.to_agent, m.priority, m.read, m.created_at,
              substr(m.content, 1, 200) AS content_preview
         FROM messages m
         LEFT JOIN agents a ON a.id = m.from_agent
         ORDER BY m.created_at DESC
         LIMIT 10`
    )
    .all();

  db.close();

  // Stage 1 — enrich each ALIVE agent with live fleet metrics (context %, $,
  // handoff mtime, etc.). Best-effort: per-agent failures fall through silently
  // so a single bad transcript never breaks the dashboard. Performed AFTER the
  // DB is closed so the enrichment scan doesn't keep the DB handle hot.
  try {
    await enrichAgentsFleet(enriched, checkpointMap);
  } catch {
    /* whole-batch failure → dashboard still renders without fleet column */
  }

  return {
    servers,
    agents: enriched,
    health: {
      total_agents: enriched.length,
      total_messages: totalMessages,
      unread_messages: unread,
      total_bulletin: totalBulletin,
      orphan_blocker_count: orphanBlockerCount,
      fk_violations: fkViolations,
    },
    recent_messages: recent,
  };
}

// Fleet token meter. Reads LIVE registered agents (role + pid) and hands them to
// the usage reader, which maps each to its Claude Code project dir and tallies
// real token usage from the local transcripts. Privacy guardrail: only LIVE
// fleet agents are passed, so we never scan the user's unrelated ~/.claude
// history. Read-only — no DB writes, no terminal contact.
// Scanning the fleet's transcripts is expensive (large sessions → multi-second
// parses). Two safeguards so the dashboard never piles up requests:
//   1. A short TTL result cache keyed by windowDays — repeat views / the
//      periodic refresh return instantly within the window.
//   2. In-flight dedupe — concurrent requests for the same window share ONE
//      computation instead of each kicking off its own full scan.
const USAGE_TTL_MS = 5 * 60 * 1000;
const usageCache = new Map<number, { at: number; data: FleetUsage }>();
const usageInflight = new Map<number, Promise<FleetUsage>>();

async function computeUsage(windowDays: number): Promise<FleetUsage> {
  const db = new Database(DB_PATH(), { readonly: true });
  let rows: { role: string; pid: number; transcript_path: string | null }[];
  try {
    try {
      rows = db.prepare(`SELECT role, pid, transcript_path FROM agents`).all() as {
        role: string;
        pid: number;
        transcript_path: string | null;
      }[];
    } catch {
      // Pre-migration DB (live MCP servers still on the old schema, no v3
      // transcript_path column yet). Fall back — per-session breakdown then
      // labels by session-id, and lights up by agent role once deployed.
      rows = (db.prepare(`SELECT role, pid FROM agents`).all() as { role: string; pid: number }[]).map(
        (r) => ({ ...r, transcript_path: null })
      );
    }
  } finally {
    db.close();
  }
  const live = rows
    .filter((r) => isProcessAlive(r.pid))
    .map((r) => ({ role: r.role, pid: r.pid, transcriptPath: r.transcript_path }));
  // Single transcript pass computes BOTH the meter and the compact-opportunity
  // (the projection's threshold/baseline track the watcher's settings) — no
  // second full scan. transcriptPath (when populated) labels per-session
  // breakdown by agent role.
  const cw = readContextWatcherSettings();
  return readFleetUsage(live, windowDays, cw.thresholdTokens, cw.compactBaselineTokens);
}

async function getUsage(windowDays: number): Promise<FleetUsage> {
  const cached = usageCache.get(windowDays);
  if (cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.data;
  const existing = usageInflight.get(windowDays);
  if (existing) return existing;
  const p = computeUsage(windowDays)
    .then((data) => {
      usageCache.set(windowDays, { at: Date.now(), data });
      return data;
    })
    .finally(() => usageInflight.delete(windowDays));
  usageInflight.set(windowDays, p);
  return p;
}

// Per-agent timeline (the 3 dashboard surfaces). All-time scan, so cached on a
// longer TTL — cumulative changes slowly — with in-flight dedupe.
const TIMELINE_TTL_MS = 5 * 60 * 1000;
let timelineCache: { at: number; data: AgentTimeline[] } | null = null;
let timelineInflight: Promise<AgentTimeline[]> | null = null;
async function getAgentTimelines(): Promise<AgentTimeline[]> {
  if (timelineCache && Date.now() - timelineCache.at < TIMELINE_TTL_MS) return timelineCache.data;
  if (timelineInflight) return timelineInflight;
  const p = (async () => {
    const db = new Database(DB_PATH(), { readonly: true });
    let rows: { role: string; pid: number; transcript_path: string | null }[];
    try {
      try {
        rows = db.prepare(`SELECT role, pid, transcript_path FROM agents`).all() as any;
      } catch {
        rows = (db.prepare(`SELECT role, pid FROM agents`).all() as any).map((r: any) => ({ ...r, transcript_path: null }));
      }
    } finally {
      db.close();
    }
    const live = rows
      .filter((r) => isProcessAlive(r.pid))
      .map((r) => ({ role: r.role, pid: r.pid, transcriptPath: r.transcript_path }));
    return readAgentTimelines(live);
  })()
    .then((data) => {
      timelineCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      timelineInflight = null;
    });
  timelineInflight = p;
  return p;
}

function healOrphans(): { deleted_messages: number; pruned_agents: number } {
  const db = new Database(DB_PATH());
  const deadAgents = (
    db.prepare(`SELECT id, pid FROM agents`).all() as { id: string; pid: number }[]
  ).filter((a) => !isProcessAlive(a.pid));

  if (deadAgents.length === 0) {
    db.close();
    return { deleted_messages: 0, pruned_agents: 0 };
  }

  const ids = deadAgents.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");

  const tx = db.transaction(() => {
    const m = db
      .prepare(`DELETE FROM messages WHERE from_agent IN (${placeholders})`)
      .run(...ids);
    db.prepare(`DELETE FROM bulletin WHERE from_agent IN (${placeholders})`).run(...ids);
    const a = db
      .prepare(`DELETE FROM agents WHERE id IN (${placeholders})`)
      .run(...ids);
    return { deleted_messages: m.changes, pruned_agents: a.changes };
  });

  const result = tx();
  db.close();
  return result;
}

function setAutonomousReply(agentId: string, enabled: boolean): boolean {
  const db = new Database(DB_PATH());
  try {
    const r = db
      .prepare(`UPDATE agents SET autonomous_reply = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, agentId);
    return r.changes > 0;
  } finally {
    db.close();
  }
}

function removeStaleAgent(agentId: string): boolean {
  const db = new Database(DB_PATH());
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE from_agent = ?`).run(agentId);
    db.prepare(`DELETE FROM bulletin WHERE from_agent = ?`).run(agentId);
    const r = db.prepare(`DELETE FROM agents WHERE id = ?`).run(agentId);
    return r.changes > 0;
  });
  const ok = tx();
  db.close();
  return ok;
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): { ok: boolean; reason?: string } {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, reason: "invalid pid" };
  }
  if (!isClaudelinkServerPid(pid)) {
    return { ok: false, reason: "pid is not a claudelink-server process" };
  }
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  }
}

function killAllServers(): { killed: number[]; failed: { pid: number; reason: string }[] } {
  const servers = listClaudelinkServers().filter((s) => s.pid !== process.pid);
  const killed: number[] = [];
  const failed: { pid: number; reason: string }[] = [];
  for (const s of servers) {
    const r = killPid(s.pid);
    if (r.ok) killed.push(s.pid);
    else failed.push({ pid: s.pid, reason: r.reason || "unknown" });
  }
  return { killed, failed };
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="ClaudeLink"><rect width="64" height="64" rx="12" fill="#0f1115"/><rect x="18" y="8" width="14" height="48" rx="4" fill="#b89cff"/><rect x="18" y="42" width="30" height="14" rx="4" fill="#b89cff"/><circle cx="49" cy="49" r="7" fill="#3ddc84"/></svg>`;

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ClaudeLink Command Center</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root {
    --bg: #0f1115;
    --panel: #161a22;
    --panel-2: #1d2330;
    --border: #2a3142;
    --text: #e6e8ee;
    --muted: #8a93a6;
    --green: #3ddc84;
    --red: #ff6b6b;
    --amber: #ffb454;
    --blue: #6bb1ff;
    --accent: #b89cff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; font-size: 13px; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, #1b2030 0%, #161a22 100%); position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: 0.3px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); }
  header .spacer { flex: 1; }
  header button { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: 0.15s; }
  header button:hover { background: var(--border); }
  header button.danger { color: var(--red); border-color: rgba(255,107,107,0.3); }
  header button.danger:hover { background: rgba(255,107,107,0.1); }
  main { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .tabs { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); padding: 12px 18px; font-size: 14px; font-weight: 500; cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .panel h2 .count { background: var(--panel-2); color: var(--text); padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .panel .body { padding: 0; }
  .panel.full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 16px; text-align: left; font-size: 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: rgba(255,255,255,0.02); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .pill.alive { background: rgba(61,220,132,0.15); color: var(--green); }
  .pill.dead  { background: rgba(255,107,107,0.15); color: var(--red); }
  .pill.warn  { background: rgba(255,180,84,0.15); color: var(--amber); }
  .pill.info  { background: rgba(107,177,255,0.15); color: var(--blue); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); }
  button.row-action { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 11px; transition: 0.12s; }
  button.row-action:hover { color: var(--text); border-color: #3a4660; }
  button.row-action.danger:hover { color: var(--red); border-color: rgba(255,107,107,0.4); background: rgba(255,107,107,0.05); }
  .empty { padding: 24px 16px; color: var(--muted); text-align: center; font-size: 12px; }
  .health-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); }
  .health-grid > div { background: var(--panel); padding: 14px 16px; }
  .health-grid .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .health-grid .value { font-size: 22px; font-weight: 600; }
  .health-grid .value.warn { color: var(--amber); }
  .health-grid .value.bad { color: var(--red); }
  .health-grid .value.good { color: var(--green); }
  .actions-bar { padding: 12px 16px; display: flex; gap: 8px; flex-wrap: wrap; border-top: 1px solid var(--border); background: var(--panel-2); }
  .actions-bar button { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: 0.15s; }
  .actions-bar button:hover { border-color: #3a4660; }
  .actions-bar button.primary { background: var(--accent); color: #18152a; border-color: var(--accent); font-weight: 500; }
  .actions-bar button.primary:hover { filter: brightness(1.1); }
  .actions-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel); border: 1px solid var(--border); padding: 12px 18px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); animation: slideIn 0.2s; max-width: 360px; }
  .toast.success { border-left: 3px solid var(--green); }
  .toast.error   { border-left: 3px solid var(--red); }
  .disconnected-banner { display: none; background: rgba(255,180,84,0.08); border-bottom: 1px solid rgba(255,180,84,0.3); color: var(--amber); padding: 10px 20px; font-size: 12px; }
  .disconnected-banner.show { display: block; }
  .disconnected-banner button { background: transparent; color: var(--amber); border: 1px solid rgba(255,180,84,0.4); padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: 8px; }
  @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  .nudge-controls { padding: 14px 16px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .nudge-toggle { display: flex; gap: 8px; align-items: center; cursor: pointer; user-select: none; }
  .nudge-toggle input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); }
  .nudge-interval { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13px; }
  .nudge-interval input[type="number"] { width: 56px; background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 4px; font-size: 13px; font-family: inherit; }
  .nudge-status { color: var(--green); font-size: 11px; min-width: 50px; opacity: 0; transition: opacity 0.2s; }
  .nudge-status.show { opacity: 1; }
  .nudge-hint { color: var(--muted); font-size: 12px; padding: 0 16px 14px; line-height: 1.5; margin: 0; }
  .nudge-hint .mono { color: var(--text); }
  /* Fleet — live context (Stage 1) */
  .fleet-tbl td { vertical-align: middle; }
  .occ-bar { position: relative; width: 140px; height: 10px; background: var(--panel-2); border-radius: 5px; overflow: hidden; border: 1px solid var(--border); }
  .occ-bar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); transition: width 0.2s; }
  .occ-bar .fill.warn { background: var(--amber); }
  .occ-bar .fill.bad  { background: var(--red); }
  .occ-pct { font-family: var(--mono, monospace); font-size: 11px; color: var(--muted); margin-left: 8px; min-width: 38px; display: inline-block; text-align: right; }
  .pill.ok   { background: rgba(61,220,132,0.15); color: var(--green); }
  .pill.miss { background: rgba(120,120,140,0.15); color: var(--muted); }
  /* Fleet Token Meter */
  .usage-summary { display: flex; gap: 14px; flex-wrap: wrap; padding: 4px 16px 12px; }
  .usage-stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; min-width: 120px; }
  .usage-stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .usage-stat .value { color: var(--text); font-size: 20px; font-weight: 600; margin-top: 3px; }
  .usage-stat .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .usage-trend { display: flex; align-items: flex-end; gap: 6px; height: 84px; padding: 0 16px 10px; }
  .usage-bar { flex: 1; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; position: relative; opacity: 0.85; transition: height 0.2s; }
  .usage-bar:hover { opacity: 1; }
  .usage-bar .cap { position: absolute; top: -16px; left: 0; right: 0; text-align: center; font-size: 9px; color: var(--muted); }
  .usage-bar .day { position: absolute; bottom: -16px; left: 0; right: 0; text-align: center; font-size: 9px; color: var(--muted); }
  /* single-day distribution donut (replaces the degenerate one-bar trend) */
  .usage-trend.donut-mode { height: auto; align-items: center; gap: 28px; padding: 14px 16px; flex-wrap: wrap; }
  .usage-donut { width: 150px; height: 150px; border-radius: 50%; position: relative; flex: none; }
  .usage-donut::after { content: ''; position: absolute; inset: 34px; border-radius: 50%; background: var(--panel); }
  .donut-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; color: var(--text); z-index: 1; }
  .usage-donut-legend { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 240px; flex: 1; }
  .donut-leg-item { display: flex; align-items: center; gap: 8px; }
  .donut-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .donut-name { color: var(--text); }
  .donut-pct { color: var(--muted); margin-left: auto; }
  .donut-tok { color: var(--muted); font-family: ui-monospace, Menlo, monospace; min-width: 64px; text-align: right; }
  .usage-proj { width: 100%; border-collapse: collapse; margin: 6px 0 4px; }
  .usage-proj th { text-align: left; color: var(--muted); font-size: 11px; font-weight: 500; padding: 6px 16px; border-bottom: 1px solid var(--border); }
  .usage-proj td { padding: 8px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--text); vertical-align: top; }
  .usage-proj td.num { text-align: right; font-family: ui-monospace, Menlo, monospace; }
  .usage-proj tr:last-child td { border-bottom: none; }
  .usage-model-chip { display: inline-block; background: rgba(184,156,255,0.14); color: var(--accent); border-radius: 8px; padding: 1px 7px; font-size: 10px; margin: 1px 3px 1px 0; font-family: ui-monospace, Menlo, monospace; }
  .usage-roles { color: var(--muted); font-size: 11px; margin-top: 2px; }
  /* per-project + expand → per-session/agent sub-rows */
  .proj-expand { display: inline-flex; align-items: center; justify-content: center; background: var(--panel-2); border: 1px solid var(--border); color: var(--accent); width: 18px; height: 18px; border-radius: 4px; font-size: 13px; line-height: 1; cursor: pointer; margin-right: 8px; padding: 0; vertical-align: middle; }
  .proj-expand:hover { border-color: var(--accent); }
  .proj-expand-spacer { display: inline-block; width: 18px; margin-right: 8px; }
  .usage-subrow td { background: rgba(184,156,255,0.05); font-size: 12px; padding-top: 6px; padding-bottom: 6px; }
  .usage-subrow td:first-child { padding-left: 42px; }
  .usage-subrow .sub-name { color: var(--text); }
  .usage-subrow .sub-unmapped { color: var(--muted); font-style: italic; }
  .auto-reply-cell { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; user-select: none; }
  .auto-reply-cell input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent); margin: 0; }
  .auto-reply-cell .lbl { font-size: 11px; color: var(--muted); min-width: 22px; }
  .auto-reply-cell .lbl.on { color: var(--green); }
  .msg-row { padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .msg-row:last-child { border-bottom: none; }
  .msg-row .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .msg-row .content { color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 4.5em; overflow: hidden; position: relative; }
  footer { text-align: center; color: var(--muted); font-size: 11px; padding: 16px; }
</style>
</head>
<body>
<header>
  <span class="dot" id="status-dot"></span>
  <h1>ClaudeLink Command Center</h1>
  <span class="mono" id="last-update">—</span>
  <span class="spacer"></span>
  <button id="btn-refresh">Refresh</button>
  <button id="btn-kill-all" class="danger">Kill all servers</button>
  <button id="btn-quit" class="danger">Quit UI</button>
</header>
<div id="disconnected-banner" class="disconnected-banner">
  Disconnected from ClaudeLink. The server isn't running.
  Start Claude Code in any terminal and it will reconnect automatically.
  <button id="btn-retry-now">Retry now</button>
</div>

<nav class="tabs">
  <button class="tab active" data-tab="overview">Overview</button>
  <button class="tab" data-tab="meter">Fleet Token Meter</button>
</nav>

<main>
 <div class="tab-content active" id="tab-overview">
  <div class="grid">
  <section class="panel full">
    <h2>Health</h2>
    <div class="body">
      <div class="health-grid" id="health-grid"></div>
      <div class="actions-bar">
        <button id="btn-heal" class="primary">Heal orphans</button>
        <span id="heal-hint" style="color: var(--muted); font-size: 12px; align-self: center;"></span>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Running servers <span class="count" id="srv-count">0</span></h2>
    <div class="body">
      <table id="srv-table">
        <thead><tr><th>PID</th><th>TTY</th><th>Uptime</th><th>Role</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Registered agents <span class="count" id="agt-count">0</span></h2>
    <div class="body">
      <table id="agt-table">
        <thead><tr><th>Role</th><th>PID</th><th>Status</th><th>Auto-reply</th><th>Msgs</th><th>Last seen</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section class="panel full">
    <h2>Fleet — live context <span class="count" id="fleet-count">0</span></h2>
    <div class="body">
      <table id="fleet-table" class="fleet-tbl">
        <thead><tr>
          <th>Role</th>
          <th>Model</th>
          <th style="text-align:right">Context</th>
          <th>Occupancy</th>
          <th style="text-align:right">$/turn</th>
          <th>Handoff</th>
          <th>Last signal</th>
          <th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
      <p class="nudge-hint">
        Per-agent live context occupancy, sorted by % desc — most-urgent first. The "Copy prompt" button copies the operator's standard "your context is high, ready to clear/compact?" prompt with that agent's measured numbers interpolated. <strong>The button never types into a terminal</strong> — you paste it manually. Same source of truth as <span class="mono">claudelink prompt-clear</span>.
      </p>
    </div>
  </section>

  <section class="panel full">
    <h2>Auto-nudge</h2>
    <div class="body">
      <div class="nudge-controls">
        <label class="nudge-toggle">
          <input type="checkbox" id="nudge-enabled" />
          <span id="nudge-enabled-label">Off</span>
        </label>
        <label class="nudge-interval">
          Interval:
          <input type="number" id="nudge-interval" min="1" max="120" step="1" />
          <span>min</span>
        </label>
        <span id="nudge-status" class="nudge-status"></span>
      </div>
      <p class="nudge-hint">
        When on, types <span class="mono">"check for updates"</span> into each registered agent's terminal every N minutes — but only when their inbox actually has unread messages. The agent's existing UserPromptSubmit hook then handles the inbox read.
      </p>
    </div>
  </section>

  <section class="panel full">
    <h2>Recovery Watcher</h2>
    <div class="body">
      <div class="nudge-controls">
        <label class="nudge-toggle">
          <input type="checkbox" id="rw-enabled" />
          <span id="rw-enabled-label">Off</span>
        </label>
        <label class="nudge-interval">
          Poll every:
          <input type="number" id="rw-interval" min="15" max="600" step="15" />
          <span>sec</span>
        </label>
        <label class="nudge-interval">
          Cooldown:
          <input type="number" id="rw-cooldown" min="1" max="60" step="1" />
          <span>min</span>
        </label>
        <label class="nudge-interval">
          Escalate after:
          <input type="number" id="rw-escalate" min="1" max="20" step="1" />
          <span>fires</span>
        </label>
        <span id="rw-status" class="nudge-status"></span>
      </div>
      <p class="nudge-hint">
        Watches each agent's terminal scrollback for API rate-limit and overload errors. On a NEW detection, types your recovery message into that terminal so the agent can resume. After N consecutive fires the watcher escalates to a desktop notification instead — if the API is genuinely down, nudging won't help.
      </p>
      <p class="nudge-hint">
        Recovery message: <span class="mono" id="rw-message">—</span>
      </p>
    </div>
  </section>

  <section class="panel full">
    <h2>Recent messages <span class="count" id="msg-count">0</span></h2>
    <div class="body" id="msg-body"></div>
  </section>
  </div>
 </div>

 <div class="tab-content" id="tab-meter">
  <div class="grid">
  <section class="panel full">
    <h2>Fleet Token Meter <span class="count" id="usage-window">7d</span></h2>
    <div class="body">
      <div class="nudge-controls">
        <label class="nudge-interval">
          Window:
          <select id="usage-days">
            <option value="1">Today</option>
            <option value="7" selected>7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
        <span id="usage-status" class="nudge-status"></span>
      </div>
      <div class="usage-summary" id="usage-summary"></div>
      <div class="usage-trend" id="usage-trend"></div>
      <div id="usage-projects"></div>
      <p class="nudge-hint">
        Reads each live agent's local Claude Code transcript and totals real token usage per project and per model. Counts are exact (input / output / cache), deduped across forked sessions. The dollar figure is <em>API-equivalent value at list price</em> — on a Max plan you pay a flat fee, so it shows how much consumption the subscription is buying, not a bill. Shows consumption, not your plan's weekly quota ceiling (that's server-side and not exposed locally). <strong>Compact opportunity</strong> = an upper-bound estimate of the cache-read tokens that compacting over-threshold sessions could avoid re-reading — the fixable slice the context-hygiene watcher targets (the real soak measures the actual delta). Read-only — never writes transcripts or touches terminals.
      </p>
    </div>
  </section>

  <section class="panel full">
    <h2>Per-Agent — Lifetime · Live Context · Compactions</h2>
    <div class="body">
      <div id="timeline-body"><p class="nudge-hint">loading…</p></div>
      <p class="nudge-hint">
        <strong>How to read each column:</strong><br>
        • <strong>Cumulative (lifetime)</strong> — every token this agent has ever consumed (input + output + cache), summed across <em>all</em> its sessions/transcripts. Monotonic — it never drops: a compaction resets the live context but doesn't un-spend past tokens. The $ is API-equivalent value at list price (Max plan = flat fee).<br>
        • <strong>Current context (live)</strong> — the size of the window it re-reads <em>this turn</em>, from its latest activity. A compaction RESETS this (e.g. 611K → 13K), then it re-climbs as the agent works — the sawtooth. The $/turn is the cache-read cost at that size.<br>
        • <strong>Compacts</strong> — total number of times this agent's context has been reset over its lifetime, counting BOTH Claude Code's automatic auto-compacts (fire near the context limit) AND manual <span class="mono">/compact</span> or <span class="mono">/clear</span>. The split (N auto · M manual) is shown beneath the total. Each one is a <span class="mono">compact_boundary</span> marker in the transcript.<br>
        • <strong>Last compaction</strong> — the most recent reset: its trigger (auto/manual), the before→after token size, and the time.<br>
        The before/after is the current-context drop at a compaction, against the continuous cumulative line. Read-only — never writes transcripts or touches terminals.
      </p>
    </div>
  </section>
  </div>
 </div>
</main>

<footer>ClaudeLink Command Center · auto-refresh every 2s · <span class="mono">127.0.0.1</span></footer>

<script>
const $ = (id) => document.getElementById(id);
const POLL_FAST = 2000;
const POLL_SLOW = 10000;
let pollHandle = null;
let pollMs = POLL_FAST;
let consecutiveFailures = 0;

async function api(path, method = "GET", body = null) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    // Network error (server down) — translate to a typed error so callers
    // can distinguish disconnect from real HTTP failures.
    const err = new Error("disconnected");
    err.disconnected = true;
    throw err;
  }
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()));
  return r.json();
}

function toast(msg, kind = "success") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const t = new Date(iso.replace(" ", "T") + "Z").getTime();
  if (isNaN(t)) return iso;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

function render(state) {
  // servers
  $("srv-count").textContent = state.servers.length;
  const sb = $("srv-table").querySelector("tbody");
  sb.innerHTML = "";
  if (state.servers.length === 0) {
    sb.innerHTML = '<tr><td colspan="5" class="empty">No claudelink-server processes running.</td></tr>';
  } else {
    for (const s of state.servers) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="mono">' + s.pid + '</td>' +
        '<td class="mono">' + (s.tty || "—") + '</td>' +
        '<td class="mono">' + (s.etime || "—") + '</td>' +
        '<td>' + (s.registeredRole ? '<span class="pill info">' + escapeHtml(s.registeredRole) + '</span>' : '<span class="mono">unregistered</span>') + '</td>' +
        '<td><button class="row-action danger" data-kill-pid="' + s.pid + '">Kill</button></td>';
      sb.appendChild(tr);
    }
  }

  // agents
  $("agt-count").textContent = state.agents.length;
  const ab = $("agt-table").querySelector("tbody");
  ab.innerHTML = "";
  if (state.agents.length === 0) {
    ab.innerHTML = '<tr><td colspan="7" class="empty">No agents registered.</td></tr>';
  } else {
    for (const a of state.agents) {
      const tr = document.createElement("tr");
      const status = a.alive
        ? '<span class="pill alive">● online</span>'
        : '<span class="pill dead">● offline</span>';
      const msgs = a.msgs_from + " sent / " + a.msgs_to + " received";
      const action = a.alive
        ? '<button class="row-action danger" data-kill-pid="' + a.pid + '">Kill agent</button>'
        : '<button class="row-action danger" data-remove-id="' + a.id + '">Remove stale</button>';
      const isOn = !!a.autonomous_reply;
      const autoCell = a.alive
        ? '<label class="auto-reply-cell" title="Toggle auto-reply for this agent">' +
            '<input type="checkbox" data-autonomous-id="' + escapeHtml(a.id) + '"' + (isOn ? ' checked' : '') + ' />' +
            '<span class="lbl' + (isOn ? ' on' : '') + '">' + (isOn ? 'on' : 'off') + '</span>' +
          '</label>'
        : '<span class="mono">' + (isOn ? 'on' : 'off') + '</span>';
      tr.innerHTML =
        '<td>' + escapeHtml(a.role) + (a.description ? '<div class="mono">' + escapeHtml(a.description) + '</div>' : "") + '</td>' +
        '<td class="mono">' + a.pid + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + autoCell + '</td>' +
        '<td class="mono">' + msgs + '</td>' +
        '<td class="mono">' + fmtAgo(a.last_seen) + '</td>' +
        '<td>' + action + '</td>';
      ab.appendChild(tr);
    }
  }

  // health
  const h = state.health;
  const orphanCls = h.orphan_blocker_count > 0 ? "warn" : "good";
  const fkCls = h.fk_violations > 0 ? "bad" : "good";
  $("health-grid").innerHTML =
    '<div><div class="label">Total agents</div><div class="value">' + h.total_agents + '</div></div>' +
    '<div><div class="label">Messages (unread / total)</div><div class="value">' + h.unread_messages + ' / ' + h.total_messages + '</div></div>' +
    '<div><div class="label">Bulletin entries</div><div class="value">' + h.total_bulletin + '</div></div>' +
    '<div><div class="label">Orphan blockers</div><div class="value ' + orphanCls + '">' + h.orphan_blocker_count + '</div></div>' +
    '<div><div class="label">FK violations</div><div class="value ' + fkCls + '">' + h.fk_violations + '</div></div>' +
    '<div><div class="label">Servers running</div><div class="value">' + state.servers.length + '</div></div>';

  $("btn-heal").disabled = !(h.orphan_blocker_count > 0 || state.agents.some(a => !a.alive));
  $("heal-hint").textContent = $("btn-heal").disabled
    ? "Nothing to heal — DB is clean."
    : "Will remove dead-agent rows and any messages that would block their cleanup.";

  // Stage 1 — fleet table (live context per alive agent, sorted by occupancy
  // desc). Only renders agents that have fleet metrics; offline agents and
  // alive-but-no-transcript agents are excluded — they'd just be noise.
  renderFleet(state);

  // messages
  $("msg-count").textContent = state.recent_messages.length;
  const mb = $("msg-body");
  mb.innerHTML = "";
  if (state.recent_messages.length === 0) {
    mb.innerHTML = '<div class="empty">No messages yet.</div>';
  } else {
    for (const m of state.recent_messages) {
      const el = document.createElement("div");
      el.className = "msg-row";
      const tag = m.read ? "" : ' <span class="pill warn">unread</span>';
      const pri = m.priority === "high" ? ' <span class="pill warn">high</span>' :
                  m.priority === "low"  ? ' <span class="pill info">low</span>' : '';
      el.innerHTML =
        '<div class="meta">' + escapeHtml(m.from_role || m.from_agent.slice(0,8)) + ' · ' + m.created_at + tag + pri + '</div>' +
        '<div class="content">' + escapeHtml(m.content_preview) + '</div>';
      mb.appendChild(el);
    }
  }

  $("last-update").textContent = "updated " + new Date().toLocaleTimeString();
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function fmtAge(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function renderFleet(state) {
  const fb = $("fleet-table").querySelector("tbody");
  const rows = state.agents
    .filter((a) => a.alive && a.fleet)
    .slice()
    .sort((a, b) => b.fleet.occupancy_pct - a.fleet.occupancy_pct);
  $("fleet-count").textContent = rows.length;
  fb.innerHTML = "";
  if (rows.length === 0) {
    fb.innerHTML = '<tr><td colspan="8" class="empty">No live fleet data — either no agents online, or their transcripts have no usage records yet.</td></tr>';
    return;
  }
  for (const a of rows) {
    const f = a.fleet;
    const pct = f.occupancy_pct;
    const fillCls = pct >= 100 ? "bad" : pct >= 75 ? "warn" : "";
    const barWidth = Math.min(100, Math.max(0, pct));
    const ctxK = Math.round(f.context_tokens / 1000);
    const winK = Math.round(f.window_tokens / 1000);
    const handoffCell = f.handoff_ok
      ? '<span class="pill ok">● fresh</span> <span class="mono">' + fmtAge(f.handoff_mtime_ms) + '</span>'
      : f.handoff_path
        ? '<span class="pill warn">● stale</span> <span class="mono">' + fmtAge(f.handoff_mtime_ms) + '</span>'
        : '<span class="pill miss">— none</span>';
    const sigCell = f.signal_age_min === null
      ? '<span class="pill miss">— none</span>'
      : '<span class="mono">' + (f.signal_age_min < 60 ? f.signal_age_min.toFixed(1) + 'm' : (f.signal_age_min/60).toFixed(1) + 'h') + ' ago</span>' +
        (f.safe_to_clear ? ' <span class="pill ok">safe</span>' : '');
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td>' + escapeHtml(a.role) + '</td>' +
      '<td class="mono">' + escapeHtml(f.model.replace(/^claude-/, "")) + '</td>' +
      '<td class="mono" style="text-align:right">' + ctxK + 'K / ' + winK + 'K</td>' +
      '<td><div style="display:flex;align-items:center"><div class="occ-bar"><div class="fill ' + fillCls + '" style="width:' + barWidth.toFixed(1) + '%"></div></div><span class="occ-pct">' + pct.toFixed(0) + '%</span></div></td>' +
      '<td class="mono" style="text-align:right">$' + f.per_turn_usd.toFixed(2) + '</td>' +
      '<td>' + handoffCell + '</td>' +
      '<td>' + sigCell + '</td>' +
      '<td><button class="row-action" data-copy-prompt="' + escapeHtml(a.role) + '">Copy prompt</button></td>';
    fb.appendChild(tr);
  }
}

async function copyPromptForRole(role) {
  try {
    const r = await api("/api/prompt-clear?role=" + encodeURIComponent(role), "GET");
    if (!r || !r.text) {
      toast("No prompt text returned for " + role, "error");
      return;
    }
    await navigator.clipboard.writeText(r.text);
    toast("Prompt for " + role + " copied — paste into that terminal.");
  } catch (e) {
    toast("Copy failed: " + (e && e.message ? e.message : String(e)), "error");
  }
}

function setPollInterval(ms) {
  if (pollMs === ms) return;
  pollMs = ms;
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(refresh, ms);
}

async function refresh() {
  try {
    const state = await api("/api/state");
    render(state);
    $("status-dot").style.background = "var(--green)";
    $("disconnected-banner").classList.remove("show");
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      setPollInterval(POLL_FAST);
    }
  } catch (e) {
    consecutiveFailures++;
    $("status-dot").style.background = "var(--red)";
    $("last-update").textContent = "disconnected";
    if (e && e.disconnected && consecutiveFailures >= 2) {
      $("disconnected-banner").classList.add("show");
      setPollInterval(POLL_SLOW);
    }
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const killPid = t.getAttribute("data-kill-pid");
  const removeId = t.getAttribute("data-remove-id");
  const copyPromptRole = t.getAttribute("data-copy-prompt");
  if (killPid) {
    if (!confirm("Kill PID " + killPid + " (claudelink-server)?")) return;
    try {
      await api("/api/kill/" + killPid, "POST");
      toast("Killed PID " + killPid);
      refresh();
    } catch (err) { toast(err.message, "error"); }
  } else if (removeId) {
    if (!confirm("Remove stale agent row?")) return;
    try {
      await api("/api/remove-stale/" + removeId, "POST");
      toast("Stale agent removed");
      refresh();
    } catch (err) { toast(err.message, "error"); }
  } else if (copyPromptRole) {
    // Stage 1 fleet-view "Copy prompt" — never types into a terminal; just
    // copies the operator's measured-numbers prompt to clipboard.
    copyPromptForRole(copyPromptRole);
  }
});

$("btn-refresh").addEventListener("click", refresh);
$("btn-kill-all").addEventListener("click", async () => {
  if (!confirm("Kill ALL claudelink-server processes? This will disrupt every Claude Code session using ClaudeLink.")) return;
  try {
    const r = await api("/api/kill-all", "POST");
    toast("Killed " + r.killed.length + " server(s)" + (r.failed.length ? ", " + r.failed.length + " failed" : ""));
    refresh();
  } catch (err) { toast(err.message, "error"); }
});
$("btn-heal").addEventListener("click", async () => {
  if (!confirm("Heal orphans: removes dead-agent rows and their dependent messages.")) return;
  try {
    const r = await api("/api/heal", "POST");
    toast("Pruned " + r.pruned_agents + " agent(s), removed " + r.deleted_messages + " message(s)");
    refresh();
  } catch (err) { toast(err.message, "error"); }
});
$("btn-quit").addEventListener("click", async () => {
  if (!confirm("Quit the Command Center UI? You can re-launch by starting any Claude Code session.")) return;
  try { await api("/api/quit-ui", "POST"); } catch {}
  document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#8a93a6;">UI stopped. You can close this tab.</div>';
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const autonomousId = t.getAttribute("data-autonomous-id");
  if (!autonomousId) return;
  const enabled = t.checked;
  try {
    await api("/api/agents/" + encodeURIComponent(autonomousId) + "/autonomous", "POST", { enabled });
    toast("Auto-reply " + (enabled ? "enabled" : "disabled"));
    refresh();
  } catch (err) {
    t.checked = !enabled;
    toast(err.message, "error");
  }
});

$("btn-retry-now")?.addEventListener("click", refresh);

window.addEventListener("unhandledrejection", (e) => {
  // Suppress noisy console output for network errors from our own polling.
  if (e.reason && e.reason.disconnected) e.preventDefault();
});

refresh();
pollHandle = setInterval(refresh, pollMs);

// --- Auto-nudge controls ---
async function loadNudge() {
  try {
    const s = await api("/api/scheduler", "GET");
    $("nudge-enabled").checked = !!s.enabled;
    $("nudge-enabled-label").textContent = s.enabled ? "On" : "Off";
    $("nudge-interval").value = s.intervalMin;
  } catch (e) {
    if (!e.disconnected) toast("Failed to load nudge settings: " + e.message, "error");
  }
}
async function saveNudge() {
  const enabled = $("nudge-enabled").checked;
  const intervalMin = Math.max(1, Math.min(120, parseInt($("nudge-interval").value, 10) || 5));
  $("nudge-interval").value = intervalMin;
  try {
    const s = await api("/api/scheduler", "POST", { enabled, intervalMin });
    $("nudge-enabled-label").textContent = s.enabled ? "On" : "Off";
    const status = $("nudge-status");
    status.textContent = "saved";
    status.classList.add("show");
    setTimeout(() => status.classList.remove("show"), 1500);
  } catch (e) {
    toast("Failed to save: " + e.message, "error");
  }
}
$("nudge-enabled").addEventListener("change", saveNudge);
$("nudge-interval").addEventListener("change", saveNudge);
loadNudge();

// --- Recovery Watcher controls ---
async function loadRecoveryWatcher() {
  try {
    const s = await api("/api/recovery-watcher", "GET");
    $("rw-enabled").checked = !!s.enabled;
    $("rw-enabled-label").textContent = s.enabled ? "On" : "Off";
    $("rw-interval").value = s.intervalSec;
    $("rw-cooldown").value = s.cooldownMin;
    $("rw-escalate").value = s.escalateAfter;
    $("rw-message").textContent = s.recoveryMessage;
  } catch (e) {
    if (!e.disconnected) toast("Failed to load recovery-watcher settings: " + e.message, "error");
  }
}
async function saveRecoveryWatcher() {
  const enabled = $("rw-enabled").checked;
  const intervalSec = Math.max(15, Math.min(600, parseInt($("rw-interval").value, 10) || 60));
  const cooldownMin = Math.max(1, Math.min(60, parseInt($("rw-cooldown").value, 10) || 5));
  const escalateAfter = Math.max(1, Math.min(20, parseInt($("rw-escalate").value, 10) || 3));
  $("rw-interval").value = intervalSec;
  $("rw-cooldown").value = cooldownMin;
  $("rw-escalate").value = escalateAfter;
  try {
    const s = await api("/api/recovery-watcher", "POST", {
      enabled, intervalSec, cooldownMin, escalateAfter,
    });
    $("rw-enabled-label").textContent = s.enabled ? "On" : "Off";
    const status = $("rw-status");
    status.textContent = "saved";
    status.classList.add("show");
    setTimeout(() => status.classList.remove("show"), 1500);
  } catch (e) {
    toast("Failed to save: " + e.message, "error");
  }
}
$("rw-enabled").addEventListener("change", saveRecoveryWatcher);
$("rw-interval").addEventListener("change", saveRecoveryWatcher);
$("rw-cooldown").addEventListener("change", saveRecoveryWatcher);
$("rw-escalate").addEventListener("change", saveRecoveryWatcher);
loadRecoveryWatcher();

// --- Fleet Token Meter ---
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtUsd(n) {
  return "$" + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2));
}
function renderUsage(u) {
  const t = u.fleet.totals;
  const models = Object.keys(u.fleet.perModel).sort();
  $("usage-window").textContent = u.windowDays + "d";
  $("usage-summary").innerHTML =
    '<div class="usage-stat"><div class="label">Total tokens</div><div class="value">' + fmtTokens(t.totalTokens) + '</div><div class="sub">' + u.scannedProjects + ' projects</div></div>' +
    '<div class="usage-stat"><div class="label">API-equiv. value</div><div class="value">' + fmtUsd(t.estCostUsd) + '</div><div class="sub">at list price · Max = flat fee</div></div>' +
    '<div class="usage-stat"><div class="label">Output tokens</div><div class="value">' + fmtTokens(t.output) + '</div><div class="sub">' + fmtTokens(t.input) + ' input</div></div>' +
    '<div class="usage-stat"><div class="label">Cache reads</div><div class="value">' + fmtTokens(t.cacheRead) + '</div><div class="sub">' + fmtTokens(t.cacheCreation) + ' writes</div></div>' +
    '<div class="usage-stat"><div class="label">Models</div><div class="value" style="font-size:13px;font-weight:500;line-height:1.5">' + (models.map(m => '<span class="usage-model-chip">' + escapeHtml(m.replace("claude-","")) + '</span>').join("") || "—") + '</div></div>';

  // Context-hygiene opportunity: the fixable slice of the burn.
  const co = u.compactOpportunity;
  if (co) {
    const thK = Math.round(co.thresholdTokens / 1000);
    $("usage-summary").innerHTML +=
      '<div class="usage-stat" style="border-color:var(--accent)"><div class="label">Compact opportunity</div><div class="value">' + fmtUsd(co.estUsdUpperBound) + '</div><div class="sub">upper-bound · ' + co.flaggedTurns.toLocaleString() + ' turns &gt;' + thK + 'K ctx</div></div>';
  }

  // Trend visualization adapts to the window. A single day makes a per-day bar
  // a meaningless full-width strip, so for "Today" show a per-project DONUT
  // (where today's burn went) instead. Multi-day keeps the per-day trend bars.
  const trendEl = $("usage-trend");
  if (u.windowDays <= 1) {
    trendEl.className = "usage-trend donut-mode";
    const projs = u.projects.filter(p => p.totals.totalTokens > 0);
    const tot = projs.reduce((s, p) => s + p.totals.totalTokens, 0) || 1;
    const palette = ['#b89cff','#6bb1ff','#3ddc84','#ffb454','#ff6b6b','#9b8cff','#5ac8c8','#ff9cce'];
    let acc = 0;
    const stops = projs.map((p, i) => {
      const start = (acc / tot) * 360; acc += p.totals.totalTokens; const end = (acc / tot) * 360;
      return palette[i % palette.length] + ' ' + start.toFixed(2) + 'deg ' + end.toFixed(2) + 'deg';
    }).join(', ');
    const legend = projs.map((p, i) => {
      const pct = (p.totals.totalTokens / tot) * 100;
      const name = escapeHtml(p.label.split(' (')[0]);
      return '<div class="donut-leg-item"><span class="donut-swatch" style="background:' + palette[i % palette.length] + '"></span><span class="donut-name">' + name + '</span><span class="donut-pct">' + pct.toFixed(0) + '%</span><span class="donut-tok">' + fmtTokens(p.totals.totalTokens) + '</span></div>';
    }).join('');
    trendEl.innerHTML = projs.length
      ? '<div class="usage-donut" style="background:conic-gradient(' + stops + ')"><span class="donut-center">' + fmtTokens(tot) + '</span></div><div class="usage-donut-legend">' + legend + '</div>'
      : '<div style="color:var(--muted)">No usage in this window.</div>';
  } else {
    trendEl.className = "usage-trend";
    const max = Math.max(1, ...u.fleet.perDay.map(d => d.totalTokens));
    trendEl.innerHTML = u.fleet.perDay.map(d => {
      const h = Math.round((d.totalTokens / max) * 100);
      const dd = d.date.slice(5); // MM-DD
      return '<div class="usage-bar" style="height:' + h + '%" title="' + d.date + ': ' + fmtTokens(d.totalTokens) + ' tok · ' + fmtUsd(d.estCostUsd) + '"><span class="cap">' + (d.totalTokens ? fmtTokens(d.totalTokens) : '') + '</span><span class="day">' + dd + '</span></div>';
    }).join("");
  }

  // Per-project table (heaviest first), with a + expand for per-session/agent.
  lastUsage = u;
  renderProjectTable(u);
}

let lastUsage = null;
const expandedProjects = new Set();
function renderProjectTable(u) {
  let rows = u.projects.map(pr => {
    const chips = Object.keys(pr.perModel).sort().map(m =>
      '<span class="usage-model-chip">' + escapeHtml(m.replace("claude-","")) + ' ' + fmtTokens(pr.perModel[m].totalTokens) + '</span>').join("");
    // Expandable only when there's more than one session to break out.
    const expandable = pr.breakdown && pr.breakdown.length > 1;
    const isExp = expandedProjects.has(pr.projectId);
    const toggle = expandable
      ? '<button class="proj-expand" data-proj="' + escapeHtml(pr.projectId) + '" title="Show per-agent / per-session">' + (isExp ? '−' : '+') + '</button>'
      : '<span class="proj-expand-spacer"></span>';
    const rolesLine = pr.agentRoles.length > 1
      ? '<div class="usage-roles">' + escapeHtml(pr.agentRoles.join(", ")) + '</div>' : "";
    let html = '<tr>' +
      '<td>' + toggle + escapeHtml(pr.label) + rolesLine + '</td>' +
      '<td class="num">' + fmtTokens(pr.totals.totalTokens) + '</td>' +
      '<td class="num">' + fmtUsd(pr.totals.estCostUsd) + '</td>' +
      '<td>' + (chips || "—") + '</td>' +
    '</tr>';
    if (expandable && isExp) {
      html += pr.breakdown.map(s => {
        const nm = s.mapped
          ? '<span class="sub-name">' + escapeHtml(s.label) + '</span>'
          : '<span class="sub-unmapped">' + escapeHtml(s.label) + '</span>';
        return '<tr class="usage-subrow">' +
          '<td>' + nm + '</td>' +
          '<td class="num">' + fmtTokens(s.totalTokens) + '</td>' +
          '<td class="num">' + fmtUsd(s.estCostUsd) + '</td>' +
          '<td></td>' +
        '</tr>';
      }).join("");
      // If any session is unattributed, explain why (no register call found —
      // e.g. a resumed/forked session); the rest are labeled by registered name.
      if (pr.breakdown.some(s => !s.mapped)) {
        html += '<tr class="usage-subrow"><td colspan="4" style="font-style:italic;color:var(--muted)">A "session …" row had no register call in its transcript (e.g. a resumed or forked session) — the rest are by registered agent name.</td></tr>';
      }
    }
    return html;
  }).join("");
  if (!rows) rows = '<tr><td colspan="4" style="color:var(--muted)">No in-window usage found for live fleet agents.</td></tr>';
  let note = "";
  if (u.skippedNoCwd && u.skippedNoCwd.length) {
    note = '<p class="nudge-hint" style="padding-top:8px">Unmapped (no project dir resolved): ' + escapeHtml(u.skippedNoCwd.join(", ")) + '</p>';
  }
  $("usage-projects").innerHTML =
    '<table class="usage-proj"><thead><tr><th>Project / agent</th><th style="text-align:right">Tokens</th><th style="text-align:right">API-equiv. $</th><th>By model</th></tr></thead><tbody>' +
    rows + '</tbody></table>' + note;
}
let usageLoading = false;
let usageHasData = false;
async function loadUsage() {
  // Re-entrancy guard: a fleet-transcript scan can take many seconds. Never
  // start a second fetch while one is in flight — overlapping fetches pile up,
  // slam the server, and leave the status stuck on "reading…".
  if (usageLoading) return;
  usageLoading = true;
  const days = parseInt($("usage-days").value, 10) || 7;
  const status = $("usage-status");
  // Only show the prominent "reading…" on the FIRST load (no data yet). On
  // background refreshes the existing numbers stay visible — a subtle hint only.
  status.textContent = usageHasData ? "refreshing…" : "first scan of fleet transcripts — can take a moment…";
  status.classList.add("show");
  try {
    const u = await api("/api/usage?days=" + days, "GET");
    renderUsage(u);
    usageHasData = true;
    status.textContent = "updated";
    setTimeout(() => status.classList.remove("show"), 1200);
  } catch (e) {
    status.textContent = "";
    status.classList.remove("show");
    if (!e.disconnected) toast("Failed to load usage: " + e.message, "error");
  } finally {
    usageLoading = false;
  }
}
$("usage-days").addEventListener("change", loadUsage);
loadUsage();
// Transcript parsing is heavy + server-cached (5 min TTL); refresh on a slow
// cadence so we mostly serve the cache and never overlap a scan.
setInterval(loadUsage, 120000);

// --- Per-agent timeline: cumulative-lifetime · current-context · compactions ---
function renderTimeline(ts) {
  if (!ts || !ts.length) { $("timeline-body").innerHTML = '<p class="nudge-hint">No agent timelines yet.</p>'; return; }
  const rows = ts.map(t => {
    const ev = t.compactEvents || [];
    const autoN = ev.filter(e => e.trigger === 'auto').length;
    const manN = ev.filter(e => e.trigger === 'manual').length;
    const last = ev.length ? ev[ev.length - 1] : null;
    const lastStr = last
      ? escapeHtml(last.trigger) + ' ' + fmtTokens(last.preTokens) + '→' + fmtTokens(last.postTokens) + ' <span class="donut-pct">@' + (last.ts || '').slice(11, 16) + '</span>'
      : '—';
    const compactsCell = ev.length
      ? ev.length + '<div class="usage-roles">' + autoN + ' auto · ' + manN + ' manual</div>'
      : '0';
    return '<tr>' +
      '<td>' + escapeHtml(t.role) + '</td>' +
      '<td class="num">' + fmtTokens(t.cumulativeTokens) + '<div class="usage-roles">' + fmtUsd(t.cumulativeEstUsd) + ' lifetime</div></td>' +
      '<td class="num">' + fmtTokens(t.currentContextTokens) + '<div class="usage-roles">$' + t.currentContextPerTurnUsd.toFixed(2) + '/turn</div></td>' +
      '<td class="num">' + compactsCell + '</td>' +
      '<td>' + lastStr + '</td>' +
    '</tr>';
  }).join('');
  $("timeline-body").innerHTML =
    '<table class="usage-proj"><thead><tr><th>Agent</th><th style="text-align:right">Cumulative (lifetime)</th><th style="text-align:right">Current context (live)</th><th style="text-align:right">Compacts</th><th>Last compaction</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
}
async function loadTimeline() {
  try {
    renderTimeline(await api("/api/agent-timeline", "GET"));
  } catch (e) {
    if (!e.disconnected) $("timeline-body").innerHTML = '<p class="nudge-hint">timeline unavailable: ' + (e.message || '') + '</p>';
  }
}
loadTimeline();
setInterval(loadTimeline, 120000);

// --- Project expand (+) → per-session / per-agent breakdown ---
$("usage-projects").addEventListener("click", (e) => {
  const btn = e.target.closest(".proj-expand");
  if (!btn) return;
  const id = btn.getAttribute("data-proj");
  if (expandedProjects.has(id)) expandedProjects.delete(id);
  else expandedProjects.add(id);
  if (lastUsage) renderProjectTable(lastUsage); // re-render from cached data, no refetch
});

// --- Tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    const target = document.getElementById("tab-" + btn.getAttribute("data-tab"));
    if (target) target.classList.add("active");
  });
});
</script>
</body>
</html>`;

export function startUIServer(port = 7878): http.Server {
  let schedulerHandle: SchedulerHandle | null = null;
  let recoveryWatcherHandle: RecoveryWatcherHandle | null = null;
  let contextWatcherHandle: ContextWatcherHandle | null = null;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: any, contentType = "application/json") => {
      res.statusCode = status;
      res.setHeader("Content-Type", contentType);
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const p = url.pathname;

      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        return send(200, HTML, "text/html; charset=utf-8");
      }
      if (req.method === "GET" && p === "/favicon.svg") {
        res.setHeader("Cache-Control", "public, max-age=86400");
        return send(200, FAVICON_SVG, "image/svg+xml; charset=utf-8");
      }
      if (req.method === "GET" && p === "/api/heartbeat") {
        return send(200, { ok: true, pid: process.pid });
      }
      if (req.method === "GET" && p === "/api/state") {
        return send(200, await getState());
      }
      if (req.method === "POST" && p === "/api/heal") {
        return send(200, healOrphans());
      }
      if (req.method === "POST" && p === "/api/kill-all") {
        return send(200, killAllServers());
      }
      if (req.method === "POST" && p.startsWith("/api/kill/")) {
        const pid = parseInt(p.slice("/api/kill/".length), 10);
        const r = killPid(pid);
        return send(r.ok ? 200 : 400, r);
      }
      if (req.method === "POST" && p.startsWith("/api/remove-stale/")) {
        const id = decodeURIComponent(p.slice("/api/remove-stale/".length));
        const ok = removeStaleAgent(id);
        return send(ok ? 200 : 404, { ok });
      }
      if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/autonomous")) {
        const inner = p.slice("/api/agents/".length, p.length - "/autonomous".length);
        const agentId = decodeURIComponent(inner);
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (typeof parsed.enabled !== "boolean") {
              return send(400, { error: "enabled must be boolean" });
            }
            const ok = setAutonomousReply(agentId, parsed.enabled);
            send(ok ? 200 : 404, { ok, autonomous_reply: parsed.enabled ? 1 : 0 });
          } catch (e: any) {
            send(400, { error: e.message });
          }
        });
        req.on("error", (e: any) => send(400, { error: e.message }));
        return;
      }
      if (req.method === "POST" && p === "/api/quit-ui") {
        send(200, { ok: true });
        setTimeout(() => {
          try { fs.unlinkSync(LOCK_PATH); } catch {}
          process.exit(0);
        }, 50);
        return;
      }
      if (req.method === "GET" && p === "/api/scheduler") {
        return send(200, readSchedulerSettings());
      }
      if (req.method === "POST" && p === "/api/scheduler") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const next = writeSchedulerSettings(parsed);
            if (schedulerHandle) schedulerHandle.reschedule();
            send(200, next);
          } catch (e: any) {
            send(400, { error: e.message });
          }
        });
        req.on("error", (e: any) => send(400, { error: e.message }));
        return;
      }
      if (req.method === "GET" && p === "/api/context-watcher") {
        return send(200, readContextWatcherSettings());
      }
      // Stage 1 — returns the operator's standard "your context is high"
      // prompt with the named agent's measured numbers interpolated. Used by
      // the fleet-view's per-row "copy prompt" button. Read-only: no terminal
      // write, no /clear or /compact fired. The operator pastes manually.
      if (req.method === "GET" && p === "/api/prompt-clear") {
        const role = url.searchParams.get("role");
        if (!role) {
          return send(400, { error: "missing required query param: role" });
        }
        const db2 = new Database(DB_PATH(), { readonly: true });
        let row: {
          pid: number;
          transcript_path: string | null;
        } | undefined;
        try {
          row = db2
            .prepare(
              `SELECT pid, transcript_path FROM agents WHERE role = ? LIMIT 1`
            )
            .get(role) as
            | { pid: number; transcript_path: string | null }
            | undefined;
        } finally {
          db2.close();
        }
        if (!row) {
          return send(404, { error: `no registered agent with role "${role}"` });
        }
        const transcript = findFleetTranscript({
          pid: row.pid,
          transcript_path: row.transcript_path,
        });
        if (!transcript) {
          return send(404, {
            error: `no live session transcript for "${role}"`,
          });
        }
        latestTurnEconomics(transcript).then(
          (econ) => {
            if (!econ) {
              return send(404, {
                error: `no usage records in transcript for "${role}" yet`,
              });
            }
            const text = buildPromptClearText({
              role,
              model: econ.model,
              contextTokens: econ.contextTokens,
              windowTokens: modelContextWindow(econ.model),
              perTurnUsd:
                (econ.contextTokens * cacheReadPricePerMtok(econ.model)) /
                1_000_000,
            });
            return send(200, { text });
          },
          (e: any) => send(500, { error: e?.message ?? String(e) })
        );
        return;
      }
      if (req.method === "GET" && p === "/api/compact-analysis") {
        const raw = parseInt(url.searchParams.get("days") || "30", 10);
        const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, raw)) : 30;
        const db = new Database(DB_PATH(), { readonly: true });
        let rows: { role: string; pid: number }[];
        try {
          rows = db.prepare(`SELECT role, pid FROM agents`).all() as { role: string; pid: number }[];
        } finally {
          db.close();
        }
        const live = rows.filter((r) => isProcessAlive(r.pid));
        // .then(ok, err) split — not .then(ok).catch(err). If `send(200,...)`
        // itself throws (e.g. circular JSON, headers already written), the
        // sibling .catch would also call send → "Cannot set headers after they
        // are sent." The two-arg .then keeps the success and failure paths
        // mutually exclusive.
        analyzeCompactEvents(live, days).then(
          (a) => send(200, a),
          (e: any) => send(500, { error: e?.message ?? String(e) })
        );
        return;
      }
      if (req.method === "POST" && p === "/api/context-watcher") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const next = writeContextWatcherSettings(parsed);
            if (contextWatcherHandle) contextWatcherHandle.reschedule();
            send(200, next);
          } catch (e: any) {
            send(400, { error: e.message });
          }
        });
        req.on("error", (e: any) => send(400, { error: e.message }));
        return;
      }
      if (req.method === "GET" && p === "/api/usage") {
        const raw = parseInt(url.searchParams.get("days") || "7", 10);
        const days = Number.isFinite(raw) ? Math.max(1, Math.min(30, raw)) : 7;
        getUsage(days).then(
          (u) => send(200, u),
          (e: any) => send(500, { error: e?.message ?? String(e) })
        );
        return;
      }
      if (req.method === "GET" && p === "/api/agent-timeline") {
        getAgentTimelines().then(
          (t) => send(200, t),
          (e: any) => send(500, { error: e?.message ?? String(e) })
        );
        return;
      }
      if (req.method === "GET" && p === "/api/recovery-watcher") {
        return send(200, readRecoveryWatcherSettings());
      }
      if (req.method === "POST" && p === "/api/recovery-watcher") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            const next = writeRecoveryWatcherSettings(parsed);
            if (recoveryWatcherHandle) recoveryWatcherHandle.reschedule();
            send(200, next);
          } catch (e: any) {
            send(400, { error: e.message });
          }
        });
        req.on("error", (e: any) => send(400, { error: e.message }));
        return;
      }
      send(404, { error: "not found" });
    } catch (e: any) {
      send(500, { error: e.message });
    }
  });

  server.listen(port, "127.0.0.1");

  // Render-only mode: serve the UI + read endpoints WITHOUT starting the
  // scheduler / recovery-watcher / notifier, and without touching the
  // singleton lock. Lets a second instance be spun up safely (e.g. for a
  // local screenshot or a smoke test) while the real Command Center keeps
  // owning the lock and the keystroke dispatchers — no double-firing.
  const noServices = process.env.CLAUDELINK_UI_NO_SERVICES === "1";
  let stopNotifier: () => void = () => {};
  if (!noServices) {
    stopNotifier = startMessageNotifier();
    schedulerHandle = startScheduler();
    recoveryWatcherHandle = startRecoveryWatcher();
    contextWatcherHandle = startContextWatcher();
  }

  const writeLock = () => {
    if (noServices) return;
    try {
      fs.writeFileSync(
        LOCK_PATH,
        JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }),
        { mode: 0o600 }
      );
    } catch {}
  };
  writeLock();

  const cleanup = () => {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      if (lock.pid === process.pid) fs.unlinkSync(LOCK_PATH);
    } catch {}
  };
  const stopAll = () => {
    stopNotifier();
    if (schedulerHandle) schedulerHandle.stop();
    if (recoveryWatcherHandle) recoveryWatcherHandle.stop();
    if (contextWatcherHandle) contextWatcherHandle.stop();
    cleanup();
  };
  process.on("SIGTERM", () => { stopAll(); process.exit(0); });
  process.on("SIGINT", () => { stopAll(); process.exit(0); });
  process.on("exit", () => { stopAll(); });

  return server;
}

// --- Path C: desktop notifications -----------------------------------------
// Polls the messages table for new ids since the last tick and fires a macOS
// `display notification` for each batch. Polls because better-sqlite3's
// update_hook only fires on changes via the same connection — MCP servers
// writing from other processes wouldn't trigger it. Native macOS Notification
// Center via osascript needs no Accessibility permission.
//
// Fires regardless of the recipient agent's autonomous_reply flag — the
// notification is for the human watching the swarm, not for the agent.
//
// Off-switch: CLAUDELINK_NOTIFY=off
// On non-darwin platforms this is a silent no-op.

const NOTIFY_POLL_MS = 2000;

function escapeForOsascript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function fireDesktopNotification(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  if (process.env.CLAUDELINK_NOTIFY === "off") return;
  const t = escapeForOsascript(title).slice(0, 80);
  const b = escapeForOsascript(body).slice(0, 200);
  try {
    execFileSync(
      "osascript",
      ["-e", `display notification "${b}" with title "${t}"`],
      { timeout: 1500, stdio: ["ignore", "ignore", "ignore"] }
    );
  } catch {
    // Notifications must never break the UI server.
  }
}

interface NotifyRow {
  id: number;
  from_agent: string;
  to_agent: string | null;
  content: string;
  from_role: string | null;
  to_role: string | null;
}

function startMessageNotifier(): () => void {
  if (process.env.CLAUDELINK_NOTIFY === "off") {
    return () => {};
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH(), { readonly: true });
  } catch {
    return () => {};
  }

  // Initialize lastSeenId = current max so we don't notify on the historical
  // backlog when the UI starts. Only NEW inserts past this point fire.
  let lastSeenId = 0;
  try {
    const row = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages")
      .get() as { m: number };
    lastSeenId = row.m;
  } catch {
    // messages table doesn't exist yet (very first boot). Treat as id=0.
  }

  const tick = (): void => {
    if (!db) return;
    let rows: NotifyRow[] = [];
    try {
      rows = db
        .prepare(
          `SELECT m.id, m.from_agent, m.to_agent, m.content,
                  (SELECT role FROM agents WHERE id = m.from_agent) AS from_role,
                  (SELECT role FROM agents WHERE id = m.to_agent)   AS to_role
           FROM messages m
           WHERE m.id > ?
           ORDER BY m.id ASC`
        )
        .all(lastSeenId) as NotifyRow[];
    } catch {
      return;
    }
    if (rows.length === 0) return;
    lastSeenId = rows[rows.length - 1].id;

    if (rows.length === 1) {
      const r = rows[0];
      const from = r.from_role || "agent";
      const to = r.to_role || (r.to_agent === null ? "broadcast" : "agent");
      fireDesktopNotification(`${from} → ${to}`, r.content);
    } else {
      // Collapse: title summarizes count, body shows the first message.
      const r = rows[0];
      const from = r.from_role || "agent";
      const to = r.to_role || (r.to_agent === null ? "broadcast" : "agent");
      const more = rows.length - 1;
      fireDesktopNotification(
        `${rows.length} new ClaudeLink messages`,
        `${from} → ${to}: ${r.content} (+${more} more)`
      );
    }
  };

  const interval = setInterval(() => {
    try { tick(); } catch { /* never crash */ }
  }, NOTIFY_POLL_MS);

  return () => {
    clearInterval(interval);
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  };
}
