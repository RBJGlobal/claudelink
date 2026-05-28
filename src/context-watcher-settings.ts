// Persistent settings for the context-hygiene watcher. Stored as JSON at
// ~/.claudelink/context-watcher.json. Parallel to recovery-watcher-settings.ts.
//
// The watcher monitors each live agent's CURRENT context occupancy (read from
// its Claude Code transcript) and, at a threshold, nudges /compact into that
// terminal so the agent stops re-reading a huge context every turn.
//
// SAFETY: mode defaults to "observe" — detect + log + project savings, NEVER
// inject. "inject" mode (types /compact into live terminals) is founder-gated
// and additionally idle-gated at dispatch time. enabled defaults to false.
//
// Defaults are CONSERVATIVE and PROVISIONAL — thresholdTokens / compactBaseline
// align to the team's token/context protocol (dev-03) once it lands.

import fs from "fs";
import path from "path";
import os from "os";

const SETTINGS_PATH = path.join(
  os.homedir(),
  ".claudelink",
  "context-watcher.json"
);

export type WatcherMode = "observe" | "inject";

export interface ContextWatcherSettings {
  enabled: boolean;
  mode: WatcherMode;
  intervalSec: number;
  thresholdTokens: number; // context occupancy that triggers a (would-)nudge
  compactBaselineTokens: number; // assumed post-compact size, for projection
  cooldownMin: number; // min gap between nudges to the same session
  message: string;
  // ISO timestamp marking the start of a "watcher-active" measurement window,
  // so the meter can attribute a clean before/after. Manually settable so an
  // experiment has crisp window edges (not just an auto-stamp on enable).
  activeSince: string | null;
}

const DEFAULTS: ContextWatcherSettings = {
  enabled: false,
  mode: "observe",
  intervalSec: 120,
  thresholdTokens: 200000,
  compactBaselineTokens: 60000,
  cooldownMin: 30,
  message: "/compact",
  activeSince: null,
};

function clampInt(n: number, lo: number, hi: number, dflt: number): number {
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function readContextWatcherSettings(): ContextWatcherSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      mode: parsed.mode === "inject" ? "inject" : "observe",
      intervalSec: clampInt(Number(parsed.intervalSec), 30, 600, DEFAULTS.intervalSec),
      thresholdTokens: clampInt(Number(parsed.thresholdTokens), 20000, 1_000_000, DEFAULTS.thresholdTokens),
      compactBaselineTokens: clampInt(Number(parsed.compactBaselineTokens), 5000, 200000, DEFAULTS.compactBaselineTokens),
      cooldownMin: clampInt(Number(parsed.cooldownMin), 5, 240, DEFAULTS.cooldownMin),
      message:
        typeof parsed.message === "string" && parsed.message.length > 0
          ? parsed.message
          : DEFAULTS.message,
      activeSince:
        typeof parsed.activeSince === "string" && parsed.activeSince.length > 0
          ? parsed.activeSince
          : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeContextWatcherSettings(
  partial: Partial<ContextWatcherSettings>
): ContextWatcherSettings {
  const current = readContextWatcherSettings();
  const merged: ContextWatcherSettings = {
    enabled: partial.enabled !== undefined ? Boolean(partial.enabled) : current.enabled,
    mode: partial.mode === "inject" || partial.mode === "observe" ? partial.mode : current.mode,
    intervalSec:
      partial.intervalSec !== undefined
        ? clampInt(Number(partial.intervalSec), 30, 600, current.intervalSec)
        : current.intervalSec,
    thresholdTokens:
      partial.thresholdTokens !== undefined
        ? clampInt(Number(partial.thresholdTokens), 20000, 1_000_000, current.thresholdTokens)
        : current.thresholdTokens,
    compactBaselineTokens:
      partial.compactBaselineTokens !== undefined
        ? clampInt(Number(partial.compactBaselineTokens), 5000, 200000, current.compactBaselineTokens)
        : current.compactBaselineTokens,
    cooldownMin:
      partial.cooldownMin !== undefined
        ? clampInt(Number(partial.cooldownMin), 5, 240, current.cooldownMin)
        : current.cooldownMin,
    message:
      partial.message !== undefined && typeof partial.message === "string" && partial.message.length > 0
        ? partial.message
        : current.message,
    activeSince:
      partial.activeSince !== undefined
        ? (typeof partial.activeSince === "string" && partial.activeSince.length > 0 ? partial.activeSince : null)
        : current.activeSince,
  };
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return merged;
}
