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

const AGENTS_MD_CONTENT = `
## ClaudeLink - Multi-Agent Coordination

You are part of a multi-agent team. Other agents (Codex CLI, Claude Code, Gemini CLI, or other MCP-compatible clients) may be running in separate terminals — and possibly on other machines on the local network — and can send you messages at any time via ClaudeLink.

### Inbox discipline

- **Before** starting any task: call \`read_inbox\` to check for messages
- **After** completing any task: call \`read_inbox\` again — new mail may have arrived while you were working
- If a message asks you to change course, do so immediately
- If a message is a question from another agent, reply via \`send\` before continuing your own work
- High-priority messages take precedence

### Proactive collaboration

- When you finish work another agent might care about, call \`send\` to tell them
- If you hit a problem another agent's role could help with, call \`send\` to ask
- For decisions that affect the project, call \`post_bulletin\`
- If you're blocked, say so and check inbox again

### Communication shortcuts

- "check messages" — call \`read_inbox\`
- "ask the [role]" — call \`send\` to that role and check inbox for the reply
- "tell the [role]" — call \`send\` (one-way)
- "who's online" — call \`get_agents\`
- "update the board" — call \`post_bulletin\`
- "check the board" — call \`get_bulletin\`
`.trim();

const AGENTS_MD_MARKER = "## ClaudeLink - Multi-Agent Coordination";

type Client = "claude" | "codex" | "gemini";

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

function installAgentsMd(scope: "global" | "project") {
  let agentsMdPath: string;

  if (scope === "global") {
    const codexDir = path.join(os.homedir(), ".codex");
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }
    agentsMdPath = path.join(codexDir, "AGENTS.md");
  } else {
    agentsMdPath = path.join(process.cwd(), "AGENTS.md");
  }

  if (fs.existsSync(agentsMdPath)) {
    const existing = fs.readFileSync(agentsMdPath, "utf-8");
    if (existing.includes(AGENTS_MD_MARKER)) {
      console.log(`  AGENTS.md already has ClaudeLink instructions (${agentsMdPath})`);
      return;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(agentsMdPath, existing + separator + AGENTS_MD_CONTENT + "\n");
    console.log(`  Added ClaudeLink instructions to existing ${agentsMdPath}`);
  } else {
    const header = scope === "global" ? "# Global Codex Instructions\n\n" : "# Project Agent Instructions\n\n";
    fs.writeFileSync(agentsMdPath, header + AGENTS_MD_CONTENT + "\n");
    console.log(`  Created ${agentsMdPath} with ClaudeLink instructions`);
  }
}

function addCodexMcp(scope: "global" | "project"): boolean {
  if (scope === "global") {
    const { execSync } = require("child_process");
    try {
      execSync("codex mcp add claudelink -- claudelink-server", { stdio: "inherit" });
      return true;
    } catch {
      console.log(`
  Could not run "codex mcp add" automatically (is Codex CLI installed and on PATH?).

  Add this block to ~/.codex/config.toml manually (create the file if needed):

    [mcp_servers.claudelink]
    command = "claudelink-server"
      `);
      return false;
    }
  } else {
    console.log(`
  For Codex CLI, add this to ~/.codex/config.toml (or .codex/config.toml in
  this project for project-scoped config — Codex requires the project to be
  trusted for project scope):

    [mcp_servers.claudelink]
    command = "claudelink-server"

  Or run:
    codex mcp add claudelink -- claudelink-server
    `);
    return true;
  }
}

