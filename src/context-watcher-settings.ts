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

// Settings location: defaults to ~/.claudelink/context-watcher.json. Honors
// CLAUDELINK_CONTEXT_WATCHER_SETTINGS env var override so tests can run
// against a temp file without disturbing the live fleet's config.
// Evaluated on each call (not cached at module load) so tests can set the
// env var AFTER importing the module.
function settingsPath(): string {
  return (
    process.env.CLAUDELINK_CONTEXT_WATCHER_SETTINGS ||
    path.join(os.homedir(), ".claudelink", "context-watcher.json")
  );
}

export type WatcherMode = "observe" | "inject";

export interface ContextWatcherSettings {
  enabled: boolean;
  mode: WatcherMode;
  intervalSec: number;
  // ECONOMIC TRIGGER (primary): arm when projected per-turn cache-read cost
  // crosses this $ threshold. Auto-adjusts across models (Opus arms far earlier
  // than Haiku for the same context). Replaces the raw-size anchor.
  dollarPerTurnThreshold: number;
  // The fire-DECISION (separate from the trigger): only (would-)nudge when
  // projected forward savings clearly exceed the handshake overhead. Overhead
  // = prepare-prompt + handoff-write + ready-check + re-orient.
  handshakeOverheadTokens: number;
  // "Actively progressing" gate: only act if the session had a turn within this
  // many minutes — so a high-$/turn session about to idle doesn't pay overhead.
  activeWindowMin: number;
  thresholdTokens: number; // legacy size anchor; retained for the projection baseline
  compactBaselineTokens: number; // assumed post-compact size, for projection
  cooldownMin: number; // min gap between nudges to the same session
  message: string;
  // Role allowlist for ARMED inject (the "controlled subset"). FAIL-CLOSED:
  // an empty/unset list fires on NO ONE. Only roles explicitly listed here are
  // ever auto-compacted, regardless of all the other gates. This is what makes
  // a standing-on rollout a controlled subset rather than fleet-wide.
  injectAllowlist: string[];
  // One-shot LATCH for armed inject: fire on the first qualifying agent, then
  // auto-disable (set enabled=false) and log loudly. NOT a cooldown — a single
  // demonstration shot, so arming can't become a standing fleet loop by accident.
  oneShot: boolean;
  // ISO timestamp marking the start of a "watcher-active" measurement window,
  // so the meter can attribute a clean before/after. Manually settable so an
  // experiment has crisp window edges (not just an auto-stamp on enable).
  activeSince: string | null;
}

const DEFAULTS: ContextWatcherSettings = {
  enabled: false,
  mode: "observe",
  intervalSec: 120,
  dollarPerTurnThreshold: 0.27,
  handshakeOverheadTokens: 5000,
  activeWindowMin: 15,
  thresholdTokens: 200000,
  compactBaselineTokens: 60000,
  cooldownMin: 30,
  message: "/compact",
  injectAllowlist: [], // fail-closed: empty = arm nobody
  oneShot: true,
  activeSince: null,
};

function cleanAllowlist(v: any): string[] {
  if (!Array.isArray(v)) return [];
  // Trim whitespace + drop empties + dedupe. Without trim, `["dev", "dev "]`
  // would pass two distinct entries through and the gate's role-includes check
  // would treat "dev " and "dev" as different roles — a footgun if the
  // operator pastes a list with a stray space. Dedupe is belt-and-braces.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const trimmed = x.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function clampInt(n: number, lo: number, hi: number, dflt: number): number {
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function readContextWatcherSettings(): ContextWatcherSettings {
  const SETTINGS_PATH = settingsPath();
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      mode: parsed.mode === "inject" ? "inject" : "observe",
      intervalSec: clampInt(Number(parsed.intervalSec), 30, 600, DEFAULTS.intervalSec),
      dollarPerTurnThreshold:
        Number.isFinite(Number(parsed.dollarPerTurnThreshold)) && Number(parsed.dollarPerTurnThreshold) > 0
          ? Math.max(0.01, Math.min(10, Number(parsed.dollarPerTurnThreshold)))
          : DEFAULTS.dollarPerTurnThreshold,
      handshakeOverheadTokens: clampInt(Number(parsed.handshakeOverheadTokens), 0, 50000, DEFAULTS.handshakeOverheadTokens),
      activeWindowMin: clampInt(Number(parsed.activeWindowMin), 1, 240, DEFAULTS.activeWindowMin),
      thresholdTokens: clampInt(Number(parsed.thresholdTokens), 20000, 1_000_000, DEFAULTS.thresholdTokens),
      compactBaselineTokens: clampInt(Number(parsed.compactBaselineTokens), 5000, 200000, DEFAULTS.compactBaselineTokens),
      cooldownMin: clampInt(Number(parsed.cooldownMin), 5, 240, DEFAULTS.cooldownMin),
      message:
        typeof parsed.message === "string" && parsed.message.length > 0
          ? parsed.message
          : DEFAULTS.message,
      injectAllowlist: cleanAllowlist(parsed.injectAllowlist),
      oneShot: parsed.oneShot === undefined ? DEFAULTS.oneShot : Boolean(parsed.oneShot),
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
    dollarPerTurnThreshold:
      partial.dollarPerTurnThreshold !== undefined && Number(partial.dollarPerTurnThreshold) > 0
        ? Math.max(0.01, Math.min(10, Number(partial.dollarPerTurnThreshold)))
        : current.dollarPerTurnThreshold,
    handshakeOverheadTokens:
      partial.handshakeOverheadTokens !== undefined
        ? clampInt(Number(partial.handshakeOverheadTokens), 0, 50000, current.handshakeOverheadTokens)
        : current.handshakeOverheadTokens,
    activeWindowMin:
      partial.activeWindowMin !== undefined
        ? clampInt(Number(partial.activeWindowMin), 1, 240, current.activeWindowMin)
        : current.activeWindowMin,
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
    injectAllowlist: partial.injectAllowlist !== undefined ? cleanAllowlist(partial.injectAllowlist) : current.injectAllowlist,
    oneShot: partial.oneShot !== undefined ? Boolean(partial.oneShot) : current.oneShot,
    activeSince:
      partial.activeSince !== undefined
        ? (typeof partial.activeSince === "string" && partial.activeSince.length > 0 ? partial.activeSince : null)
        : current.activeSince,
  };
  const SETTINGS_PATH = settingsPath();
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return merged;
}
