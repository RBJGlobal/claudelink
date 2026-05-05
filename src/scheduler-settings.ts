// Persistent settings for the auto-nudge scheduler. Stored as JSON at
// ~/.claudelink/scheduler.json. Read on every tick (cheap), written by the
// Command Center UI when the user toggles enabled / changes interval.
//
// Defaults: enabled=false (opt-in via UI), intervalMin=5. Interval is
// clamped to [1, 120] minutes — anything else is operator error and gets
// silently coerced to a sane value rather than rejected with an error.

import fs from "fs";
import path from "path";
import os from "os";

const SETTINGS_PATH = path.join(os.homedir(), ".claudelink", "scheduler.json");

export interface SchedulerSettings {
  enabled: boolean;
  intervalMin: number;
}

const DEFAULTS: SchedulerSettings = {
  enabled: false,
  intervalMin: 5,
};

function clampInterval(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.intervalMin;
  return Math.max(1, Math.min(120, Math.floor(n)));
}

export function readSchedulerSettings(): SchedulerSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      intervalMin: clampInterval(Number(parsed.intervalMin)),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSchedulerSettings(
  partial: Partial<SchedulerSettings>
): SchedulerSettings {
  const current = readSchedulerSettings();
  const merged: SchedulerSettings = {
    enabled:
      partial.enabled !== undefined ? Boolean(partial.enabled) : current.enabled,
    intervalMin:
      partial.intervalMin !== undefined
        ? clampInterval(Number(partial.intervalMin))
        : current.intervalMin,
  };
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: temp file + rename so a kill mid-write can't corrupt.
  const tmp = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return merged;
}
