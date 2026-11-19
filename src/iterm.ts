// Small iTerm2 helpers shared by fleet restore and restart prep. iTerm2
// answers AppleScript on its main thread, so when it is busy (many sessions
// redrawing at once, e.g. right after a restart) a `write text` can time out
// and the text is sometimes delivered late and sometimes never. These helpers
// let a caller wait for iTerm2 to be responsive before typing, and look at a
// pane afterwards to decide whether a timed-out keystroke landed.

import { execFileSync } from "child_process";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// How long a trivial query takes, in ms, or null when it does not answer
// within `timeoutMs`.
export function itermPingMs(timeoutMs = 3000): number | null {
  const t0 = Date.now();
  try {
    execFileSync("osascript", ["-e", 'tell application "iTerm2" to count windows'], {
      timeout: timeoutMs,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits until iTerm2 answers a trivial query in under `fastMs`. Returns false
// if it never does within `maxWaitMs`.
export async function waitForIterm(maxWaitMs = 90000, fastMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const ms = itermPingMs();
    if (ms !== null && ms < fastMs) return true;
    if (Date.now() >= deadline) return false;
    await sleep(2000);
  }
}

function forSession(tty: string, body: string, timeoutMs: number): string | null {
  const script = `tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is "${esc(tty)}" then
            ${body}
          end if
        end repeat
      end repeat
    end repeat
    return ""
  end tell`;
  try {
    return execFileSync("osascript", ["-e", script], { timeout: timeoutMs, encoding: "utf8" });
  } catch {
    return null;
  }
}

// Visible text of the pane, or null when iTerm2 could not be read.
export function paneContents(tty: string): string | null {
  return forSession(tty, "return contents of s", 5000);
}

// Sends the Enter key alone. Returns false when iTerm2 did not answer.
export function pressEnter(tty: string): boolean {
  return forSession(tty, "tell s to write text (ASCII character 13) without newline", 3000) !== null;
}

// Last line of a pane that has any text on it.
export function lastLine(contents: string): string {
  const lines = contents.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return lines.length ? lines[lines.length - 1] : "";
}