function installGeminiMd(scope: "global" | "project") {
  let geminiMdPath: string;

  if (scope === "global") {
    const geminiDir = path.join(os.homedir(), ".gemini");
    if (!fs.existsSync(geminiDir)) {
      fs.mkdirSync(geminiDir, { recursive: true });
    }
    geminiMdPath = path.join(geminiDir, "GEMINI.md");
  } else {
    geminiMdPath = path.join(process.cwd(), "GEMINI.md");
  }

  if (fs.existsSync(geminiMdPath)) {
    const existing = fs.readFileSync(geminiMdPath, "utf-8");
    if (existing.includes(AGENTS_MD_MARKER)) {
      console.log(`  GEMINI.md already has ClaudeLink instructions (${geminiMdPath})`);
      return;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(geminiMdPath, existing + separator + AGENTS_MD_CONTENT + "\n");
    console.log(`  Added ClaudeLink instructions to existing ${geminiMdPath}`);
  } else {
    const header = scope === "global" ? "# Global Gemini Instructions\n\n" : "# Project Agent Instructions\n\n";
    fs.writeFileSync(geminiMdPath, header + AGENTS_MD_CONTENT + "\n");
    console.log(`  Created ${geminiMdPath} with ClaudeLink instructions`);
  }
}

function addGeminiMcp(scope: "global" | "project"): boolean {
  let geminiDir: string;
  if (scope === "global") {
    geminiDir = path.join(os.homedir(), ".gemini");
  } else {
    geminiDir = path.join(process.cwd(), ".gemini");
  }
  if (!fs.existsSync(geminiDir)) {
    fs.mkdirSync(geminiDir, { recursive: true });
  }
  const settingsPath = path.join(geminiDir, "settings.json");

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      console.log(`  Warning: could not parse ${settingsPath} — leaving file alone, paste this manually:`);
      console.log(`    "mcpServers": { "claudelink": { "command": "claudelink-server" } }`);
      return false;
    }
  }
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers["claudelink"] = { command: "claudelink-server" };

  const tmp = settingsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, settingsPath);
  console.log(`  Updated ${settingsPath} (added mcpServers.claudelink)`);
  return true;
}

function printBanner() {
  console.log(`
    ╔═══════════════════════════════════════════╗
    ║            C L A U D E  L I N K           ║
    ║   The hub where your AI agents connect.   ║
    ╚═══════════════════════════════════════════╝
  `);
}

function initProject(clients: Client[]) {
  const cwd = process.cwd();
  const mcpJsonPath = path.join(cwd, ".mcp.json");

  // Create ~/.claudelink directory (always)
  if (!fs.existsSync(NEXUS_DIR)) {
    fs.mkdirSync(NEXUS_DIR, { recursive: true });
    console.log(`  Created ${NEXUS_DIR}/`);
  }

  if (clients.includes("claude")) {
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

    mcpConfig.mcpServers["claudelink"] = MCP_SERVER_CONFIG;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`  Updated ${mcpJsonPath}`);

    installClaudeMd("project");
  }

  if (clients.includes("codex")) {
    addCodexMcp("project");
    installAgentsMd("project");
  }

  if (clients.includes("gemini")) {
    addGeminiMcp("project");
    installGeminiMd("project");
  }

  const lines: string[] = ["", "  ClaudeLink is ready!", "", "  What was set up:"];
  if (clients.includes("claude")) {
    lines.push("    - .mcp.json: MCP server config for Claude Code");
    lines.push("    - CLAUDE.md: autonomous-mode instructions for Claude Code");
  }
  if (clients.includes("codex")) {
    lines.push("    - AGENTS.md: multi-agent instructions for Codex CLI");
    lines.push("    - Codex MCP config snippet printed above");
  }
  if (clients.includes("gemini")) {
    lines.push("    - .gemini/settings.json: MCP server config for Gemini CLI");
    lines.push("    - GEMINI.md: multi-agent instructions for Gemini CLI");
  }
  lines.push("");
  lines.push("  Next steps:");
  if (clients.includes("claude")) {
    lines.push("    - Restart Claude Code in your terminals; tell it 'register as a developer'");
  }
  if (clients.includes("codex")) {
    lines.push("    - Restart Codex CLI in your terminals; it will pick up AGENTS.md and the MCP server");
  }
  if (clients.includes("gemini")) {
    lines.push("    - Restart Gemini CLI in your terminals; it will pick up GEMINI.md and the MCP server");
  }
  lines.push("");
  lines.push(`  Data stored in: ${NEXUS_DIR}/nexus.db`);
  console.log(lines.join("\n") + "\n");
}

