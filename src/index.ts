#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NexusDB } from "./db.js";
import { launchUIIfNeeded } from "./ui-launcher.js";

const db = new NexusDB();
let currentAgentId: string | null = null;
let currentRole: string | null = null;

const server = new Server(
  { name: "ClaudeLink", version: "1.0.0" },
  { capabilities: { tools: {} } }
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

        currentAgentId = db.registerAgent(role, description, process.pid);
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

        const count = db.sendMessage(agentId, to, message, priority);
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${count} agent(s) with role "${to}" [priority: ${priority}]`,
            },
          ],
        };
      }

      case "broadcast": {
        const agentId = requireRegistration();
        const message = args?.message as string;

        db.broadcastMessage(agentId, message);
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
          const from = msg.from_role || msg.from_agent.slice(0, 8);
          response += `--- From: ${from}${priorityTag} (${msg.created_at}) ---\n${msg.content}\n\n`;
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
