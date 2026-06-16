#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { NexusDB } from "./db.js";
import { launchUIIfNeeded } from "./ui-launcher.js";
import {
  HANDOFF_DIR,
  isHandoffPathSafe,
  verifyHandoff,
} from "./compact-executor.js";

const db = new NexusDB();
let currentAgentId: string | null = null;
let currentRole: string | null = null;
// Heartbeat interval handle. Held at module level so a re-register clears
// the prior interval instead of accumulating one per call, and so the
// shutdown handlers below can cancel it cleanly. `.unref()` keeps the
// process exit from being delayed by the timer.
let heartbeatHandle: NodeJS.Timeout | null = null;

// Observe-only audit log for agent-consented checkpoint signals. The auto-
// compact safety gate: agents emit, ClaudeLink records, NOTHING auto-fires.
const CHECKPOINT_LOG = path.join(os.homedir(), ".claudelink", "checkpoint.log");
function appendCheckpointLog(line: string): void {
  try {
    fs.appendFileSync(CHECKPOINT_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging never breaks a tool call */
  }
}

// Auto-detect the controlling TTY of the parent process (Claude Code itself).
// The MCP server's own stdin/stdout are pipes (JSON-RPC), so process.stdout.isTTY
// is false. The parent inherits the terminal's controlling TTY, so ps against
// the parent PID returns it. Returns "/dev/ttysNNN" or null.
function detectTty(): string | null {
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

function detectTerminalAppByTty(tty: string): string | null {
  // Fallback when env-var detection fails. Asks iTerm2 directly via
  // AppleScript whether any session owns this tty. Catches the Codex CLI
  // case: Codex strips environment variables (TERM_PROGRAM included) when
  // spawning MCP children, so the env-based path returns null even though
  // the agent is clearly running inside iTerm2.
  try {
    const script = `tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (tty of s) is "${tty.replace(/"/g, '\\"')}" then return "iterm2"
          end repeat
        end repeat
      end repeat
    end tell
    return ""`;
    const result = execFileSync("osascript", ["-e", script], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return result === "iterm2" ? "iterm2" : null;
  } catch {
    // osascript not installed (non-mac), iTerm2 not running, timeout —
    // all benign. Registration continues with terminal_app=null and the
    // user can patch later or restart with a CLI that doesn't strip env.
    return null;
  }
}

function detectTerminalApp(tty: string | null): string | null {
  if (process.env.TMUX) return "tmux";
  const tp = process.env.TERM_PROGRAM;
  if (tp === "iTerm.app") return "iterm2";
  if (tp === "Apple_Terminal") return "terminal";
  if (tp === "WezTerm") return "wezterm";
  if (tp === "ghostty") return "ghostty";
  if (tp) return tp.toLowerCase();
  // Env-based detection returned null. Try asking iTerm2 directly if we
  // have a tty — handles CLIs that strip env on MCP child spawn.
  if (tty) {
    const byTty = detectTerminalAppByTty(tty);
    if (byTty) return byTty;
  }
  return null;
}

function detectPaneId(): string | null {
  return (
    process.env.TMUX_PANE ||
    process.env.ITERM_SESSION_ID ||
    process.env.WEZTERM_PANE ||
    null
  );
}

// Self-conveying behavioral protocol surfaced to every connecting agent via the
// MCP `initialize` instructions field (Claude Code injects this into the model's
// context automatically — no per-terminal CLAUDE.md edit). Kept well under the
// 2KB Claude Code truncates server instructions at, critical detail first.
// Single global source: every agent reads this identical text on connect.
const CHECKPOINT_INSTRUCTIONS = `ClaudeLink — context checkpoint protocol. Each turn pays to re-read your full context, and an uncontrolled auto-compact can lose hours of work. ClaudeLink watches your context size and can run an autonomous /compact at a moment you've declared safe. Calling signal_checkpoint is how you opt into this protection.

WHEN TO CALL: at every natural rest point — after a discrete piece of work, at end-of-turn with nothing in flight, after summarizing to a handoff or memory file, or any time it's been many turns since your last call. The signal is fresh each call; call often. You decide WHEN it is safe; ClaudeLink decides WHETHER to compact (gates on size, economics, signal age, idle, ambiguity). A compact never lands mid-work — the gate refuses if anything looks in-flight.

PARAMS {safe_to_clear, handoff_path, note}:
- safe_to_clear=true only if your handoff has everything needed to resume AND nothing live still matters. When false, your call still updates the freshness signal — valuable on its own.
- handoff_path: file to resume from (optional).
- note: one-line label, e.g. "finished auth refactor, tests green".

If your role is on the armed allowlist, your call may trigger a real /compact. If not, ClaudeLink records for calibration. Either way, calling is how the system gets safer.`;

const server = new Server(
  { name: "ClaudeLink", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: CHECKPOINT_INSTRUCTIONS }
);

function requireRegistration(): string {
  if (!currentAgentId) {
    throw new Error(
      'You must register first. Use the "register" tool with a role name (e.g., "developer", "reviewer").'
    );
  }
  return currentAgentId;
}

// --- List Tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "register",
      description:
        "Register this agent with a role so other agents can find and message you",
      inputSchema: {
        type: "object" as const,
        properties: {
          role: {
            type: "string",
            description:
              'Your role, e.g. "developer", "reviewer", "tester", "ops"',
          },
          description: {
            type: "string",
            description: "Brief description of what you are working on",
          },
          autonomousReply: {
            type: "boolean",
            description:
              "Whether this agent should auto-process incoming messages via the Stop hook (default: true). Set to false for advisor-style agents that should read but never auto-reply.",
          },
        },
        required: ["role"],
      },
    },
    {
      name: "send",
      description: "Send a message to a specific agent by their role name",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: {
            type: "string",
            description:
              'The role of the agent to send to, e.g. "reviewer"',
          },
          message: { type: "string", description: "The message content" },
          priority: {
            type: "string",
            enum: ["low", "normal", "high"],
            description: "Message priority level (default: normal)",
          },
          expectsReply: {
            type: "boolean",
            description:
              "Whether this message expects a reply (default: true). Set to false for FYI/informational pings so the recipient's auto-reply Stop hook does not fire.",
          },
          parentMessageId: {
            type: "number",
            description:
              "If this is a reply to another message, the parent message ID. Used by the auto-reply Stop hook for chain tracking; agents typically do not need to set this.",
          },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "broadcast",
      description: "Send a message to ALL connected agents",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The message to broadcast to all agents",
          },
          expectsReply: {
            type: "boolean",
            description:
              "Whether this broadcast expects replies (default: true). Set to false for FYI announcements.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "read_inbox",
      description: "Check your inbox for new messages from other agents",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_agents",
      description: "List all registered agents and their current status",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "post_bulletin",
      description:
        "Post a message to the shared bulletin board visible to all agents",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The bulletin message",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "get_bulletin",
      description: "Read the shared bulletin board",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description:
              "Number of recent entries to fetch (default: 10, max: 50)",
          },
        },
      },
    },
    {
      name: "signal_checkpoint",
      description:
        "Call at every natural rest point — after a discrete piece of work, at end-of-turn with nothing in flight, after summarizing to a handoff/memory file, or whenever it's been many turns since your last call. The signal is fresh each call (not a standing flag); call often. You decide WHEN it is safe; ClaudeLink decides WHETHER to compact based on size, economics, signal age, idle state, and handoff verification — a compact never lands mid-work because the gate refuses if anything looks in-flight. If your role is on the armed allowlist, your call may trigger an autonomous /compact when all gates are green. If your role is not on the allowlist, the call is recorded for calibration only. Either way, calling is how the system gets safer.",
      inputSchema: {
        type: "object" as const,
        properties: {
          safe_to_clear: {
            type: "boolean",
            description:
              "true if a FULL CLEAR is safe (handoff has everything needed to resume AND nothing live still matters); false if a summarizing /compact would be safer. Today the armed inject path is /compact only — safe_to_clear is reserved for the future /clear path; calls with safe_to_clear=false still update the freshness signal and are valuable on their own.",
          },
          handoff_path: {
            type: "string",
            description:
              "OPTIONAL — path to your handoff/resume-state file. Must resolve under ~/.claudelink/handoffs/ (paths outside that directory are rejected at this call, so use handoffPathFor() if you have it). Required ONLY for safe_to_clear=true to be honored; otherwise the call still records freshness.",
          },
          note: {
            type: "string",
            description:
              "Optional short label, e.g. \"finished auth refactor, tests green\".",
          },
        },
        required: ["safe_to_clear"],
      },
    },
  ],
}));

