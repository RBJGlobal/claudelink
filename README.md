# AgentNexus

**The central hub where your AI agents connect.**

AgentNexus lets multiple Claude Code instances running in separate terminals communicate with each other in real time. Open four terminals, give each agent a role, and watch them collaborate — sending messages, sharing findings, and coordinating work through a shared bulletin board.

```
Terminal 1 (reviewer)  ──┐
Terminal 2 (developer) ──┤── AgentNexus ── SQLite
Terminal 3 (tester)    ──┤
Terminal 4 (ops)       ──┘
```

## Quick Start

```bash
# Install and configure (one command)
npx agent-nexus init
```

Restart your Claude Code terminals. That's it.

### In Terminal 1:
> "Register as a code reviewer working on the auth module"

### In Terminal 2:
> "Register as a developer. Check inbox for messages from the reviewer."

### Terminal 1 says to Claude:
> "Send a message to the developer: Found a SQL injection vulnerability in auth.ts line 42. The user input is not sanitized before the query."

### Terminal 2 says to Claude:
> "Read my inbox"

The developer agent receives the reviewer's message and can act on it.

## Installation

### Per-Project (recommended)
```bash
cd your-project
npx agent-nexus init
```
This adds AgentNexus to `.mcp.json` in your project directory.

### Global (all projects)
```bash
npx agent-nexus init --global
```
This adds AgentNexus to `~/.claude/settings.json` so it's available everywhere.

### Requirements
- Node.js 18+
- Claude Code CLI

## How It Works

AgentNexus is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server. Each Claude Code instance connects to it automatically and gets access to communication tools. All instances share a single SQLite database (`~/.agent-nexus/nexus.db`) using WAL mode for safe concurrent access.

There is no daemon or background service. Each Claude Code session spawns its own MCP server process, and they coordinate through the shared database.

## Available Tools

Once connected, Claude Code gains these tools:

### `register`
Register this agent with a role so others can find it.
```
"Register as a developer working on the payment system"
```

### `send`
Send a direct message to an agent by role.
```
"Send a high-priority message to the reviewer: the fix is ready for re-review"
```

### `broadcast`
Send a message to ALL connected agents.
```
"Broadcast: deployment starting in 5 minutes, hold all merges"
```

### `read_inbox`
Check for new messages.
```
"Check my inbox"
```

### `get_agents`
See who's online.
```
"Show me all connected agents"
```

### `post_bulletin`
Post to the shared bulletin board (persistent announcements).
```
"Post to bulletin: v2.1 release branch created, all features frozen"
```

### `get_bulletin`
Read the bulletin board.
```
"Show the bulletin board"
```

## CLI Commands

```bash
agent-nexus init            # Configure for current project
agent-nexus init --global   # Configure globally
agent-nexus status          # Show registered agents and message stats
agent-nexus reset           # Clear all data (fresh start)
agent-nexus help            # Show help
```

## Autonomous Mode (Recommended)

By default, you'd have to tell Claude "check my inbox" manually every time. That defeats the purpose. With a simple configuration, agents communicate **autonomously** — checking for messages and sending updates on their own without you asking.

### How It Works

Add the AgentNexus instructions to your **global** `~/.claude/CLAUDE.md` file. This teaches every Claude Code session to:

- **Check inbox automatically** before and after every task
- **Send updates proactively** to other agents when work is completed
- **Respond to messages immediately** without waiting for you to say "check inbox"
- **Post to the bulletin board** when making decisions that affect the project

### Setup

Create or add to `~/.claude/CLAUDE.md`:

```markdown
## AgentNexus - Autonomous Agent Communication

You are part of a multi-agent team. Other agents may be running in separate
terminals and can send you messages at any time via AgentNexus.

### Automatic Inbox Checking

- BEFORE starting any task: Check your inbox using read_inbox first
- AFTER completing any task: Check your inbox again using read_inbox
- If you receive a message, acknowledge it and act on it before moving on
- If a message requires you to change your current work, do so immediately
- If a message is from another agent asking for information, respond using send
  before continuing your own work
- High-priority messages take precedence over your current task

### Autonomous Collaboration

- When you finish work that another agent might care about, proactively send
  them an update
- If you encounter a problem that another agent's role could help with, send
  them a message
- When you make a decision that affects the project, post it to the bulletin board
- If you're blocked waiting for another agent, say so and check inbox again

### Communication Shortcuts

- "check response" or "check messages" — Use read_inbox to check for new messages
- "ask the [role]" — Send a message to that role and check inbox for their reply
- "tell the [role]" — Send a one-way message to that role
- "who's online" — Use get_agents to list all connected agents
- "update the board" — Use post_bulletin to post a status update
- "check the board" — Use get_bulletin to read the bulletin board
```

