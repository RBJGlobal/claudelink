// UserPromptSubmit hook — fires when a prompt is submitted (ideally only on
// real human input, though the docs are silent on whether Stop-hook
// continuations also trigger it; see HANDOVER notes). Resets the per-TTY
// auto-fire counter so the next Stop hook fire starts from 0.
//
// If the docs assumption "fires on human only" is wrong, the worst case is
// that the hard cap (5) effectively becomes "5 fires per cooldown window"
// rather than "5 fires per human prompt" — the cooldown (30s) and chain cap
// (8) still bound runaway loops.

import { execSync } from "child_process";
import { resetCounter, appendAutoFireLog } from "../cap-state.js";

function detectTty(): string | null {
  if (process.env.CLAUDELINK_HOOK_TTY) {
    return process.env.CLAUDELINK_HOOK_TTY;
  }
  try {
    const tty = execSync(`ps -p ${process.ppid} -o tty=`, {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!tty || tty === "??" || tty === "?") return null;
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

function readStdinSync(): void {
  // Drain stdin so Claude Code's pipe write doesn't block. We don't use the
  // payload yet.
  try {
    require("fs").readFileSync(0, "utf8");
  } catch {
    // ignore
  }
}

readStdinSync();

const tty = detectTty();
if (tty) {
  resetCounter(tty);
  appendAutoFireLog({
    tty,
    agentRole: null,
    decision: "counter-reset",
    reason: "UserPromptSubmit fired",
  });
}

process.exit(0);
