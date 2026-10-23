// Per-agent "fixed cost per turn": what each live agent re-sends on EVERY turn
// before the conversation itself — its instruction files, its auto-memory
// index, and the MCP servers whose tools it carries — plus which models its
// current session actually ran on.
//
// Why this exists: history dominates a long session's re-read cost, but these
// items ride every single turn, and nothing else reports them. The motivating
// case was a memory index past Claude Code's load limit, silently dropping
// entries every session with no warning anywhere.
//
// Load rules follow Claude Code's documented behavior (code.claude.com/docs,
// "How Claude remembers your project"):
//   - CLAUDE.md and CLAUDE.local.md load from the working directory and every
//     directory above it, plus ~/.claude/CLAUDE.md and unscoped rules files.
//     Target: under 200 lines per file.
//   - Auto memory: only the first 200 lines or 25KB of MEMORY.md load.
// @imports are NOT expanded here, so instruction totals are a floor.
//
// Read-only. Never writes a file. Only file names, sizes and counts leave this
// module — no file contents, and no MCP server config (which can hold secrets).

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { projectIdFromCwd, PROJECTS_DIR } from "./usage-reader.js";

export const CLAUDE_MD_LINE_TARGET = 200;
export const MEMORY_LINE_LIMIT = 200;
export const MEMORY_BYTE_LIMIT = 25_000;
const NEAR = 0.8;

export interface InstructionFile {
  path: string;
  bytes: number;
  lines: number;
  overLineTarget: boolean;
}

export interface MemoryIndex {
  path: string;
  bytes: number;
  lines: number;
  truncated: boolean; // part of the file is NOT loaded at session start
  nearLimit: boolean;
}

export interface AgentOverhead {
  role: string;
  cwd: string | null;
  instructions: { files: InstructionFile[]; totalBytes: number; approxTokens: number };
  memory: MemoryIndex | null;
  mcp: { configured: string[]; calledThisSession: string[]; notCalledThisSession: string[] };
  plugins: string[];
  modelMix: Record<string, number>; // assistant turns per model, current session
}

function stat(file: string): { bytes: number; lines: number } | null {
  try {
    const buf = fs.readFileSync(file);
    let lines = 0;
    for (const b of buf) if (b === 10) lines++;
    if (buf.length > 0 && buf[buf.length - 1] !== 10) lines++;
    return { bytes: buf.length, lines };
  } catch {
    return null;
  }
}

// Rules files load at launch unless their frontmatter scopes them with
// `paths:`, in which case they load only when matching files are touched.
function isPathScoped(file: string): boolean {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 2000);
    if (!head.startsWith("---")) return false;
    const end = head.indexOf("\n---", 3);
    const fm = end > 0 ? head.slice(3, end) : "";
    return /^\s*paths\s*:/m.test(fm);
  } catch {
    return false;
  }
}

function rulesFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md") && !isPathScoped(full)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

// Exported for testability.
export function instructionFilesFor(cwd: string, home: string = os.homedir()): InstructionFile[] {
  const candidates: string[] = [path.join(home, ".claude", "CLAUDE.md"), ...rulesFiles(path.join(home, ".claude", "rules"))];
  // Root → cwd, matching the order Claude Code concatenates them in.
  const chain: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    chain.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of chain) {
    candidates.push(path.join(d, "CLAUDE.md"), path.join(d, ".claude", "CLAUDE.md"), path.join(d, "CLAUDE.local.md"));
  }
  candidates.push(...rulesFiles(path.join(path.resolve(cwd), ".claude", "rules")));

  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const c of candidates) {
    const key = path.resolve(c);
    if (seen.has(key)) continue;
    seen.add(key);
    const s = stat(key);
    if (!s) continue;
    files.push({ path: key, bytes: s.bytes, lines: s.lines, overLineTarget: s.lines > CLAUDE_MD_LINE_TARGET });
  }
  return files;
}

// Exported for testability.
export function memoryIndexStats(file: string): MemoryIndex | null {
  const s = stat(file);
  if (!s) return null;
  return {
    path: file,
    bytes: s.bytes,
    lines: s.lines,
    truncated: s.lines > MEMORY_LINE_LIMIT || s.bytes > MEMORY_BYTE_LIMIT,
    nearLimit: s.lines > MEMORY_LINE_LIMIT * NEAR || s.bytes > MEMORY_BYTE_LIMIT * NEAR,
  };
}