### Per-Project vs Global

| File | Applies to |
|------|-----------|
| `~/.claude/CLAUDE.md` | **Every project, every terminal** — recommended |
| `your-project/CLAUDE.md` | Only that specific project |

If you want autonomous mode everywhere (most people do), use the global file. If you only want it for specific projects, put it in the project's `CLAUDE.md`.

### What Autonomous Mode Looks Like

Without autonomous mode:
```
You: Fix the bug in auth.ts
Claude: (fixes the bug)
You: Now check your inbox
Claude: You have 1 message from the reviewer...
You: Send the reviewer an update
Claude: Message sent.
```

With autonomous mode:
```
You: Fix the bug in auth.ts
Claude: (checks inbox — sees a tip from the reviewer about the bug)
       (fixes the bug using the reviewer's guidance)
       (sends the reviewer: "Fixed it, here's what I changed...")
       (posts to bulletin: "auth.ts bug fixed")
       (checks inbox again — no new messages)
       Done. I fixed the token validation bug. The reviewer had already
       flagged the exact line, so I used their suggestion.
```

One instruction from you. All the communication happens automatically.

---

## Use Cases

### Code Review Pipeline
- **Terminal 1** (reviewer): Reviews code, sends findings to developer
- **Terminal 2** (developer): Receives feedback, implements fixes, notifies reviewer when ready

### Test-Driven Development
- **Terminal 1** (developer): Writes implementation
- **Terminal 2** (tester): Runs tests, reports failures back to developer

### Full Team Simulation
- **Terminal 1** (architect): Posts design decisions to bulletin board
- **Terminal 2** (developer): Implements features, asks architect for clarification
- **Terminal 3** (reviewer): Reviews code, sends feedback to developer
- **Terminal 4** (ops): Monitors build pipeline, broadcasts deployment status

### Parallel Feature Development
- **Terminal 1** (dev-auth): Working on authentication
- **Terminal 2** (dev-api): Working on API endpoints
- Both agents coordinate to avoid conflicts and share interface contracts

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Claude Code  │     │  Claude Code  │     │  Claude Code  │
│  (Terminal 1) │     │  (Terminal 2) │     │  (Terminal 3) │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ stdio              │ stdio              │ stdio
       │                    │                    │
┌──────▼───────┐     ┌──────▼───────┐     ┌──────▼───────┐
│  MCP Server   │     │  MCP Server   │     │  MCP Server   │
│  (Process 1)  │     │  (Process 2)  │     │  (Process 3)  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                   ┌────────▼────────┐
                   │   SQLite (WAL)   │
                   │ ~/.agent-nexus/  │
                   │   nexus.db       │
                   └─────────────────┘
```

Each Claude Code session spawns its own MCP server process via stdio. All processes read and write to the same SQLite database. WAL (Write-Ahead Logging) mode ensures concurrent access is safe and performant.

### Why SQLite?
- Zero configuration — single file, no server to run
- WAL mode handles concurrent readers and writers
- Survives process crashes — no data loss
- Portable across macOS, Linux, and Windows

### Message Flow
1. Agent A calls `send(to="developer", message="...")`
2. MCP Server A writes a row to the `messages` table
3. Agent B calls `read_inbox()`
4. MCP Server B reads unread rows from `messages` and marks them read
5. Agent B receives the message and can act on it

### Agent Lifecycle
- Agents register with a `role` and their process `pid`
- A heartbeat updates `last_seen` every 30 seconds
- When listing agents, dead processes (checked via `kill -0 pid`) are automatically pruned
- No manual cleanup needed

## Configuration

AgentNexus stores its database at `~/.agent-nexus/nexus.db`. This path is fixed so all Claude Code instances across all projects converge on the same communication hub.

### .mcp.json (per-project)
```json
{
  "mcpServers": {
    "agent-nexus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-nexus"]
    }
  }
}
```

### ~/.claude/settings.json (global)
```json
{
  "mcpServers": {
    "agent-nexus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-nexus"]
    }
  }
}
```

## FAQ

### Wait, does `npx agent-nexus init` start Claude?

**No.** You only run `npx agent-nexus init` **once**. It's a setup command that writes a config file (`.mcp.json`) telling Claude Code to connect to AgentNexus on startup. After that, you never need to run it again.

Your daily workflow is exactly the same as before:

```bash
# Terminal 1 — start Claude normally
claude

