#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");

const MCP_SERVER_CONFIG = {
  type: "stdio" as const,
  command: "claudelink-server",
};

const CLAUDE_MD_CONTENT = `
## ClaudeLink - Autonomous Agent Communication

You are part of a multi-agent team. Other agents may be running in separate terminals and can send you messages at any time via ClaudeLink.

### Automatic Inbox Checking

- **BEFORE starting any task**: Check your inbox using \`read_inbox\` first
- **AFTER completing any task**: Check your inbox again using \`read_inbox\`
- If you receive a message, acknowledge it and act on it before moving on
- If a message requires you to change your current work, do so immediately
- If a message is from another agent asking for information, respond using \`send\` before continuing your own work
- High-priority messages take precedence over your current task

### Autonomous Collaboration

- When you finish work that another agent might care about, proactively send them an update
- If you encounter a problem that another agent's role could help with, send them a message
- When you make a decision that affects the project, post it to the bulletin board
- If you're blocked waiting for another agent, say so and check inbox again

### Communication Shortcuts

- **"check response"** or **"check messages"** — Use \`read_inbox\` to check for new messages
- **"ask the [role]"** — Send a message to that role and check inbox for their reply
- **"tell the [role]"** — Send a one-way message to that role
- **"who's online"** — Use \`get_agents\` to list all connected agents
- **"update the board"** — Use \`post_bulletin\` to post a status update
- **"check the board"** — Use \`get_bulletin\` to read the bulletin board
`.trim();

const CLAUDE_MD_MARKER = "## ClaudeLink - Autonomous Agent Communication";

function installClaudeMd(scope: "global" | "project") {
  let claudeMdPath: string;

  if (scope === "global") {
    const claudeDir = path.join(os.homedir(), ".claude");
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  } else {
    claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
  }

  // Check if CLAUDE.md exists and already has ClaudeLink content
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, "utf-8");
    if (existing.includes(CLAUDE_MD_MARKER)) {
      console.log(`  CLAUDE.md already has ClaudeLink instructions (${claudeMdPath})`);
      return;
    }
    // Append to existing file
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(claudeMdPath, existing + separator + CLAUDE_MD_CONTENT + "\n");
    console.log(`  Added ClaudeLink instructions to existing ${claudeMdPath}`);
  } else {
    // Create new file
    fs.writeFileSync(claudeMdPath, "# Global Instructions\n\n" + CLAUDE_MD_CONTENT + "\n");
    console.log(`  Created ${claudeMdPath} with ClaudeLink instructions`);
  }
}

function printBanner() {
  console.log(`
    ╔═══════════════════════════════════════════╗
    ║            C L A U D E  L I N K           ║
    ║   The hub where your AI agents connect.   ║
    ╚═══════════════════════════════════════════╝
  `);
}

function initProject() {
  const cwd = process.cwd();
  const mcpJsonPath = path.join(cwd, ".mcp.json");

  // Create ~/.claudelink directory
  if (!fs.existsSync(NEXUS_DIR)) {
    fs.mkdirSync(NEXUS_DIR, { recursive: true });
    console.log(`  Created ${NEXUS_DIR}/`);
  }

  // Read or create .mcp.json
  let mcpConfig: any = { mcpServers: {} };

  if (fs.existsSync(mcpJsonPath)) {
    try {
      const content = fs.readFileSync(mcpJsonPath, "utf-8");
      mcpConfig = JSON.parse(content);
      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
      console.log(`  Found existing .mcp.json`);
    } catch {
      console.log(`  Warning: Could not parse existing .mcp.json, creating fresh one`);
      mcpConfig = { mcpServers: {} };
    }
  }

  // Add claudelink server config
  mcpConfig.mcpServers["claudelink"] = MCP_SERVER_CONFIG;

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log(`  Updated ${mcpJsonPath}`);

  // Install CLAUDE.md with autonomous mode instructions
  installClaudeMd("project");

  console.log(`
  ClaudeLink is ready!

  What was set up:
    - .mcp.json: MCP server config (tells Claude Code to connect to ClaudeLink)
    - CLAUDE.md: Autonomous mode instructions (agents check inbox automatically)

  Next steps:
    1. Restart Claude Code in your terminals
    2. In each terminal, tell Claude to register:
       "Register as a developer agent"
       "Register as a code reviewer"
    3. Agents can now communicate:
       "Send a message to the reviewer: please check auth.ts"
       "Check my inbox for messages"
       "Post to the bulletin board: deployment at 3pm"

  Data stored in: ${NEXUS_DIR}/nexus.db
  Config written to: ${mcpJsonPath}
  `);
}