// --- Call Tool ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "register": {
        const role = args?.role as string;
        const description = (args?.description as string) || null;
        const autonomousReply =
          args?.autonomousReply === undefined ? true : Boolean(args.autonomousReply);

        const tty = detectTty();
        currentAgentId = db.registerAgent(role, description, process.pid, {
          tty,
          terminalApp: detectTerminalApp(tty),
          paneId: detectPaneId(),
          autonomousReply,
        });
        currentRole = role;

        // Heartbeat every 30 seconds. Clear any prior interval first so a
        // re-register in the same process doesn't accumulate timers.
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        heartbeatHandle = setInterval(() => {
          if (currentAgentId) {
            try {
              db.heartbeat(currentAgentId);
            } catch {
              // DB might be closed during shutdown
            }
          }
        }, 30000);
        heartbeatHandle.unref();

        const agents = db.getAgents();
        const otherAgents = agents.filter((a) => a.id !== currentAgentId);

        let response = `Registered as "${role}" (ID: ${currentAgentId.slice(0, 8)}...)`;
        if (otherAgents.length > 0) {
          response += `\n\nOther active agents:\n`;
          for (const a of otherAgents) {
            response += `  - ${a.role}${a.description ? `: ${a.description}` : ""} [${a.alive ? "online" : "offline"}]\n`;
          }
        } else {
          response += `\n\nNo other agents are currently online.`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "send": {
        const agentId = requireRegistration();
        const to = args?.to as string;
        const message = args?.message as string;
        const priority = (args?.priority as string) || "normal";
        const expectsReply =
          args?.expectsReply === undefined ? true : Boolean(args.expectsReply);
        const parentMessageId =
          typeof args?.parentMessageId === "number" ? args.parentMessageId : null;

        const count = db.sendMessage(agentId, to, message, priority, {
          expectsReply,
          parentMessageId,
        });
        const fyi = expectsReply ? "" : " [FYI, no reply expected]";
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${count} agent(s) with role "${to}" [priority: ${priority}]${fyi}`,
            },
          ],
        };
      }

      case "broadcast": {
        const agentId = requireRegistration();
        const message = args?.message as string;
        const expectsReply =
          args?.expectsReply === undefined ? true : Boolean(args.expectsReply);

        db.broadcastMessage(agentId, message, { expectsReply });
        const agents = db.getAgents().filter((a) => a.id !== agentId);
        return {
          content: [
            {
              type: "text",
              text: `Broadcast sent. ${agents.length} other agent(s) will receive it.`,
            },
          ],
        };
      }

      case "read_inbox": {
        const agentId = requireRegistration();
        const messages = db.readInbox(agentId);

        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No unread messages." }] };
        }

        let response = `${messages.length} unread message(s):\n\n`;
        for (const msg of messages) {
          const priorityTag =
            msg.priority === "high"
              ? " [HIGH PRIORITY]"
              : msg.priority === "low"
                ? " [low]"
                : "";
          const fyiTag = msg.expects_reply === 0 ? " [FYI]" : "";
          const from = msg.from_role || msg.from_agent.slice(0, 8);
          response += `--- From: ${from}${priorityTag}${fyiTag} (${msg.created_at}) ---\n${msg.content}\n\n`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "get_agents": {
        const agents = db.getAgents();

        if (agents.length === 0) {
          return {
            content: [
              { type: "text", text: "No agents are currently registered." },
            ],
          };
        }

        let response = `${agents.length} registered agent(s):\n\n`;
        for (const a of agents) {
          const isMe = a.id === currentAgentId ? " (you)" : "";
          const status = a.alive ? "ONLINE" : "OFFLINE";
          response += `  [${status}] ${a.role}${isMe}${a.description ? ` - ${a.description}` : ""}\n`;
          response += `          ID: ${a.id.slice(0, 8)}... | Last seen: ${a.last_seen}\n\n`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "post_bulletin": {
        const agentId = requireRegistration();
        const message = args?.message as string;

        db.postBulletin(agentId, message);
        return {
          content: [{ type: "text", text: "Posted to bulletin board." }],
        };
      }

      case "get_bulletin": {
        const limit = Math.min(
          Math.max((args?.limit as number) || 10, 1),
          50
        );
        const entries = db.getBulletin(limit);

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "Bulletin board is empty." }],
          };
        }

        let response = `Bulletin board (${entries.length} entries):\n\n`;
        for (const e of entries) {
          const from = e.from_role || e.from_agent.slice(0, 8);
          response += `[${e.created_at}] ${from}: ${e.content}\n`;
        }

        return { content: [{ type: "text", text: response }] };
      }

      case "signal_checkpoint": {
        const agentId = requireRegistration();
        const safeToClear = Boolean(args?.safe_to_clear);
        const rawHandoffPath = (args?.handoff_path as string) || null;
        const note = (args?.note as string) || null;

        // Path safety: agent-controlled `handoff_path` must resolve under
        // ~/.claudelink/handoffs/ (HANDOFF_DIR). Without this an agent could
        // call with handoff_path="/etc/passwd" or any large file on disk and
        // the downstream verifyHandoff size-check would pass — the watcher
        // would observe handoffOk=true on a file the agent didn't write.
        // Reject at ingress and surface the failure to the agent so they can
        // correct it (vs the silent-skip path the watcher would take later).
        let pathFeedback = "";
        let handoffPath: string | null = rawHandoffPath;
        if (rawHandoffPath && !isHandoffPathSafe(rawHandoffPath)) {
          handoffPath = null;
          pathFeedback =
            ` (NOTE: handoff_path "${rawHandoffPath}" was rejected — it must resolve under ${HANDOFF_DIR}. ` +
            `Saved checkpoint with no handoff; safe_to_clear effectively false until you provide a path under that directory.)`;
        } else if (rawHandoffPath && safeToClear) {
          // Validate content too: byte-count alone is bypassable since the
          // template itself is ~270 bytes. If the agent set safe_to_clear=true
          // with a path, the handoff must actually exist and be filled in,
          // else the gate will silently refuse later — give the agent feedback
          // now.
          const v = verifyHandoff(rawHandoffPath);
          if (!v.ok) {
            pathFeedback =
              ` (NOTE: handoff at ${rawHandoffPath} is ${v.bytes} bytes and missing required content — ` +
              `safe_to_clear=true checkpoints need the file to be filled in past the template stub. ` +
              `Checkpoint recorded for freshness; will not satisfy the safety gate until the handoff is filled.)`;
          }
        }

        db.setCheckpoint(agentId, { safeToClear, handoffPath, note });
        appendCheckpointLog(
          `signal role=${currentRole ?? "?"} agent=${agentId.slice(0, 8)} ` +
            `safe_to_clear=${safeToClear} handoff=${handoffPath ?? "-"} ` +
            `raw_handoff=${rawHandoffPath ?? "-"} note=${JSON.stringify(note ?? "")}` +
            (pathFeedback ? ` rejected=true` : "")
        );
        return {
          content: [
            {
              type: "text",
              text:
                "Checkpoint recorded. ClaudeLink weighs this safe-signal against measured context cost; for roles on the armed allowlist a real /compact may follow when the size + economic + idle + handoff gates all pass. Off-allowlist roles are recorded for calibration only." +
                pathFeedback,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ClaudeLink MCP server started (pid: " + process.pid + ")");

  // Launch the Command Center UI (singleton — first server wins, others no-op).
  // Failures here must never break the MCP server, so wrap in a defensive try.
  launchUIIfNeeded({ openBrowser: true })
    .then((url) => {
      if (url) console.error("ClaudeLink Command Center: " + url);
    })
    .catch(() => {});
}

// Shutdown cleanup: clear the heartbeat interval on signal so the timer
// doesn't survive into the (very short) window before Node exits. .unref()
// already covers process-exit blocking; this is belt-and-braces and also
// catches the case where the parent process detaches but the MCP server is
// being kept alive by something else.
function shutdown(): void {
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", shutdown);

main().catch((err) => {
  console.error("Failed to start ClaudeLink:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
