// One rule for "is this registered agent's process still there", shared by the
// database layer, the scheduler, the watchers, fleet restore and the UI.
//
// A bare kill(pid, 0) probe is not enough after a reboot: the same pid number
// can belong to an unrelated program, and the old row then looks alive. A row
// whose owner was last heard from before the machine booted is dead whatever
// its pid says.
//
// The clock used is last_seen, which the owning server refreshes every 30 s,
// and not registered_at, which is written once: a wall-clock step forward
// (manual change, NTP catch-up, a VM resumed after host sleep) moves the
// computed boot time forward too, and a live agent with an old registered_at
// would then be declared dead for good. With last_seen a live agent is
// misjudged for at most one heartbeat. registered_at is the fallback for rows
// read without last_seen. Timestamps are SQLite datetime('now') text (UTC).
// An unreadable or missing timestamp is never treated as stale, so this rule
// can only add to what the pid probe already finds dead.

import os from "os";

// Heartbeat period (30 s) plus room for clock adjustments during boot.
const BOOT_SLACK_MS = 90_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registeredBeforeBoot(
  stamp: string | null | undefined,
  bootMs: number
): boolean {
  if (!stamp) return false;
  const t = Date.parse(stamp.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return false;
  return t < bootMs - BOOT_SLACK_MS;
}

export function bootTimeMs(): number {
  return Date.now() - os.uptime() * 1000;
}

export interface LivenessRow {
  pid: number;
  last_seen?: string | null;
  registered_at?: string | null;
}

export function isAgentAlive(a: LivenessRow): boolean {
  if (!isProcessAlive(a.pid)) return false;
  return !registeredBeforeBoot(a.last_seen ?? a.registered_at, bootTimeMs());
}