function initGlobal(clients: Client[]) {
  // Create ~/.claudelink directory (always)
  if (!fs.existsSync(NEXUS_DIR)) {
    fs.mkdirSync(NEXUS_DIR, { recursive: true });
    console.log(`  Created ${NEXUS_DIR}/`);
  }

  let claudeMcpOk = false;
  let codexMcpOk = false;

  if (clients.includes("claude")) {
    const { execSync } = require("child_process");
    try {
      execSync("claude mcp add --scope user claudelink -- claudelink-server", {
        stdio: "inherit",
      });
      claudeMcpOk = true;
    } catch {
      console.log(`
  Could not run "claude mcp add" automatically.

  Run this command manually to add ClaudeLink globally for Claude Code:

    claude mcp add --scope user claudelink -- claudelink-server
      `);
    }
    installClaudeMd("global");
  }

  if (clients.includes("codex")) {
    codexMcpOk = addCodexMcp("global");
    installAgentsMd("global");
  }

  let geminiMcpOk = false;
  if (clients.includes("gemini")) {
    geminiMcpOk = addGeminiMcp("global");
    installGeminiMd("global");
  }

  const lines: string[] = ["", "  ClaudeLink is ready (global install)!", "", "  What was set up:"];
  if (clients.includes("claude")) {
    lines.push(`    - Claude Code MCP: ${claudeMcpOk ? "registered globally" : "manual step printed above"}`);
    lines.push("    - ~/.claude/CLAUDE.md: autonomous-mode instructions");
  }
  if (clients.includes("codex")) {
    lines.push(`    - Codex CLI MCP: ${codexMcpOk ? "registered globally" : "manual step printed above"}`);
    lines.push("    - ~/.codex/AGENTS.md: multi-agent instructions");
  }
  if (clients.includes("gemini")) {
    lines.push(`    - Gemini CLI MCP: ${geminiMcpOk ? "registered globally in ~/.gemini/settings.json" : "manual step printed above"}`);
    lines.push("    - ~/.gemini/GEMINI.md: multi-agent instructions");
  }
  lines.push("");
  lines.push(`  Data stored in: ${NEXUS_DIR}/nexus.db`);
  console.log(lines.join("\n") + "\n");
}

function showHelp() {
  console.log(`
  Usage: claudelink <command>

  Commands:
    init [client flags]        Set up ClaudeLink in this project for one or more clients
    init --global [...]        Same, but install globally for the chosen clients

  Client flags (combine as needed; default is --claude):
    --claude                   Claude Code (.mcp.json + CLAUDE.md)
    --codex                    OpenAI Codex CLI (~/.codex/config.toml + AGENTS.md)
    --gemini                   Google Gemini CLI (~/.gemini/settings.json + GEMINI.md)
    --both                     Shortcut for --claude --codex
    --all                      Shortcut for --claude --codex --gemini

  Examples:
    claudelink init                       Claude Code in current project
    claudelink init --gemini              Gemini CLI in current project
    claudelink init --codex --gemini      Codex + Gemini in current project
    claudelink init --all --global        All three clients, globally

    status                     Show registered agents and their status
    ui                         Launch the Command Center UI in your browser
    ui --stop                  Stop the Command Center UI
    install-hooks              Install Stop + UserPromptSubmit hooks for autonomous replies (project)
    install-hooks --global     Install hooks in ~/.claude/settings.json (all projects)
    install-hooks --uninstall  Remove ClaudeLink hooks from the chosen scope
    reset                      Clear all messages and agent registrations
    help                       Show this help message
  `);
}

// --- Hook installation (Path A) ---------------------------------------------
// Idempotently installs the Stop + UserPromptSubmit hooks into the appropriate
// settings.json. Never clobbers existing hook entries: we look for our
// command name and skip if already present. The two hook scripts are
// installed by npm into the same bin directory as `claudelink` itself, so
// resolving an absolute path lets the install survive even if the user's
// shell PATH is different from Claude Code's spawned-process PATH.

const STOP_HOOK_BIN = "claudelink-stop-hook";
const PROMPT_HOOK_BIN = "claudelink-prompt-hook";

function resolveHookCommand(name: string): string {
  // Prefer absolute path next to this CLI binary (works regardless of PATH).
  // Falls back to bare name if we can't locate ourselves.
  const candidates = [
    path.join(path.dirname(process.argv[1] || ""), name),
    path.join(__dirname, "..", "bin", name + ".js"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return name;
}

function settingsPath(scope: "global" | "project"): string {
  return scope === "global"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.cwd(), ".claude", "settings.json");
}

function readSettings(p: string): any {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e: any) {
    throw new Error(
      `Could not parse ${p}: ${e.message}. Refusing to overwrite — fix the JSON manually and rerun.`
    );
  }
}

function writeSettingsAtomic(p: string, settings: any): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function hookEntryExists(settings: any, event: string, binName: string): boolean {
  const events = settings?.hooks?.[event];
  if (!Array.isArray(events)) return false;
  for (const group of events) {
    const groupHooks = group?.hooks;
    if (!Array.isArray(groupHooks)) continue;
    for (const h of groupHooks) {
      if (typeof h?.command === "string" && h.command.endsWith(binName)) {
        return true;
      }
    }
  }
  return false;
}

function appendHookEntry(
  settings: any,
  event: string,
  command: string,
  timeout: number
): void {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  settings.hooks[event].push({
    matcher: "",
    hooks: [{ type: "command", command, timeout }],
  });
}

