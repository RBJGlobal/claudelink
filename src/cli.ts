#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";

const NEXUS_DIR = path.join(os.homedir(), ".agent-nexus");

const MCP_SERVER_CONFIG = {
  type: "stdio" as const,
  command: "agent-nexus-server",
};

function printBanner() {
  console.log(`
    ╔═══════════════════════════════════════════╗
    ║            A G E N T  N E X U S           ║
    ║   The hub where your AI agents connect.   ║
    ╚═══════════════════════════════════════════╝
  `);
}

function initProject() {
  const cwd = process.cwd();
  const mcpJsonPath = path.join(cwd, ".mcp.json");

  // Create ~/.agent-nexus directory
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

  // Add agent-nexus server config
  mcpConfig.mcpServers["agent-nexus"] = MCP_SERVER_CONFIG;

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log(`  Updated ${mcpJsonPath}`);

  console.log(`
  AgentNexus is ready!

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
  // Create ~/.agent-nexus directory
  if (!fs.existsSync(NEXUS_DIR)) {
    fs.mkdirSync(NEXUS_DIR, { recursive: true });
    console.log(`  Created ${NEXUS_DIR}/`);
  }

  // Use claude mcp add command for proper global registration
  const { execSync } = require("child_process");
  try {
    execSync("claude mcp add --scope user agent-nexus -- agent-nexus-server", {
      stdio: "inherit",
    });
    console.log(`
  AgentNexus is ready (global install)!

  The MCP server has been added to your user-level Claude Code config (~/.claude.json).
  It will be available in ALL your Claude Code sessions, in every project.

  Next steps:
    1. Restart Claude Code in your terminals
    2. In each terminal, tell Claude to register:
       "Register as a developer agent"
       "Register as a code reviewer"
    3. Agents can now communicate!

  Data stored in: ${NEXUS_DIR}/nexus.db
    `);
  } catch {
    console.log(`
  Could not run "claude mcp add" automatically.

  Run this command manually to add AgentNexus globally:

    claude mcp add --scope user agent-nexus -- agent-nexus-server

  Then restart your Claude Code sessions.
    `);
  }
}

function showHelp() {
  console.log(`
  Usage: agent-nexus <command>

  Commands:
    init          Add AgentNexus to .mcp.json in current project
    init --global Add AgentNexus to global Claude Code settings
    status        Show registered agents and their status
    reset         Clear all messages and agent registrations
    help          Show this help message
  `);
}

function showStatus() {
  const dbPath = path.join(NEXUS_DIR, "nexus.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  No AgentNexus database found. Run 'agent-nexus init' first.");
    return;
  }

  // Dynamic import to avoid requiring better-sqlite3 for CLI-only usage
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });

    const agents = db.prepare("SELECT * FROM agents ORDER BY registered_at DESC").all();
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE read = 0").get() as any;
    const bulletinCount = db.prepare("SELECT COUNT(*) as count FROM bulletin").get() as any;

    console.log(`\n  AgentNexus Status`);
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
    console.log("  AgentNexus database cleared. All messages and registrations removed.");
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
