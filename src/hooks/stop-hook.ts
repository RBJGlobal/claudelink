// Stop hook — fires when Claude finishes a turn.
//
// What this does:
//   1. Detect the controlling TTY of the parent (Claude Code itself).
//   2. Look up which ClaudeLink agent registered for that TTY.
//   3. Atomically read+mark-read the agent's inbox.
//   4. Stamp last_seen_active_ts so Path B's idle detector has fresh data.
//   5. Apply guards in this order, log every decision to auto-fire.log:
//        a. No agent registered for this TTY → silent exit.
//        b. autonomous_reply == 0          → print messages to stderr, exit 0.
//        c. No messages with expects_reply  → exit 0.
//        d. All messages over chain cap     → exit 0.
//        e. Cap state blocks (cooldown/hard cap) → exit 0.
//        f. Otherwise → emit `{"decision":"block","reason":"..."}` to stdout,
//           exit 0. The reason carries the message contents directly so Claude
//           can act without re-fetching.
//
// What this does NOT do:
//   - Wake idle agents (that's Path B).
//   - Send replies on Claude's behalf (Claude composes the reply in the
//     continued turn, calling the regular `send` MCP tool).
//   - Ever crash the agent: any error path falls back to "exit 0, allow stop".

import { execSync } from "child_process";
import { NexusDB, Message } from "../db.js";
import {
  checkAndIncrement,
  getCaps,
  appendAutoFireLog,
} from "../cap-state.js";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
}

