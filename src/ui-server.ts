import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { startScheduler, SchedulerHandle } from "./scheduler.js";
import {
  readSchedulerSettings,
  writeSchedulerSettings,
} from "./scheduler-settings.js";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DB_PATH = path.join(NEXUS_DIR, "nexus.db");
const LOCK_PATH = path.join(NEXUS_DIR, "ui.lock");

interface ServerProc {
  pid: number;
  tty: string;
  etime: string;
  command: string;
  registeredRole: string | null;
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

function getState(): {
  servers: ServerProc[];
  agents: AgentRow[];
  health: Health;
  recent_messages: any[];
} {
  const servers = listClaudelinkServers();
  const db = new Database(DB_PATH, { readonly: false });

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

function healOrphans(): { deleted_messages: number; pruned_agents: number } {
  const db = new Database(DB_PATH);
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
  const db = new Database(DB_PATH);
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
  const db = new Database(DB_PATH);
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

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ClaudeLink Command Center</title>
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
  main { padding: 20px; display: grid; gap: 16px; grid-template-columns: 1fr 1fr; max-width: 1400px; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
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

<main>
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
    <h2>Health</h2>
    <div class="body">
      <div class="health-grid" id="health-grid"></div>
      <div class="actions-bar">
        <button id="btn-heal" class="primary">Heal orphans</button>
        <span id="heal-hint" style="color: var(--muted); font-size: 12px; align-self: center;"></span>
      </div>
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
    <h2>Recent messages <span class="count" id="msg-count">0</span></h2>
    <div class="body" id="msg-body"></div>
  </section>
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
</script>
</body>
</html>`;

export function startUIServer(port = 7878): http.Server {
  let schedulerHandle: SchedulerHandle | null = null;
  const server = http.createServer((req, res) => {
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
      if (req.method === "GET" && p === "/api/heartbeat") {
        return send(200, { ok: true, pid: process.pid });
      }
      if (req.method === "GET" && p === "/api/state") {
        return send(200, getState());
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
      send(404, { error: "not found" });
    } catch (e: any) {
      send(500, { error: e.message });
    }
  });

  server.listen(port, "127.0.0.1");

  const stopNotifier = startMessageNotifier();
  schedulerHandle = startScheduler();

  const writeLock = () => {
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
    db = new Database(DB_PATH, { readonly: true });
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
