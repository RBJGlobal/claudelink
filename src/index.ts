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

const db = new NexusDB();
let currentAgentId: string | null = null;
let currentRole: string | null = null;

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
const CHECKPOINT_INSTRUCTIONS =
  "ClaudeLink — context & checkpoint hygiene: Your context grows every turn and is re-read at a cost you cannot see; ClaudeLink measures it for you. At each SAFE CHECKPOINT — you just finished a discrete unit of work, wrote your progress/decisions to your handoff or memory file, and have nothing in flight — call the signal_checkpoint tool ({safe_to_clear, handoff_path, note}). You decide only WHEN it is safe; ClaudeLink decides WHETHER compacting is worth it, so a compact never lands mid-work. The signal is fresh each call (not a one-time setting) — re-emit at every checkpoint. Set safe_to_clear=true only if everything needed to resume is in your handoff file and nothing live still matters. Currently observe-only — ClaudeLink records the signal and acts on nothing.";

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
        "Call this at a SAFE CHECKPOINT: you have (1) just finished a discrete unit of work, (2) written progress/decisions to your handoff or memory file, and (3) nothing in flight (no half-done edit, no pending tool result, no open multi-step op). You do NOT need to know your own token count — ClaudeLink measures context cost and decides whether to compact; you only mark WHEN it is safe, so a compact never lands mid-work. Instantaneous (a fresh checkpoint each call), not a standing flag — re-emit at every safe checkpoint. safe_to_clear=true only if everything needed to resume is in your handoff file and nothing in live context still matters (permits a full clear, which also recovers a corrupted/erroring session); false = a summarizing compact is safer. Currently observe-only: ClaudeLink records the signal; nothing acts on it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          safe_to_clear: {
            type: "boolean",
            description:
              "true if a FULL CLEAR is safe right now — everything needed to resume is in your handoff file and nothing in live context still matters. false if a summarizing compact would be safer (some live context is still useful).",
          },
          handoff_path: {
            type: "string",
            description:
              "Path to your handoff/resume-state file (current task + progress, key decisions you must not lose, exact next step, open threads). This is what you would resume from after a compact/clear.",
          },
          note: {
            type: "string",
            description: "Optional short note on what you just completed.",
          },
        },
        required: ["safe_to_clear", "handoff_path"],
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

        // Heartbeat every 30 seconds
        setInterval(() => {
          if (currentAgentId) {
            try {
              db.heartbeat(currentAgentId);
            } catch {
              // DB might be closed during shutdown
            }
          }
        }, 30000);

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
        const handoffPath = (args?.handoff_path as string) || null;
        const note = (args?.note as string) || null;

        db.setCheckpoint(agentId, { safeToClear, handoffPath, note });
        appendCheckpointLog(
          `signal role=${currentRole ?? "?"} agent=${agentId.slice(0, 8)} ` +
            `safe_to_clear=${safeToClear} handoff=${handoffPath ?? "-"} note=${JSON.stringify(note ?? "")}`
        );
        return {
          content: [
            {
              type: "text",
              text:
                "Checkpoint recorded (observe-only — no action taken). ClaudeLink will weigh this safe-signal against measured context cost; nothing compacts or clears unless that is separately enabled by the operator.",
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