function detectTty(): string | null {
  // Env override for testing and edge cases (e.g., CI without a controlling
  // terminal). Pass through verbatim — caller's responsibility to provide a
  // sane "/dev/ttysNNN" string.
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

function readStdinSync(): string {
  try {
    return require("fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ~500 tokens ≈ 2000 chars (4 chars/token average for English). Long messages
// get truncated in the continuation reason so an 8-deep chain at the chain
// cap can't blow up the continuation context with 8 × full-message bodies.
// The full content remains in the DB (already marked read) and in the
// auto-fire.log inbound count, recoverable for forensics.
const MSG_CONTENT_CAP_CHARS = 2000;

function truncateForReason(content: string): string {
  if (content.length <= MSG_CONTENT_CAP_CHARS) return content;
  return (
    content.slice(0, MSG_CONTENT_CAP_CHARS) +
    "\n... (truncated; full message in DB and auto-fire.log)"
  );
}

function formatContinuation(messages: Message[]): string {
  const lines: string[] = [];
  lines.push(
    `ClaudeLink: ${messages.length} new message(s) addressed to you that expect a reply. They are already marked read in the DB - act on each directly without calling read_inbox again.`
  );
  lines.push("");
  for (const m of messages) {
    const from = m.from_role || m.from_agent.slice(0, 8);
    const priority =
      m.priority === "high"
        ? " [HIGH PRIORITY]"
        : m.priority === "low"
          ? " [low]"
          : "";
    lines.push(`From ${from}${priority} (msg #${m.id}):`);
    lines.push(truncateForReason(m.content));
    lines.push("");
  }
  lines.push(
    "Process each: do the work, then send a reply via the `send` tool to the originator's role with parentMessageId set to the message #. After replying, the conversation may end naturally."
  );
  return lines.join("\n");
}

function main(): number {
  // Read stdin payload (we don't currently use it but consume it so Claude
  // Code's piped write doesn't block, and so future fields like session_id
  // can be picked up without a behavior change).
  const stdin = readStdinSync();
  let payload: StopHookInput = {};
  try {
    if (stdin.trim()) payload = JSON.parse(stdin);
  } catch {
    // Bad JSON in stdin shouldn't crash the hook.
  }

  const tty = detectTty();
  if (!tty) {
    appendAutoFireLog({
      tty: "?",
      agentRole: null,
      decision: "no-agent",
      reason: "could not detect parent TTY",
    });
    return 0;
  }

  let db: NexusDB | null = null;
  try {
    db = new NexusDB();
    const agent = db.getAgentByTty(tty);
    if (!agent) {
      // This terminal isn't a ClaudeLink-registered agent. Silent exit.
      appendAutoFireLog({
        tty,
        agentRole: null,
        decision: "no-agent",
        reason: "no agent registered for this TTY",
      });
      return 0;
    }

    db.updateLastSeenActive(agent.id);

    const inbox = db.readInbox(agent.id);

    if (agent.autonomous_reply === 0) {
      // Read-only mode (advisor pattern). The messages have been marked read
      // (they're in the agent's inbox conceptually) but we never block-and-
      // continue. We print them to stderr so they appear in Claude Code's
      // session log even if the agent is idle; the human can intervene.
      if (inbox.length > 0) {
        for (const m of inbox) {
          process.stderr.write(
            `[ClaudeLink] (read-only) inbox msg #${m.id} from ${m.from_role || m.from_agent.slice(0, 8)}: ${m.content.slice(0, 200)}\n`
          );
        }
      }
      appendAutoFireLog({
        tty,
        agentRole: agent.role,
        decision: "opt-out",
        reason: `autonomous_reply=0 (read-only); ${inbox.length} message(s) consumed`,
        inboundCount: inbox.length,
      });
      return 0;
    }

    // Filter: only messages that expect a reply AND whose chain hasn't hit
    // the cap. Other messages still got marked read (they're consumed) but
    // they don't trigger an auto-fire.
    const caps = getCaps();
    const eligible: Message[] = [];
    for (const m of inbox) {
      if (m.expects_reply !== 1) continue;
      const chainLen = db.getChainLength(m.id);
      if (chainLen >= caps.chainCap) continue;
      eligible.push(m);
    }

    if (eligible.length === 0) {
      appendAutoFireLog({
        tty,
        agentRole: agent.role,
        decision: "no-eligible-msgs",
        reason: `${inbox.length} consumed, 0 eligible (FYI/over-cap)`,
        inboundCount: inbox.length,
      });
      return 0;
    }

    // Cap state check (hard cap + cooldown). Note: this increments the
    // counter on success. Failure leaves state alone, so a stuck swarm
    // does not keep accruing.
    const decision = checkAndIncrement(tty);
    if (!decision.allowed) {
      appendAutoFireLog({
        tty,
        agentRole: agent.role,
        decision: "blocked-by-cap",
        reason: decision.reason,
        inboundCount: inbox.length,
      });
      // Important: the messages were already marked read. They're not lost,
      // they just won't auto-trigger a continuation this time. The agent
      // will see them on the next read_inbox call (which will return empty
      // unless new ones arrived) or via Path C's notifier surfacing them.
      return 0;
    }

    // Fire: emit the block-and-continue JSON.
    const reason = formatContinuation(eligible);
    process.stdout.write(
      JSON.stringify({ decision: "block", reason })
    );
    appendAutoFireLog({
      tty,
      agentRole: agent.role,
      decision: "fired",
      reason: decision.reason,
      inboundCount: eligible.length,
    });
    return 0;
  } catch (err: any) {
    // Default: fail-open. Log the failure and allow the turn to stop.
    // CLAUDELINK_HOOK_STRICT=1 flips to fail-loud: also write the full
    // error + stack to stderr so a bug surfaces in Claude Code's hook
    // debug output instead of hiding in the log file. Exit code stays 0
    // either way — we never want a buggy hook to crash an agent's session.
    const errMsg = err?.message ?? String(err);
    appendAutoFireLog({
      tty: tty ?? "?",
      agentRole: null,
      decision: "no-agent",
      reason: `hook error: ${errMsg}`,
    });
    if (process.env.CLAUDELINK_HOOK_STRICT === "1") {
      process.stderr.write(
        `[ClaudeLink stop-hook STRICT] ${errMsg}\n${err?.stack ?? ""}\n`
      );
    }
    return 0;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

const code = main();
process.exit(code);
