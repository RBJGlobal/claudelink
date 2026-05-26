// Auto-nudge scheduler — periodically types "check for updates" into each
// registered agent's terminal whose inbox has unread messages addressed to
// it. Bypasses the prompt-injection trip that direct Stop-hook content
// embedding hits: instead of injecting external content, we simulate the
// keystroke the user would type by hand, and let the existing
// UserPromptSubmit hook (which Claude trusts via additionalContext) inject
// the inbox-check directive.
//
// Per-terminal app dispatch:
//   tmux     — `tmux send-keys -t <pane_id> "<text>" Enter` (no permissions)
//   iterm2   — osascript using iTerm2's AppleScript dictionary, matched by tty
//   terminal — System Events keystroke (needs Accessibility perm; logged but
//              not currently invoked to avoid silent-perms-prompt). Treated
//              as unsupported in v1.
//   other    — skipped silently. terminal_app value is logged.

import path from "path";
import os from "os";
import fs from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import {
  readSchedulerSettings,
  SchedulerSettings,
} from "./scheduler-settings.js";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DB_PATH = path.join(NEXUS_DIR, "nexus.db");
const LOG_PATH = path.join(NEXUS_DIR, "scheduler.log");

const NUDGE_TEXT = "check for updates";

export interface NudgeCandidate {
  id: string;
  role: string;
  tty: string;
  terminal_app: string | null;
  pane_id: string | null;
  pid: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logLine(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging never breaks the scheduler
  }
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function injectKeystroke(c: NudgeCandidate, text: string): "ok" | "skip" | "fail" {
  const app = (c.terminal_app || "").toLowerCase();
  try {
    if (app === "tmux") {
      if (!c.pane_id) {
        logLine(
          `skip role=${c.role} tty=${c.tty} reason="tmux but no pane_id"`
        );
        return "skip";
      }
      execFileSync("tmux", ["send-keys", "-t", c.pane_id, text, "Enter"], {
        timeout: 2000,
        stdio: ["ignore", "ignore", "pipe"],
      });
      return "ok";
    }

    if (app === "iterm2") {
      // Two-write dispatch — required for Codex CLI compatibility.
      //
      // iTerm2's `write text` with multi-character content goes through a
      // bracketed-paste path: the bytes arrive at the receiving process as a
      // PASTE, not as keystrokes. CLIs whose TUI reads keyboard events (Codex)
      // see the embedded CR/LF as "characters within pasted content," not as
      // an Enter key press, and the prompt sits in the input field unsubmitted.
      //
      // Empirically: a SECOND `write text` call containing only the CR byte
      // (no other characters, no newline) is treated as a single keystroke and
      // delivered as the Enter key. So we split: text first (without newline),
      // then a tiny delay, then a standalone CR write (also without newline).
      // The delay keeps the two events ordered as separate dispatches.
      //
      // This is correct for Claude Code and Gemini CLI too — both accept CR
      // as the submit byte.
      const script = `tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is "${escapeForAppleScript(c.tty)}" then
                tell s to write text "${escapeForAppleScript(text)}" without newline
                delay 0.05
                tell s to write text (ASCII character 13) without newline
              end if
            end repeat
          end repeat
        end repeat
      end tell`;
      execFileSync("osascript", ["-e", script], {
        timeout: 3000,
        stdio: ["ignore", "ignore", "pipe"],
      });
      return "ok";
    }

    // Apple Terminal and unknowns: skip with a log entry. Could be
    // wired up via System Events keystroke but that needs Accessibility
    // permission which we don't want to silently prompt for.
    logLine(
      `skip role=${c.role} tty=${c.tty} terminal_app="${c.terminal_app ?? "null"}" reason="unsupported terminal_app"`
    );
    return "skip";
  } catch (err: any) {
    logLine(
      `fail role=${c.role} tty=${c.tty} terminal_app="${c.terminal_app}" error="${err?.message ?? String(err)}"`
    );
    return "fail";
  }
}

function selectCandidates(db: Database.Database): NudgeCandidate[] {
  // Live agents with a known TTY, autonomous_reply on, and at least one
  // unread message addressed to them (or unaddressed broadcast). The
  // EXISTS subquery means no nudge fires if there's nothing to read.
  const rows = db
    .prepare(
      `SELECT a.id, a.role, a.tty, a.terminal_app, a.pane_id, a.pid
       FROM agents a
       WHERE a.tty IS NOT NULL
         AND a.autonomous_reply = 1
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.read = 0
             AND m.from_agent != a.id
             AND (m.to_agent = a.id OR m.to_agent IS NULL)
         )`
    )
    .all() as NudgeCandidate[];
  return rows.filter((c) => isProcessAlive(c.pid));
}

// Per-agent recheck — guards against shared-broadcast races where an
// earlier candidate in this tick (or a separate readInbox path like a
// Stop hook firing concurrently) already consumed the only unread row.
// SQL mirrors the EXISTS clause in selectCandidates exactly so the
// "is this agent still eligible?" semantics match the original filter.
// Returns true if the agent has unread mail right NOW.
function hasUnreadMail(db: Database.Database, agentId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages m
       WHERE m.read = 0
         AND m.from_agent != ?
         AND (m.to_agent = ? OR m.to_agent IS NULL)
       LIMIT 1`
    )
    .get(agentId, agentId);
  return row !== undefined;
}

export interface SchedulerHandle {
  reschedule: () => void;
  stop: () => void;
  tickNow: () => { fired: number; skipped: number; failed: number }; // for tests
}

export function startScheduler(): SchedulerHandle {
  let db: Database.Database | null = null;
  let timer: NodeJS.Timeout | null = null;
  let currentInterval = 0; // minutes

  const openDb = (): Database.Database => {
    if (!db) db = new Database(DB_PATH, { readonly: true });
    return db;
  };

  const tick = (): { fired: number; skipped: number; failed: number } => {
    const summary = { fired: 0, skipped: 0, failed: 0 };
    let candidates: NudgeCandidate[];
    try {
      candidates = selectCandidates(openDb());
    } catch (e: any) {
      logLine(`tick-error: ${e?.message ?? String(e)}`);
      return summary;
    }
    if (candidates.length === 0) return summary;

    for (const c of candidates) {
      // Just-in-time recheck. selectCandidates snapshots the candidate set
      // once, but the dispatch loop runs serially with ~600ms-3s per
      // osascript call. With a shared broadcast row (single `read` flag for
      // all recipients), the first agent to consume it via readInbox or a
      // Stop hook flips read=1 globally — leaving subsequent candidates in
      // this tick's snapshot pointing at no actual unread mail. Without the
      // recheck, we'd type "check for updates" into terminals whose inbox
      // is now empty (spurious-check-for-updates symptom).
      let stillEligible: boolean;
      try {
        stillEligible = hasUnreadMail(openDb(), c.id);
      } catch (e: any) {
        // Fail-open: treat DB errors as eligible, mirroring the project's
        // stated hook posture. If the DB is truly broken, injectKeystroke
        // will fail too and be logged there.
        logLine(
          `recheck-error role=${c.role} tty=${c.tty} error="${e?.message ?? String(e)}"`
        );
        stillEligible = true;
      }
      if (!stillEligible) {
        summary.skipped++;
        logLine(
          `skip-recheck role=${c.role} tty=${c.tty} reason="inbox drained mid-tick"`
        );
        continue;
      }

      const result = injectKeystroke(c, NUDGE_TEXT);
      if (result === "ok") {
        summary.fired++;
        logLine(
          `fired role=${c.role} tty=${c.tty} terminal_app=${c.terminal_app}`
        );
      } else if (result === "skip") {
        summary.skipped++;
      } else {
        summary.failed++;
      }
    }

    // Tick summary makes the broadcast race observable. A healthy directed-
    // mail tick looks like `candidates=3 fired=3 skipped=0`. A broadcast
    // cascade with race losses looks like `candidates=14 fired=1 skipped=13`
    // — that pattern is the smoking-gun fingerprint.
    if (candidates.length > 0) {
      logLine(
        `tick-summary candidates=${candidates.length} fired=${summary.fired} skipped=${summary.skipped} failed=${summary.failed}`
      );
    }
    return summary;
  };

  const reschedule = (): void => {
    const settings: SchedulerSettings = readSchedulerSettings();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    currentInterval = settings.intervalMin;
    if (!settings.enabled) {
      logLine(`reschedule: disabled`);
      return;
    }
    const ms = settings.intervalMin * 60 * 1000;
    timer = setInterval(() => {
      try {
        tick();
      } catch (e: any) {
        logLine(`tick-uncaught: ${e?.message ?? String(e)}`);
      }
    }, ms);
    logLine(`reschedule: enabled, intervalMin=${settings.intervalMin}`);
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
