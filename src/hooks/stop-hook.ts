// Stop hook — fires when Claude finishes a turn.
//
// What this does:
//   1. Detect the controlling TTY of the parent (Claude Code itself).
//   2. Look up which ClaudeLink agent registered for that TTY.
//   3. Atomically read+mark-read the agent's inbox.
//   4. Stamp last_seen_active_ts so Path B's idle detector has fresh data.
//   5. Touch checkpoint_ts so the context-watcher sees a fresh per-turn safe
//      signal at every natural turn boundary. Two-tier semantic: this is the
//      AUTOMATIC freshness signal for the lossless /compact path. The
//      stronger signal_checkpoint(safe_to_clear=true) MCP call remains the
//      explicit consent reserved for the future destructive /clear path.
//      End-of-turn is by definition a safe instant (no mid-tool-use), so this
//      can run deterministically without the agent having to remember.
//   6. Apply guards in this order, log every decision to auto-fire.log:
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

// We do NOT embed message contents in the continuation reason. Claude Code's
// safety layer (correctly) flags external content steering outbound tool
// calls as potential prompt injection — empirically observed when this hook
// previously inlined inbox bodies. Instead we emit a minimal directive:
// Claude calls its own read_inbox tool, gets the messages as tool output
// (a path Claude trusts because the tool was its own agency), and decides
// whether/how to reply. Side benefit: messages stay unread until Claude
// actually consumes them, so there's no read-state divergence between the
// hook and a follow-up read_inbox call.
function formatContinuationDirective(count: number): string {
  return (
    `ClaudeLink: ${count} new message(s) addressed to you that expect a reply. ` +
    `Call the read_inbox tool now to fetch them, then decide whether and how to respond. ` +
    `If you reply, use the send tool with parentMessageId set to the message id you are replying to.`
  );
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

    // Two-tier checkpoint freshness: refresh the recency channel at every
    // turn boundary. Wrapped so a failure here can never affect the inbox-
    // reply path below. Does NOT set safe_to_clear / handoff_path / note —
    // those remain owned by the explicit signal_checkpoint MCP call.
    try {
      db.touchCheckpoint(agent.id);
    } catch {
      // best-effort; never break the hook
    }

    // v3: capture this agent's session identity from the hook payload so it can
    // be mapped to its EXACT transcript (resolving per-agent attribution in
    // shared repo dirs). Idempotent — only writes when it changes. Wrapped so a
    // capture failure can never affect the hook's auto-fire decision.
    if (payload.session_id || payload.transcript_path) {
      try {
        db.setAgentSession(agent.id, payload.session_id ?? null, payload.transcript_path ?? null);
      } catch {
        // best-effort metadata; never break the hook
      }
    }

    if (agent.autonomous_reply === 0) {
      // Advisor pattern: never block-and-continue. We DO consume the inbox
      // here (mark messages read) so they don't pile up forever — the agent
      // is read-only by design, so something has to acknowledge them.
      // Stderr emit goes to Claude Code's session log, visible to the human
      // running with --debug; not visible to Claude's context.
      const consumed = db.readInbox(agent.id);
      for (const m of consumed) {
        process.stderr.write(
          `[ClaudeLink] (read-only) inbox msg #${m.id} from ${m.from_role || m.from_agent.slice(0, 8)}: ${m.content.slice(0, 200)}\n`
        );
      }
      appendAutoFireLog({
        tty,
        agentRole: agent.role,
        decision: "opt-out",
        reason: `autonomous_reply=0 (read-only); ${consumed.length} message(s) consumed`,
        inboundCount: consumed.length,
      });
      return 0;
    }

    // Autonomous path: PEEK the inbox without marking read. Messages stay
    // available for Claude's read_inbox tool call in the continuation.
    const inbox = db.peekInbox(agent.id);

    // Filter: messages that expect a reply AND whose chain hasn't hit cap.
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
        reason: `${inbox.length} pending, 0 eligible (FYI/over-cap)`,
        inboundCount: inbox.length,
      });
      return 0;
    }

    // Cap state check (hard cap + cooldown). Counter only increments on
    // an allowed fire. Note: even if blocked, we leave the messages
    // unread — the next eligible turn-end will see them again and the
    // hard cap will keep blocking until UserPromptSubmit resets it.
    const decision = checkAndIncrement(tty);
    if (!decision.allowed) {
      appendAutoFireLog({
        tty,
        agentRole: agent.role,
        decision: "blocked-by-cap",
        reason: decision.reason,
        inboundCount: inbox.length,
      });
      return 0;
    }

    // Fire: emit a directive, NOT message contents. Claude pulls contents
    // via read_inbox in the continuation turn (which marks them read).
    const reason = formatContinuationDirective(eligible.length);
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
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
