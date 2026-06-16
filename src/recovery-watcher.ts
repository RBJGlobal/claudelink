// Recovery Watcher — polls each registered agent's terminal scrollback for
// known API-error signatures (Anthropic rate-limit / overload / 5xx and the
// Codex/Gemini equivalents). When a NEW occurrence is detected, types a
// recovery nudge into the terminal via the same two-write keystroke dispatch
// the auto-nudge scheduler uses.
//
// Why this exists: at night, Jay's long-running agents hit Anthropic API
// rate-limiting and the agent's turn halts mid-flight. The agent can't
// recover on its own — Claude Code surfaces the error and waits. Jay had
// been typing "check messages and continue with your current assignment"
// by hand for each stuck agent. This watcher automates that nudge.
//
// State tracking is in-memory: lastErrorSignature + lastFiredAt + consecutiveFires
// per agent. If the process restarts, we lose history and may re-fire once
// per known error — acceptable for MVP.
//
// Three guards prevent runaway loops:
//   1. Cooldown (default 5 min): same agent, same error → don't re-fire.
//   2. Signature de-dup: only fire on a NEW signature (different bytes
//      OR sufficient time has passed). Sitting-in-scrollback errors don't
//      keep re-triggering.
//   3. Escalate-after (default 3 consecutive fires): if we've nudged 3 times
//      and the error keeps coming back, stop nudging and emit a desktop
//      notification instead. The API is genuinely down; nudging won't help.

import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { injectKeystroke, NudgeCandidate } from "./scheduler.js";
import {
  readRecoveryWatcherSettings,
  RecoveryWatcherSettings,
} from "./recovery-watcher-settings.js";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DB_PATH = path.join(NEXUS_DIR, "nexus.db");
const LOG_PATH = path.join(NEXUS_DIR, "recovery-watcher.log");

// Patterns drawn from observed errors across Claude Code, Codex, Gemini.
// MVP is hardcoded; later releases can make this configurable per-agent.
//
// Design rule: every pattern requires CLI-error context (an "API Error:",
// "Error:", or distinctive status-line prefix) on the same visible line as
// the rate-limit/overload keyword. This is what separates real CLI error
// output from prose that merely DISCUSSES rate-limiting (agent conversations,
// docs, log inspection). Without this, the watcher false-fires whenever any
// agent talks about rate-limiting.
// Note: gap classes use [\s\S]{0,N}? (lazy any-char including newline)
// rather than [^\n]*, because iTerm2's `contents of session` returns
// soft-wrapped errors with real \n at the wrap. A long error like
// `API Error: 529 {"type":"error","error":{"type":"overloaded_error",...}}`
// arrives in scrollback as multiple lines; [^\n]* would never bridge the
// gap and the pattern wouldn't fire. The tight upper bound (60-200 chars)
// keeps the false-positive surface narrow — we still need an error
// prefix on the same VISUAL block as the keyword, just not the same
// pre-wrap line.
const ERROR_PATTERNS: RegExp[] = [
  // Claude Code's full rate-limit error line — distinctive enough to be
  // its own pattern. Still subject to position filter below.
  /API\s*Error:\s*Server is temporarily limiting requests/i,

  // Claude Code other API errors — require "API Error:" prefix near the
  // keyword (with bounded any-char gap to allow soft-wrap).
  /API\s*Error:[\s\S]{0,200}?\brate[ _-]?limit/i,
  /API\s*Error:[\s\S]{0,200}?\boverload/i,
  /API\s*Error:[\s\S]{0,200}?\b(529|503|429)\b/i,
  /API\s*Error:[\s\S]{0,200}?\b(rate_limit_error|overloaded_error)\b/i,

  // OpenAI/Codex CLI shapes — require an "error" prefix near the keyword.
  /\bOpenAI\s*API\s*(error|exception):[\s\S]{0,200}?\b(rate_limit|overload)/i,
  /\berror\b[\s\S]{0,60}?\brate_limit_exceeded\b/i,

  // Bare HTTP status lines (distinctive because they include the
  // canonical status text, which prose-mentions rarely include verbatim).
  /\b(429|529)\s+Too Many Requests\b/i,
  /\b503\s+Service Unavailable\b/i,

  // Generic CLI-error safety net — "Error" / "Error:" near the rate-limit
  // token. Requires the Error token to be at the START OF A VISIBLE LINE
  // (optionally with the Claude Code `⎿` tool-output glyph prefix), so
  // prose mentions of the same phrase in mid-conversation don't trigger.
  // Without the line-start anchor, agents writing about ClaudeLink in
  // their own work (e.g. the build-log writer) hit this as a false positive.
  /(?:^|\n)[\s│⎿]*Error:?\b[\s\S]{0,80}?\b(rate[ _-]?limited|rate_limit_error|overloaded_error|request was throttled)\b/i,

  // Claude Code safety-classifier auto-mode failure. Shape:
  //   "<model> is temporarily unavailable, so auto mode cannot determine
  //    the safety of <ToolName> right now. Wait briefly and then try..."
  // When the classifier model is down, auto-permission for a tool call
  // (WebFetch / WebSearch / Bash / Read of a sensitive path / etc.) can't
  // be granted, and the agent halts mid-turn waiting on an approval that
  // will never arrive. Model name and tool name both vary; the
  // "is temporarily unavailable, so auto mode cannot determine the safety"
  // clause is invariant across variants we've observed.
  //
  // No "Error:" / "API Error:" prefix needed here — Claude Code emits this
  // as a system advisory, not an API error, so the prefix design rule from
  // the patterns above doesn't apply. The phrase itself is distinctive
  // enough (no one writes it conversationally) and the MAX_DISTANCE_FROM_END
  // guard still keeps any prose mention from firing.
  /\bis\s+temporarily\s+unavailable,?\s+so\s+auto\s+mode\s+cannot\s+determine\s+the\s+safety\b/i,
];

