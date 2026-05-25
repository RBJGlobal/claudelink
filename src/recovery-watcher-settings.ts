// Persistent settings for the recovery watcher. Stored as JSON at
// ~/.claudelink/recovery-watcher.json. Parallel to scheduler-settings.ts.
//
// Defaults: enabled=false (opt-in via Command Center), intervalSec=60,
// cooldownMin=5, escalateAfter=3 (consecutive fires before suppressing
// further fires and notifying via desktop instead).
//
// recoveryMessage is the exact text typed into the agent's terminal when
// an error pattern is detected and cooldown has passed. Default matches
// what Jay types by hand today.

import fs from "fs";
import path from "path";
import os from "os";

const SETTINGS_PATH = path.join(
  os.homedir(),
  ".claudelink",
  "recovery-watcher.json"
);

export interface RecoveryWatcherSettings {
  enabled: boolean;
  intervalSec: number;
  cooldownMin: number;
  escalateAfter: number;
  recoveryMessage: string;
}

const DEFAULTS: RecoveryWatcherSettings = {
  enabled: false,
  intervalSec: 60,
  cooldownMin: 5,
  escalateAfter: 3,
  recoveryMessage: "check messages and continue with your current assignment",
};

function clampInterval(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.intervalSec;
  return Math.max(15, Math.min(600, Math.floor(n)));
}

function clampCooldown(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.cooldownMin;
  return Math.max(1, Math.min(60, Math.floor(n)));
}

function clampEscalate(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.escalateAfter;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

export function readRecoveryWatcherSettings(): RecoveryWatcherSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      intervalSec: clampInterval(Number(parsed.intervalSec)),
      cooldownMin: clampCooldown(Number(parsed.cooldownMin)),
      escalateAfter: clampEscalate(Number(parsed.escalateAfter)),
      recoveryMessage:
        typeof parsed.recoveryMessage === "string" && parsed.recoveryMessage.length > 0
          ? parsed.recoveryMessage
          : DEFAULTS.recoveryMessage,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeRecoveryWatcherSettings(
  partial: Partial<RecoveryWatcherSettings>
): RecoveryWatcherSettings {
  const current = readRecoveryWatcherSettings();
  const merged: RecoveryWatcherSettings = {
    enabled:
      partial.enabled !== undefined ? Boolean(partial.enabled) : current.enabled,
    intervalSec:
      partial.intervalSec !== undefined
        ? clampInterval(Number(partial.intervalSec))
        : current.intervalSec,
    cooldownMin:
      partial.cooldownMin !== undefined
        ? clampCooldown(Number(partial.cooldownMin))
        : current.cooldownMin,
    escalateAfter:
      partial.escalateAfter !== undefined
        ? clampEscalate(Number(partial.escalateAfter))
        : current.escalateAfter,
    recoveryMessage:
      partial.recoveryMessage !== undefined &&
      typeof partial.recoveryMessage === "string" &&
      partial.recoveryMessage.length > 0
        ? partial.recoveryMessage
        : current.recoveryMessage,
  };
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return merged;
}