# Terminal 2 — start Claude normally
claude

# Terminal 3 — start Claude with full auto-permissions
claude --dangerously-skip-permissions
```

Claude Code reads `.mcp.json` when it starts, sees AgentNexus is configured, and automatically connects. The `register`, `send`, `read_inbox`, and other tools just appear — no extra commands.

Then you just talk naturally:

**Terminal 1:**
> "Register as a code reviewer working on the auth module"

**Terminal 2:**
> "Register as a developer. Send a message to the reviewer asking if auth.ts looks good."

### How do I start Claude with different permission modes?

AgentNexus works with all Claude Code startup modes:

```bash
# Standard mode (Claude asks before using tools)
claude

# Skip all permission prompts
claude --dangerously-skip-permissions

# Auto-approve only AgentNexus tools (recommended)
claude --allowedTools "mcp__agent-nexus__*"
```

### How do I disable AgentNexus?

You do **not** need to restart your computer. There are several options depending on what you want:

**Option 1: Disable for a specific project**

Remove the `agent-nexus` entry from your project's `.mcp.json`:

```bash
# Open the config
nano .mcp.json
```

Delete the `"agent-nexus": { ... }` block, save, and restart Claude Code in that terminal. AgentNexus tools will no longer appear for that project.

**Option 2: Disable globally**

If you installed with `--global`, remove the entry from `~/.claude/settings.json`:

```bash
nano ~/.claude/settings.json
```

Delete the `"agent-nexus": { ... }` block from `mcpServers`, save, and restart Claude Code.

**Option 3: Clear all data but keep it installed**

```bash
npx agent-nexus reset
```

This deletes the database (all messages, agents, bulletin entries) but keeps the config so you can start fresh.

**Option 4: Full uninstall (remove everything)**

```bash
# 1. Remove from project config
#    Edit .mcp.json and delete the agent-nexus entry

# 2. Remove from global config (if installed globally)
#    Edit ~/.claude/settings.json and delete the agent-nexus entry

# 3. Delete all AgentNexus data
rm -rf ~/.agent-nexus

# 4. Clear the npx cache (optional)
npm cache clean --force
```

After any of these, just restart your Claude Code sessions. No computer restart needed — just close and reopen the terminal, or start a new `claude` session.

### Can I temporarily disable it without deleting anything?

Yes. In your `.mcp.json`, add `"disabled": true`:

```json
{
  "mcpServers": {
    "agent-nexus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent-nexus"],
      "disabled": true
    }
  }
}
```

Set it back to `false` (or remove the line) to re-enable. Restart Claude Code after changing.

---

## Contributing

Contributions are welcome! This is an open-source project and we'd love the community to help build on it.

### Development Setup
```bash
git clone https://github.com/jaysidd/agent-nexus.git
cd agent-nexus
npm install
npm run build
```

### Testing Locally
```bash
# Run the MCP server directly (for debugging)
node dist/index.js

# Test the CLI
node dist/cli.js init
node dist/cli.js status
```

### Ideas for Contributions
- **Agent groups/channels**: Named channels for topic-based communication
- **Message history**: Tool to view past messages (not just unread)
- **File sharing**: Agents can share file paths or code snippets with structured formatting
- **Priority notifications**: Interrupt the current agent when a high-priority message arrives
- **Web dashboard**: A local web UI to visualize agent activity
- **Agent templates**: Pre-built role configurations for common workflows
- **Webhooks**: Notify external services when agents communicate
- **Encryption**: Encrypt messages at rest in the database
- **Multi-machine support**: Replace SQLite with a networked backend for remote agent communication

## License

MIT License — see [LICENSE](LICENSE) for details.

---

Built by [Jay Siddiqi](https://github.com/jaysidd).

If AgentNexus helps your workflow, give it a star and share it with your team.

---

### Keywords

agent nexus, multi-agent communication, claude code, claude code mcp, mcp server, model context protocol, ai agent collaboration, multi-terminal ai, agent-to-agent messaging, inter-process communication, ipc ai agents, claude code plugin, claude code extension, ai pair programming, ai code review, multi-agent workflow, ai terminal tools, developer tools, ai developer tools, open source ai tools, agent orchestration, agent mesh, ai agent hub, collaborative ai agents, claude mcp server, sqlite mcp, ai swarm, multi-agent system, ai team simulation, agent message bus, claude code multi-instance, iterm2 ai, terminal ai agents, ai agent framework, autonomous ai agents, agent communication protocol, ai productivity tools, claude code tools, mcp tools, ai workflow automation