// Capture only the last N characters of scrollback. Errors that paused
// execution sit at the bottom of the visible buffer. Reading more wastes
// CPU and increases the false-positive surface.
const SCROLLBACK_TAIL_CHARS = 1500;

// Matched error text must be within this many characters of the END of
// the captured scrollback. When a CLI is genuinely stuck, the error is
// near the LAST thing on screen above the prompt. When an agent is
// merely discussing an error in conversation, more text follows the
// mention, pushing it well away from the end. This is the key
// false-positive guard.
//
// The threshold sits at 1000 chars because Claude Code renders ~500 chars
// of UI chrome BELOW a real error (empty prompt line, horizontal
// separators, the "⏵⏵ auto mode on" footer, blank lines). v1.4.0 was
// tuned at 400 based on a synthetic test that omitted that chrome and
// false-negative'd real stuck terminals in production. Discussion cases
// observed at ≥1250 chars from end, so 1000 keeps a clean margin without
// re-introducing the false-positive surface.
const MAX_DISTANCE_FROM_END = 1000;

interface AgentState {
  lastSignature: string | null;
  lastFiredAt: number; // epoch ms
  consecutiveFires: number;
  escalated: boolean;
}

function logLine(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging never breaks the watcher
  }
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Capture the terminal's visible scrollback for the given agent. Returns
// the last SCROLLBACK_TAIL_CHARS of the buffer, or null on failure.
export function captureScrollback(c: NudgeCandidate): string | null {
  const app = (c.terminal_app || "").toLowerCase();
  try {
    if (app === "iterm2") {
      const script = `tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is "${escapeForAppleScript(c.tty)}" then return contents of s
            end repeat
          end repeat
        end repeat
      end tell
      return ""`;
      const out = execFileSync("osascript", ["-e", script], {
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      });
      return out.length > SCROLLBACK_TAIL_CHARS
        ? out.slice(-SCROLLBACK_TAIL_CHARS)
        : out;
    }
    if (app === "tmux") {
      if (!c.pane_id) return null;
      const out = execFileSync(
        "tmux",
        ["capture-pane", "-t", c.pane_id, "-p", "-S", "-50"],
        {
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf-8",
        }
      );
      return out.length > SCROLLBACK_TAIL_CHARS
        ? out.slice(-SCROLLBACK_TAIL_CHARS)
        : out;
    }
    return null;
  } catch {
    return null;
  }
}

