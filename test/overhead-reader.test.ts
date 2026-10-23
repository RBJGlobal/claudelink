// Pins the per-turn overhead reader against Claude Code's documented load
// rules: CLAUDE.md / CLAUDE.local.md from the working directory and every
// ancestor plus ~/.claude, unscoped rules files, and the MEMORY.md limit of the
// first 200 lines or 25KB. Also pins that only names/sizes come out.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  instructionFilesFor,
  memoryIndexStats,
  configuredMcpServers,
  scanTranscript,
  readAgentOverhead,
} from "../src/overhead-reader.js";
import { projectIdFromCwd } from "../src/usage-reader.js";

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-overhead-")));
}
function write(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => "line " + i).join("\n") + "\n";

test("instruction files: home, every ancestor, CLAUDE.local.md, unscoped rules only", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const proj = path.join(root, "work", "proj");
  write(path.join(home, ".claude", "CLAUDE.md"), "global\n");
  write(path.join(home, ".claude", "rules", "style.md"), "always\n");
  write(path.join(root, "work", "CLAUDE.md"), "parent\n");
  write(path.join(proj, "CLAUDE.md"), lines(250));
  write(path.join(proj, "CLAUDE.local.md"), "mine\n");
  write(path.join(proj, ".claude", "rules", "ts.md"), "---\npaths: ['**/*.ts']\n---\nscoped\n");
  write(path.join(proj, ".claude", "rules", "general.md"), "unscoped\n");
  write(path.join(proj, "sub", "CLAUDE.md"), "subdir loads on demand, not at launch\n");

  const files = instructionFilesFor(proj, home).map((f) => path.relative(root, f.path));
  assert.deepEqual(files.sort(), [
    "home/.claude/CLAUDE.md",
    "home/.claude/rules/style.md",
    "work/CLAUDE.md",
    "work/proj/.claude/rules/general.md",
    "work/proj/CLAUDE.local.md",
    "work/proj/CLAUDE.md",
  ]);
  const big = instructionFilesFor(proj, home).find((f) => f.path.endsWith(path.join("proj", "CLAUDE.md")))!;
  assert.equal(big.lines, 250);
  assert.equal(big.overLineTarget, true);
});

test("memory index: truncated past 200 lines or 25KB, near-limit at 80%", () => {
  const root = tmp();
  const f = path.join(root, "MEMORY.md");
  write(f, lines(100));
  assert.deepEqual([memoryIndexStats(f)!.truncated, memoryIndexStats(f)!.nearLimit], [false, false]);
  write(f, lines(170));
  assert.deepEqual([memoryIndexStats(f)!.truncated, memoryIndexStats(f)!.nearLimit], [false, true]);
  write(f, lines(201));
  assert.equal(memoryIndexStats(f)!.truncated, true);
  // Few lines but over 25KB (the real failure seen in the fleet: 26.1KB).
  write(f, "x".repeat(26_100) + "\n");
  assert.equal(memoryIndexStats(f)!.truncated, true);
  assert.equal(memoryIndexStats(path.join(root, "missing.md")), null);
});

test("MCP servers: user, local and project scopes by name only", () => {
  const root = tmp();
  const proj = path.join(root, "proj");
  const cj = path.join(root, ".claude.json");
  write(
    cj,
    JSON.stringify({
      mcpServers: { claudelink: { command: "x", env: { SECRET: "nope" } } },
      projects: { [proj]: { mcpServers: { localone: {} } } },
    })
  );
  write(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { projone: {} } }));
  assert.deepEqual(configuredMcpServers(proj, cj), ["claudelink", "localone", "projone"]);
});

test("transcript scan: model mix and MCP servers called, incremental across appends", async () => {
  const root = tmp();
  const t = path.join(root, "s.jsonl");
  const asst = (model: string, tool?: string) =>
    JSON.stringify({
      type: "assistant",
      message: { model, content: tool ? [{ type: "tool_use", name: tool, input: {} }] : [{ type: "text", text: "hi" }] },
    }) + "\n";
  write(t, asst("claude-opus-5", "mcp__claudelink__send") + asst("claude-opus-5") + JSON.stringify({ type: "user" }) + "\n");
  let r = await scanTranscript(t);
  assert.deepEqual(r.modelMix, { "claude-opus-5": 2 });
  assert.deepEqual(r.mcpCalled, ["claudelink"]);

  // Append, including a partial last line still being written.
  const partial = asst("claude-sonnet-5-5");
  fs.appendFileSync(t, asst("claude-sonnet-5-5", "mcp__plugin_playwright_playwright__browser_click") + partial.slice(0, 20));
  r = await scanTranscript(t);
  assert.deepEqual(r.modelMix, { "claude-opus-5": 2, "claude-sonnet-5-5": 1 });
  assert.deepEqual(r.mcpCalled, ["claudelink", "plugin_playwright_playwright"]);

  // The partial line, once completed, is counted exactly once.
  fs.appendFileSync(t, partial.slice(20));
  r = await scanTranscript(t);
  assert.deepEqual(r.modelMix, { "claude-opus-5": 2, "claude-sonnet-5-5": 2 });
});

test("readAgentOverhead assembles everything and finds an ancestor's memory dir", async () => {
  const root = tmp();
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const sub = path.join(repo, "pkg");
  const projectsDir = path.join(home, ".claude", "projects");
  write(path.join(repo, "CLAUDE.md"), lines(10));
  write(path.join(projectsDir, projectIdFromCwd(repo), "memory", "MEMORY.md"), lines(300));
  const cj = path.join(home, ".claude.json");
  write(cj, JSON.stringify({ mcpServers: { claudelink: {}, unused: {} } }));
  const t = path.join(root, "t.jsonl");
  write(t, JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [{ type: "tool_use", name: "mcp__claudelink__read_inbox" }] } }) + "\n");

  const o = await readAgentOverhead(
    { role: "Tester", cwd: sub, transcriptPath: t },
    { home, projectsDir, claudeJsonPath: cj, settingsPath: path.join(home, "none.json") }
  );
  assert.equal(o.instructions.files.length, 1);
  assert.equal(o.memory!.truncated, true);
  assert.deepEqual(o.mcp.notCalledThisSession, ["unused"]);
  assert.deepEqual(o.modelMix, { "claude-opus-5": 1 });
  // Nothing but names, sizes and counts: no config values leak.
  assert.ok(!JSON.stringify(o).includes("command"));
});