// Auto memory is per repository, so a terminal started in a subdirectory may
// use an ancestor's memory dir. Take the nearest one that exists.
function memoryIndexFor(cwd: string, projectsDir: string): MemoryIndex | null {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const idx = memoryIndexStats(path.join(projectsDir, projectIdFromCwd(d), "memory", "MEMORY.md"));
    if (idx) return idx;
    if (path.dirname(d) === d) return null;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Exported for testability. Server NAMES only — configs can carry secrets.
export function configuredMcpServers(cwd: string, claudeJsonPath: string): string[] {
  const names = new Set<string>();
  const add = (obj: any) => {
    if (obj && typeof obj === "object") for (const k of Object.keys(obj)) names.add(k);
  };
  const cj = readJson(claudeJsonPath);
  add(cj?.mcpServers); // user scope
  add(cj?.projects?.[path.resolve(cwd)]?.mcpServers); // local scope
  add(readJson(path.join(cwd, ".mcp.json"))?.mcpServers); // project scope
  return [...names].sort();
}

function enabledPlugins(settingsPath: string): string[] {
  const ep = readJson(settingsPath)?.enabledPlugins;
  if (!ep || typeof ep !== "object") return [];
  return Object.entries(ep)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort();
}

// Incremental transcript scan: remember how far each file has been read so a
// multi-hundred-MB session is only parsed once, then just its new tail.
interface ScanState {
  offset: number;
  mcpCalled: Set<string>;
  modelMix: Record<string, number>;
}
const scanCache = new Map<string, ScanState>();

// Exported for testability.
export async function scanTranscript(file: string): Promise<{ mcpCalled: string[]; modelMix: Record<string, number> }> {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { mcpCalled: [], modelMix: {} };
  }
  let st = scanCache.get(file);
  if (!st || size < st.offset) st = { offset: 0, mcpCalled: new Set(), modelMix: {} };
  if (size > st.offset) {
    // If the file doesn't end in a newline, its last line is still being
    // written: leave it unparsed and unconsumed so the next scan reads it whole.
    let endsWithNewline = true;
    try {
      const fd = fs.openSync(file, "r");
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      endsWithNewline = b[0] === 10;
    } catch {
      /* treat as complete */
    }
    const state = st;
    const handle = (line: string) => {
      if (!line.includes('"assistant"')) return;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      const msg = rec?.message;
      if (rec?.type !== "assistant" || !msg) return;
      if (msg.model && msg.model !== "<synthetic>") state.modelMix[msg.model] = (state.modelMix[msg.model] || 0) + 1;
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c?.type === "tool_use" && typeof c.name === "string" && c.name.startsWith("mcp__")) {
            const server = c.name.split("__")[1];
            if (server) state.mcpCalled.add(server);
          }
        }
      }
    };
    const stream = fs.createReadStream(file, { start: st.offset, end: size - 1, encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let consumed = 0;
    let prev: string | null = null;
    for await (const line of rl) {
      if (prev !== null) {
        handle(prev);
        consumed += Buffer.byteLength(prev, "utf8") + 1;
      }
      prev = line;
    }
    if (prev !== null && endsWithNewline) {
      handle(prev);
      consumed += Buffer.byteLength(prev, "utf8") + 1;
    }
    st.offset += consumed;
    scanCache.set(file, st);
  }
  return { mcpCalled: [...st.mcpCalled].sort(), modelMix: { ...st.modelMix } };
}

export async function readAgentOverhead(
  agent: { role: string; cwd: string | null; transcriptPath: string | null },
  opts: { home?: string; projectsDir?: string; claudeJsonPath?: string; settingsPath?: string } = {}
): Promise<AgentOverhead> {
  const home = opts.home ?? os.homedir();
  const projectsDir = opts.projectsDir ?? PROJECTS_DIR;
  const claudeJson = opts.claudeJsonPath ?? path.join(home, ".claude.json");
  const settings = opts.settingsPath ?? path.join(home, ".claude", "settings.json");

  const files = agent.cwd ? instructionFilesFor(agent.cwd, home) : [];
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const configured = agent.cwd ? configuredMcpServers(agent.cwd, claudeJson) : [];
  const scan = agent.transcriptPath ? await scanTranscript(agent.transcriptPath) : { mcpCalled: [], modelMix: {} };
  const called = new Set(scan.mcpCalled);
  return {
    role: agent.role,
    cwd: agent.cwd,
    instructions: { files, totalBytes, approxTokens: Math.round(totalBytes / 4) },
    memory: agent.cwd ? memoryIndexFor(agent.cwd, projectsDir) : null,
    mcp: {
      configured,
      calledThisSession: scan.mcpCalled,
      notCalledThisSession: configured.filter((n) => !called.has(n)),
    },
    plugins: enabledPlugins(settings),
    modelMix: scan.modelMix,
  };
}