function initGlobal() {
  // Create ~/.claudelink directory
  if (!fs.existsSync(NEXUS_DIR)) {
    fs.mkdirSync(NEXUS_DIR, { recursive: true });
    console.log(`  Created ${NEXUS_DIR}/`);
  }

  // Use claude mcp add command for proper global registration
  const { execSync } = require("child_process");
  let mcpSuccess = false;
  try {
    execSync("claude mcp add --scope user claudelink -- claudelink-server", {
      stdio: "inherit",
    });
    mcpSuccess = true;
  } catch {
    console.log(`
  Could not run "claude mcp add" automatically.

  Run this command manually to add ClaudeLink globally:

    claude mcp add --scope user claudelink -- claudelink-server
    `);
  }

  // Install global CLAUDE.md with autonomous mode instructions
  installClaudeMd("global");

  if (mcpSuccess) {
    console.log(`
  ClaudeLink is ready (global install)!

  What was set up:
    - ~/.claude.json: MCP server config (available in ALL projects)
    - ~/.claude/CLAUDE.md: Autonomous mode instructions (agents check inbox automatically)

  Next steps:
    1. Restart Claude Code in your terminals
    2. In each terminal, tell Claude to register:
       "Register as a developer agent"
       "Register as a code reviewer"
    3. Agents can now communicate!

  Data stored in: ${NEXUS_DIR}/nexus.db
    `);
  }
}

function showHelp() {
  console.log(`
  Usage: claudelink <command>

  Commands:
    init          Add ClaudeLink to .mcp.json in current project + CLAUDE.md
    init --global Add ClaudeLink globally + ~/.claude/CLAUDE.md
    status        Show registered agents and their status
    ui            Launch the Command Center UI in your browser
    ui --stop     Stop the Command Center UI
    reset         Clear all messages and agent registrations
    help          Show this help message
  `);
}

async function uiCommand(stop: boolean) {
  const { launchUIIfNeeded, stopUI, getUIStatus } = await import("./ui-launcher.js");
  if (stop) {
    const ok = stopUI();
    console.log(ok ? "  Command Center UI stopped." : "  Command Center UI is not running.");
    return;
  }
  const status = getUIStatus();
  if (status.running) {
    console.log(`  Command Center UI is already running.`);
    console.log(`  Open: ${status.url}`);
    return;
  }
  const url = await launchUIIfNeeded({ openBrowser: true });
  if (url) {
    console.log(`  Command Center UI launched.`);
    console.log(`  Open: ${url}`);
  } else {
    console.log(`  Could not launch the Command Center UI.`);
    if (process.env.CLAUDELINK_UI === "off") {
      console.log(`  CLAUDELINK_UI=off is set. Unset it to enable.`);
    }
  }
}

function showStatus() {
  const dbPath = path.join(NEXUS_DIR, "nexus.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  No ClaudeLink database found. Run 'claudelink init' first.");
    return;
  }

  // Dynamic import to avoid requiring better-sqlite3 for CLI-only usage
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });

    const agents = db.prepare("SELECT * FROM agents ORDER BY registered_at DESC").all();
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE read = 0").get() as any;
    const bulletinCount = db.prepare("SELECT COUNT(*) as count FROM bulletin").get() as any;

    console.log(`\n  ClaudeLink Status`);
    console.log(`  ─────────────────`);
    console.log(`  Database: ${dbPath}`);
    console.log(`  Unread messages: ${msgCount.count}`);
    console.log(`  Bulletin entries: ${bulletinCount.count}`);
    console.log(`  Registered agents: ${agents.length}\n`);

    for (const agent of agents as any[]) {
      let alive = false;
      try {
        process.kill(agent.pid, 0);
        alive = true;
      } catch {}

      const status = alive ? "ONLINE" : "OFFLINE";
      console.log(`    [${status}] ${agent.role} (pid: ${agent.pid}) - registered: ${agent.registered_at}`);
      if (agent.description) {
        console.log(`             ${agent.description}`);
      }
    }

    console.log();
    db.close();
  } catch (err: any) {
    console.log(`  Error reading database: ${err.message}`);
  }
}

function resetDB() {
  const dbPath = path.join(NEXUS_DIR, "nexus.db");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    // Clean up WAL files if present
    if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
    if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
    console.log("  ClaudeLink database cleared. All messages and registrations removed.");
  } else {
    console.log("  No database found. Nothing to reset.");
  }
}

// --- Main ---
const args = process.argv.slice(2);
const command = args[0];

printBanner();

switch (command) {
  case "init":
    if (args.includes("--global")) {
      initGlobal();
    } else {
      initProject();
    }
    break;
  case "status":
    showStatus();
    break;
  case "ui":
    uiCommand(args.includes("--stop") || args.includes("stop"));
    break;
  case "reset":
    resetDB();
    break;
  case "help":
  case "--help":
  case "-h":
    showHelp();
    break;
  default:
    if (command) {
      console.log(`  Unknown command: ${command}\n`);
    }
    showHelp();
    break;
}