function removeHookEntries(settings: any, event: string, binName: string): number {
  if (!Array.isArray(settings?.hooks?.[event])) return 0;
  let removed = 0;
  const filtered: any[] = [];
  for (const group of settings.hooks[event]) {
    const remaining = (group?.hooks || []).filter(
      (h: any) => !(typeof h?.command === "string" && h.command.endsWith(binName))
    );
    if (remaining.length !== (group?.hooks || []).length) {
      removed += (group?.hooks?.length || 0) - remaining.length;
    }
    if (remaining.length > 0) {
      filtered.push({ ...group, hooks: remaining });
    }
  }
  settings.hooks[event] = filtered;
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
  return removed;
}

function installHooks(scope: "global" | "project", uninstall: boolean): void {
  const p = settingsPath(scope);
  let settings: any;
  try {
    settings = readSettings(p);
  } catch (e: any) {
    console.log(`  ${e.message}`);
    return;
  }

  const stopCmd = resolveHookCommand(STOP_HOOK_BIN);
  const promptCmd = resolveHookCommand(PROMPT_HOOK_BIN);

  if (uninstall) {
    const stopRemoved = removeHookEntries(settings, "Stop", STOP_HOOK_BIN);
    const promptRemoved = removeHookEntries(settings, "UserPromptSubmit", PROMPT_HOOK_BIN);
    if (stopRemoved + promptRemoved === 0) {
      console.log(`  No ClaudeLink hooks found in ${p}. Nothing to remove.`);
      return;
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeSettingsAtomic(p, settings);
    console.log(
      `  Removed ${stopRemoved} Stop hook(s) and ${promptRemoved} UserPromptSubmit hook(s) from ${p}.`
    );
    return;
  }

  let stopAction: "added" | "skipped";
  let promptAction: "added" | "skipped";

  if (hookEntryExists(settings, "Stop", STOP_HOOK_BIN)) {
    stopAction = "skipped";
  } else {
    appendHookEntry(settings, "Stop", stopCmd, 10);
    stopAction = "added";
  }

  if (hookEntryExists(settings, "UserPromptSubmit", PROMPT_HOOK_BIN)) {
    promptAction = "skipped";
  } else {
    appendHookEntry(settings, "UserPromptSubmit", promptCmd, 5);
    promptAction = "added";
  }

  if (stopAction === "skipped" && promptAction === "skipped") {
    console.log(`  ClaudeLink hooks already installed in ${p}. Nothing to do.`);
    return;
  }

  writeSettingsAtomic(p, settings);
  console.log(`  Updated ${p}:`);
  console.log(`    Stop hook:              ${stopAction} (${stopCmd})`);
  console.log(`    UserPromptSubmit hook:  ${promptAction} (${promptCmd})`);
  console.log(`
  Restart Claude Code in any terminal where you want autonomous replies
  active. The hooks fire on Stop (when an agent finishes a turn) and
  UserPromptSubmit (resets the per-terminal auto-fire counter).

  Tunable env vars:
    CLAUDELINK_HARD_CAP=5    consecutive auto-fires per terminal
    CLAUDELINK_COOLDOWN_S=30 seconds between fires
    CLAUDELINK_CHAIN_CAP=8   parent_id chain depth before excluding msg
    CLAUDELINK_HOOK_STRICT=1 surface hook errors to stderr (dev mode)

  Audit log: ~/.claudelink/auto-fire.log
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
  case "init": {
    const isGlobal = args.includes("--global");
    const wantAll = args.includes("--all");
    const wantBoth = args.includes("--both");
    const wantClaude = args.includes("--claude");
    const wantCodex = args.includes("--codex");
    const wantGemini = args.includes("--gemini");

    let clients: Client[];
    if (wantAll) {
      clients = ["claude", "codex", "gemini"];
    } else if (wantBoth) {
      clients = ["claude", "codex"];
    } else {
      const explicit = [
        wantClaude ? "claude" : null,
        wantCodex ? "codex" : null,
        wantGemini ? "gemini" : null,
      ].filter(Boolean) as Client[];
      clients = explicit.length > 0 ? explicit : ["claude"];
    }

    if (isGlobal) {
      initGlobal(clients);
    } else {
      initProject(clients);
    }
    break;
  }
  case "status":
    showStatus();
    break;
  case "ui":
    uiCommand(args.includes("--stop") || args.includes("stop"));
    break;
  case "install-hooks":
    installHooks(
      args.includes("--global") ? "global" : "project",
      args.includes("--uninstall")
    );
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
