// Per-TTY auto-fire state for the Stop hook.
//
// Each terminal that has registered an agent gets a tiny JSON file at
// ~/.claudelink/state/<tty>.json holding the consecutive auto-fire count
// and the last-fire timestamp. checkAndIncrement applies the hard cap
// (consecutive fires) and the soft cooldown (seconds since last fire);
// resetCounter is called by the UserPromptSubmit hook when the human types
// something. Everything is per-TTY, so different terminals never contend.

import fs from "fs";
import path from "path";
import os from "os";

const HARD_CAP_DEFAULT = 5;
const COOLDOWN_S_DEFAULT = 30;
const CHAIN_CAP_DEFAULT = 8;

const STATE_DIR = path.join(os.homedir(), ".claudelink", "state");
const LOG_PATH = path.join(os.homedir(), ".claudelink", "auto-fire.log");

export interface FireState {
  count: number;
  lastFireTs: number;
}

export interface Caps {
  hardCap: number;
  cooldownS: number;
  chainCap: number;
}

export interface CapDecision {
  allowed: boolean;
  reason: string;
  newCount: number;
  caps: Caps;
}

function envInt(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(0, n);
}

export function getCaps(): Caps {
  return {
    hardCap: envInt("CLAUDELINK_HARD_CAP", HARD_CAP_DEFAULT),
    cooldownS: envInt("CLAUDELINK_COOLDOWN_S", COOLDOWN_S_DEFAULT),
    chainCap: envInt("CLAUDELINK_CHAIN_CAP", CHAIN_CAP_DEFAULT),
  };
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function ttyToFilename(tty: string): string {
  return tty.replace(/^\/dev\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function statePath(tty: string): string {
  return path.join(STATE_DIR, ttyToFilename(tty) + ".json");
}

export function readState(tty: string): FireState {
  try {
    const raw = fs.readFileSync(statePath(tty), "utf8");
    const parsed = JSON.parse(raw);
    return {
      count: Number(parsed.count) || 0,
      lastFireTs: Number(parsed.lastFireTs) || 0,
    };
  } catch {
    return { count: 0, lastFireTs: 0 };
  }
}

function writeState(tty: string, state: FireState): void {
  ensureStateDir();
  // Atomic-on-POSIX write: write to a sibling temp file then rename. Avoids
  // partial writes if the process is killed mid-write.
  const tmp = statePath(tty) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath(tty));
}

// Apply hard-cap and cooldown policy. If allowed, increment and persist.
// Caller decides what "allowed=false" means (typically: read inbox but do
// not block-and-continue).
export function checkAndIncrement(tty: string): CapDecision {
  const caps = getCaps();
  const now = Date.now();
  const state = readState(tty);

  if (state.lastFireTs > 0) {
    const sinceLastS = (now - state.lastFireTs) / 1000;
    if (sinceLastS < caps.cooldownS) {
      return {
        allowed: false,
        reason: `cooldown (${sinceLastS.toFixed(1)}s of ${caps.cooldownS}s)`,
        newCount: state.count,
        caps,
      };
    }
  }

  if (state.count >= caps.hardCap) {
    return {
      allowed: false,
      reason: `hard cap reached (${state.count}/${caps.hardCap}); awaiting user prompt`,
      newCount: state.count,
      caps,
    };
  }

  const newState: FireState = { count: state.count + 1, lastFireTs: now };
  writeState(tty, newState);
  return {
    allowed: true,
    reason: `fire ${newState.count}/${caps.hardCap}`,
    newCount: newState.count,
    caps,
  };
}

export function resetCounter(tty: string): void {
  try {
    fs.unlinkSync(statePath(tty));
  } catch {
    // No file = already reset.
  }
}

// Append to ~/.claudelink/auto-fire.log so a human can audit the swarm
// without reading any conversation. One line per Stop-hook fire,
// regardless of whether the cap allowed it.
export function appendAutoFireLog(entry: {
  tty: string;
  agentRole: string | null;
  decision:
    | "fired"
    | "blocked-by-cap"
    | "no-eligible-msgs"
    | "opt-out"
    | "no-agent"
    | "counter-reset";
  reason: string;
  inboundCount?: number;
}): void {
  try {
    const ts = new Date().toISOString();
    const role = entry.agentRole ?? "?";
    const inbound = entry.inboundCount === undefined ? "" : ` inbound=${entry.inboundCount}`;
    const line = `${ts} tty=${entry.tty} role=${role} decision=${entry.decision} reason="${entry.reason}"${inbound}\n`;
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // Logging must never break the hook. Drop the entry on failure.
  }
}
