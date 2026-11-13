// Local, opt-in rebuild hook hosted by the Command Center process.
//
// Runs ONE operator-configured shell command (e.g. a private site build):
//   (a) once a day at dailyAt (default 03:30 local), and
//   (b) shortly after any agent calls signal_checkpoint (debounced).
// The command lives ONLY in ~/.claudelink/rebuild-job.json, which is not part of
// the npm package: nothing is configured or run until the operator writes it.
// Failures are logged, never thrown. The signal_checkpoint decision logic is
// untouched: this only watches agents.checkpoint_ts, read-only.

import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import Database from "better-sqlite3";

const DIR = path.join(os.homedir(), ".claudelink");
const CONFIG_PATH = path.join(DIR, "rebuild-job.json");
const LOG_PATH = path.join(DIR, "rebuild-job.log");
const DB_PATH = path.join(DIR, "nexus.db");

export interface RebuildConfig {
  enabled: boolean;
  command: string;
  dailyAt: string; // "HH:MM" local, "" disables the daily run
  onCheckpoint: boolean;
  debounceMin: number;
  timeoutMin: number;
}

const DEFAULTS: RebuildConfig = {
  enabled: false,
  command: "",
  dailyAt: "03:30",
  onCheckpoint: true,
  debounceMin: 10,
  timeoutMin: 10,
};

export function readRebuildConfig(file = CONFIG_PATH): RebuildConfig {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const num = (v: any, d: number, lo: number, hi: number) =>
      Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d;
    return {
      enabled: p.enabled === true,
      command: typeof p.command === "string" ? p.command.trim() : "",
      dailyAt: typeof p.dailyAt === "string" ? p.dailyAt : DEFAULTS.dailyAt,
      onCheckpoint: p.onCheckpoint !== false,
      debounceMin: num(p.debounceMin, DEFAULTS.debounceMin, 1, 1440),
      timeoutMin: num(p.timeoutMin, DEFAULTS.timeoutMin, 1, 120),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

// Daily run is due once local time has passed dailyAt today and no run has
// started since that moment (so a laptop asleep at 03:30 still runs on wake).
export function dailyDue(now: Date, lastStartMs: number, dailyAt: string): boolean {
  const mins = parseHHMM(dailyAt);
  if (mins === null) return false;
  const slot = new Date(now);
  slot.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return now.getTime() >= slot.getTime() && lastStartMs < slot.getTime();
}

// Checkpoint run is due when a checkpoint newer than the last one we acted on
// exists and the debounce window since our last start has elapsed.
export function checkpointDue(
  newestCheckpointMs: number,
  seenCheckpointMs: number,
  nowMs: number,
  lastStartMs: number,
  debounceMin: number
): boolean {
  if (newestCheckpointMs <= seenCheckpointMs) return false;
  return nowMs - lastStartMs >= debounceMin * 60000;
}

function logLine(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export interface RebuildHandle {
  stop: () => void;
}

export function startRebuildJob(): RebuildHandle {
  let running = false;
  // Start-of-process counts as a start: a UI restart must not fire the daily run.
  let lastStart = Date.now();
  let seenCheckpoint = 0;
  let primed = false;
  let db: Database.Database | null = null;

  const newestCheckpoint = (): number => {
    try {
      if (!db) db = new Database(DB_PATH, { readonly: true });
      const r = db.prepare(`SELECT MAX(checkpoint_ts) AS t FROM agents`).get() as { t: number | null };
      return r?.t ?? 0;
    } catch {
      return 0;
    }
  };

  const run = (trigger: string, cfg: RebuildConfig) => {
    running = true;
    lastStart = Date.now();
    logLine(`start trigger=${trigger}`);
    let done = false;
    const child = spawn("/bin/sh", ["-c", cfg.command], { stdio: ["ignore", "ignore", "pipe"] });
    let errTail = "";
    child.stderr?.on("data", (d) => { errTail = (errTail + d.toString()).slice(-400); });
    const killer = setTimeout(() => {
      logLine(`timeout after ${cfg.timeoutMin}m, killing`);
      try { child.kill("SIGTERM"); } catch {}
    }, cfg.timeoutMin * 60000);
    const finish = (msg: string) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      running = false;
      logLine(msg);
    };
    child.on("error", (e) => finish(`error trigger=${trigger} ${e.message}`));
    child.on("close", (code) =>
      finish(
        code === 0
          ? `ok trigger=${trigger} ms=${Date.now() - lastStart}`
          : `fail trigger=${trigger} code=${code} stderr=${JSON.stringify(errTail.trim())}`
      )
    );
  };

  const tick = () => {
    try {
      const cfg = readRebuildConfig();
      if (!cfg.enabled || !cfg.command) return;
      const newest = newestCheckpoint();
      if (!primed) { seenCheckpoint = newest; primed = true; } // ignore pre-start history
      if (running) return;
      const now = Date.now();
      if (dailyDue(new Date(now), lastStart, cfg.dailyAt)) {
        seenCheckpoint = newest;
        run("daily", cfg);
      } else if (cfg.onCheckpoint && checkpointDue(newest, seenCheckpoint, now, lastStart, cfg.debounceMin)) {
        seenCheckpoint = newest;
        run("checkpoint", cfg);
      }
    } catch (e: any) {
      logLine(`tick-error ${e?.message ?? String(e)}`);
    }
  };

  const timer = setInterval(tick, 30000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