// Hash the matched error context to a short signature. We hash the
// matched substring plus a small surrounding window, BUT first
// canonicalize per-request volatile bytes — request IDs, retry counters,
// timestamps — so de-dup compares semantic "same error" rather than
// byte-identical scrollback. Without canonicalization, every tick on a
// genuinely-still-stuck agent produced a fresh signature because Claude
// Code's retry text included a fresh request ID each time; the cooldown
// was masking the de-dup failure by accident.
function computeSignature(scrollback: string, match: RegExpMatchArray): string {
  const start = Math.max(0, (match.index ?? 0) - 32);
  const end = Math.min(scrollback.length, (match.index ?? 0) + match[0].length + 32);
  const window = scrollback.slice(start, end);
  const canon = window
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/gi, "#") // request IDs, hex tokens (≥8 chars)
    .replace(/\d+/g, "#")                // numbers (retry counters, status codes, timestamps)
    .replace(/\s+/g, " ")                // collapse whitespace so re-wrap doesn't shift sig
    .trim();
  return crypto.createHash("sha1").update(canon).digest("hex").slice(0, 16);
}

// Match scrollback against the known patterns. Returns the match CLOSEST
// to the end of the buffer (across all patterns and all occurrences), or
// null if nothing matched within MAX_DISTANCE_FROM_END.
//
// IMPORTANT: this iterates ALL matches across ALL patterns, not just the
// first match per pattern. v1.4.0/v1.4.1 used `scrollback.match(re)`
// which returns only the first occurrence — when Claude Code rendered
// the same error twice (initial failure + retry), the matcher locked
// onto the first (out-of-range) copy and silently skipped, leaving real
// stuck terminals un-nudged. Iterating all matches and picking the
// nearest-to-end is what guarantees a stuck error gets caught.
// Exported for testability — pattern-matching regressions are the easiest
// place for false-positive / false-negative bugs to creep back in.
export function detectError(scrollback: string): { pattern: RegExp; signature: string } | null {
  let best: { match: RegExpExecArray; pattern: RegExp; distanceFromEnd: number } | null = null;
  for (const re of ERROR_PATTERNS) {
    // Force a global flag so exec() iterates rather than locking to first.
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(scrollback)) !== null) {
      const matchEnd = m.index + m[0].length;
      const distance = scrollback.length - matchEnd;
      if (distance > MAX_DISTANCE_FROM_END) continue;
      if (best === null || distance < best.distanceFromEnd) {
        best = { match: m, pattern: re, distanceFromEnd: distance };
      }
      // Guard against pathological zero-width matches advancing the
      // regex engine's lastIndex.
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
  }
  if (!best) return null;
  return {
    pattern: best.pattern,
    signature: computeSignature(scrollback, best.match as unknown as RegExpMatchArray),
  };
}

function fireDesktopNotification(role: string, message: string): void {
  try {
    const title = "ClaudeLink Recovery Watcher";
    const subtitle = role;
    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}" subtitle "${escapeForAppleScript(subtitle)}"`;
    execFileSync("osascript", ["-e", script], {
      timeout: 2000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // notification is best-effort
  }
}

function selectCandidates(db: Database.Database): NudgeCandidate[] {
  // Watch live agents with a known TTY and terminal_app. Unlike the
  // auto-nudge scheduler, we don't filter on autonomous_reply (a stuck
  // advisor still benefits from a recovery nudge) and we don't require
  // unread mail (the recovery message itself is the trigger, not an inbox).
  const rows = db
    .prepare(
      `SELECT id, role, tty, terminal_app, pane_id, pid
       FROM agents
       WHERE tty IS NOT NULL
         AND terminal_app IS NOT NULL`
    )
    .all() as NudgeCandidate[];
  return rows.filter((c) => isProcessAlive(c.pid));
}

export interface RecoveryWatcherHandle {
  reschedule: () => void;
  stop: () => void;
  tickNow: () => { checked: number; fired: number; suppressed: number; escalated: number };
}

export function startRecoveryWatcher(): RecoveryWatcherHandle {
  let db: Database.Database | null = null;
  let timer: NodeJS.Timeout | null = null;
  // Re-entrancy guard. captureScrollback() uses execFileSync with a 3s
  // timeout; on a 14-agent fleet under iTerm2-unresponsive conditions
  // (osascript ETIMEDOUT) a single tick can take 40+ seconds. The
  // setInterval doesn't know or care, and would happily fire the next
  // tick on top, blocking the event loop further. The flag is checked at
  // the head of every tick — if a previous tick is still in flight, the
  // new one logs and returns immediately.
  let tickInProgress = false;
  const state = new Map<string, AgentState>();

  const openDb = (): Database.Database => {
    if (!db) db = new Database(DB_PATH, { readonly: true });
    return db;
  };

  const getState = (id: string): AgentState => {
    let s = state.get(id);
    if (!s) {
      s = { lastSignature: null, lastFiredAt: 0, consecutiveFires: 0, escalated: false };
      state.set(id, s);
    }
    return s;
  };

  const tick = (): { checked: number; fired: number; suppressed: number; escalated: number } => {
    const summary = { checked: 0, fired: 0, suppressed: 0, escalated: 0 };
    if (tickInProgress) {
      logLine(`skip-tick: previous tick still in flight`);
      return summary;
    }
    tickInProgress = true;
    try {
      return runTickBody(summary);
    } finally {
      tickInProgress = false;
    }
  };

  const runTickBody = (summary: { checked: number; fired: number; suppressed: number; escalated: number }) => {
    const settings = readRecoveryWatcherSettings();
    if (!settings.enabled) {
      return summary;
    }

    let candidates: NudgeCandidate[];
    try {
      candidates = selectCandidates(openDb());
    } catch (e: any) {
      logLine(`tick-error: ${e?.message ?? String(e)}`);
      return summary;
    }

    const now = Date.now();
    const cooldownMs = settings.cooldownMin * 60 * 1000;

    for (const c of candidates) {
      summary.checked++;
      const scrollback = captureScrollback(c);
      if (scrollback === null) continue;

      const detected = detectError(scrollback);
      if (!detected) {
        // No error visible: reset the consecutive-fire counter so the agent
        // can be nudged again the next time something goes wrong.
        const s = getState(c.id);
        if (s.consecutiveFires > 0 || s.escalated) {
          logLine(`reset role=${c.role} (no error visible)`);
        }
        s.consecutiveFires = 0;
        s.escalated = false;
        s.lastSignature = null;
        continue;
      }

      const s = getState(c.id);

      // De-dup: same signature within cooldown → suppress silently.
      if (s.lastSignature === detected.signature && now - s.lastFiredAt < cooldownMs) {
        summary.suppressed++;
        continue;
      }

      // Escalation: too many consecutive fires without resolution → stop
      // nudging and notify the user instead.
      if (s.consecutiveFires >= settings.escalateAfter) {
        if (!s.escalated) {
          fireDesktopNotification(
            c.role,
            `Agent ${c.role} appears API-blocked after ${s.consecutiveFires} recovery attempts. Manual intervention may be needed.`
          );
          logLine(
            `escalated role=${c.role} consecutive_fires=${s.consecutiveFires} signature=${detected.signature}`
          );
          s.escalated = true;
          summary.escalated++;
        } else {
          summary.suppressed++;
        }
        continue;
      }

      // Fire the recovery nudge.
      const result = injectKeystroke(c, settings.recoveryMessage);
      if (result === "ok") {
        summary.fired++;
        s.lastSignature = detected.signature;
        s.lastFiredAt = now;
        s.consecutiveFires++;
        logLine(
          `fired role=${c.role} tty=${c.tty} terminal_app=${c.terminal_app} signature=${detected.signature} consecutive=${s.consecutiveFires} pattern=${detected.pattern.source}`
        );
      } else {
        logLine(
          `fire-failed role=${c.role} result=${result} pattern=${detected.pattern.source}`
        );
      }
    }
    tickInProgress = false;
    return summary;
  };

  const reschedule = (): void => {
    const settings: RecoveryWatcherSettings = readRecoveryWatcherSettings();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!settings.enabled) {
      logLine(`reschedule: disabled`);
      return;
    }
    const ms = settings.intervalSec * 1000;
    timer = setInterval(() => {
      try {
        tick();
      } catch (e: any) {
        logLine(`tick-uncaught: ${e?.message ?? String(e)}`);
      }
    }, ms);
    logLine(
      `reschedule: enabled, intervalSec=${settings.intervalSec}, cooldownMin=${settings.cooldownMin}, escalateAfter=${settings.escalateAfter}`
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
        // ignore
      }
      db = null;
    }
  };

  reschedule();
  return { reschedule, stop, tickNow: tick };
}
