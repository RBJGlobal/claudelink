// Fleet token meter — reads each registered agent's LOCAL Claude Code session
// transcripts and aggregates real token usage per project / per model / per day.
//
// Why this is possible: Claude Code writes one JSONL transcript per session at
//   ~/.claude/projects/<project-id>/<session-uuid>.jsonl
// and every assistant message line carries a `message.usage` block with real
// token counts (input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens) plus `message.model` and a top-level `timestamp`.
// We parse those to surface where the weekly burn goes. This is READ-ONLY: we
// never write to the transcripts and never touch terminals.
//
// What we CAN'T see: the Max-plan weekly quota CEILING is server-side at
// Anthropic with no local API. We report consumption + breakdown + trend, not
// "% of quota". Cost is an ESTIMATE from per-model price constants below.
//
// Attribution model (honest about its limits):
//   - project-id is derived deterministically from an agent's working dir
//     (cwd), which we read live via `lsof` on the registered claudelink-server
//     pid. cwd is stable for a process's lifetime, so we memoize it.
//   - When exactly one registered agent maps to a project dir, we label that
//     project with the agent's role (clean 1:1).
//   - When several agents share a project dir (e.g. a fleet all launched in the
//     same repo), we can't reliably attribute a transcript SESSION to a
//     specific agent — there is no stored agent->sessionId key today — so we
//     report the project as a GROUP and list the roles. Per-agent split within
//     a shared project is a fast-follow that needs register-time sessionId
//     capture (schema v3).

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execFileSync } from "child_process";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Per-million-token price ESTIMATES (USD). Clearly approximate — edit here or
// surface as user-editable later. Cost is a secondary signal; raw tokens are
// the ground truth. Cache reads are heavily discounted; cache writes cost a
// premium over fresh input.
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const PRICES: Record<string, ModelPrice> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};
function priceFor(model: string): ModelPrice {
  const m = model.toLowerCase();
  if (m.includes("opus")) return PRICES.opus;
  if (m.includes("haiku")) return PRICES.haiku;
  // Unknown / sonnet → sonnet-tier as a neutral, clearly-labeled fallback.
  return PRICES.sonnet;
}

export interface TokenBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  estCostUsd: number;
}
export interface ProjectUsage {
  projectId: string;
  cwd: string;
  label: string; // role (1:1) or "repo (N agents)"
  agentRoles: string[];
  sessions: number;
  totals: TokenBucket;
  perModel: Record<string, TokenBucket>;
}
export interface PerDayPoint {
  date: string; // YYYY-MM-DD (local)
  totalTokens: number;
  estCostUsd: number;
}
export interface FleetUsage {
  generatedAt: string;
  windowDays: number;
  scannedProjects: number;
  skippedNoCwd: string[]; // agent roles we couldn't map to a project dir
  fleet: {
    totals: TokenBucket;
    perModel: Record<string, TokenBucket>;
    perDay: PerDayPoint[];
  };
  projects: ProjectUsage[];
}

// Minimal shape of a registered agent the reader needs. Caller passes live
// agents (alive === true) only — we never scan a project with no live agent,
// which is the privacy guardrail: we read FLEET transcripts, not the user's
// entire ~/.claude history.
export interface AgentRef {
  role: string;
  pid: number;
}

function emptyBucket(): TokenBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, totalTokens: 0, estCostUsd: 0 };
}

function addUsage(b: TokenBucket, model: string, u: any): void {
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheCreation = Number(u.cache_creation_input_tokens) || 0;
  b.input += input;
  b.output += output;
  b.cacheRead += cacheRead;
  b.cacheCreation += cacheCreation;
  b.totalTokens += input + output + cacheRead + cacheCreation;
  const p = priceFor(model);
  b.estCostUsd +=
    (input * p.input +
      output * p.output +
      cacheRead * p.cacheRead +
      cacheCreation * p.cacheWrite) /
    1_000_000;
}

// cwd of a pid, via lsof. Memoized for the process lifetime — cwd never
// changes for a running process, and lsof is comparatively slow.
const cwdCache = new Map<number, string | null>();
export function cwdForPid(pid: number): string | null {
  if (cwdCache.has(pid)) return cwdCache.get(pid)!;
  let cwd: string | null = null;
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    if (line) cwd = line.slice(1).trim();
  } catch {
    cwd = null;
  }
  cwdCache.set(pid, cwd);
  return cwd;
}

// Claude Code encodes a project's cwd into its transcript dir name by replacing
// every non-alphanumeric character with a dash. Verified against the live
// fleet (spaces and slashes both map to '-'). We derive the name AND confirm
// the dir exists before trusting it.
export function projectIdFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Opus cache-read list price (USD per million tokens). The context-hygiene
// projection values "excess" re-read tokens at this rate. Labeled as an
// estimate wherever surfaced.
export const OPUS_CACHE_READ_PER_MTOK = PRICES.opus.cacheRead;

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Scan one transcript file, accumulating usage into the project buckets and the
// fleet per-day map. Streams line-by-line so a multi-hundred-MB transcript
// never lands in memory at once. Only lines within [windowStart, now] count.
async function scanTranscript(
  file: string,
  windowStartMs: number,
  proj: ProjectUsage,
  perDay: Map<string, { totalTokens: number; estCostUsd: number }>,
  seen: Set<string>
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Cheap pre-filter: skip lines that obviously can't carry usage.
    if (line.indexOf('"usage"') === -1) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o?.message;
    const u = msg?.usage;
    if (!u || !msg?.model) continue;
    const model: string = msg.model;
    // Claude Code tags synthetic assistant turns (injected context, hook
    // output) with model "<synthetic>" — no real API call, no billing. Skip so
    // they don't clutter the per-model breakdown.
    if (model === "<synthetic>") continue;
    // Fork/resume dedupe: when a session is resumed or forked, Claude Code can
    // re-emit the same assistant message (same message.id + requestId) in a new
    // transcript. Counting both double-counts — and because the re-emit carries
    // the cached context, the inflation lands almost entirely in cache_read.
    // Dedupe on the same key ccusage uses. Lines lacking both ids are counted.
    if (msg.id && o.requestId) {
      const key = msg.id + "::" + o.requestId;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const ts = Date.parse(o.timestamp || "");
    if (!Number.isFinite(ts) || ts < windowStartMs) continue;

    addUsage(proj.totals, model, u);
    if (!proj.perModel[model]) proj.perModel[model] = emptyBucket();
    addUsage(proj.perModel[model], model, u);

    // Fleet per-day trend (across all projects). Tallied separately from the
    // project buckets so a zero-filled dense series is easy to emit later.
    const day = localDate(ts);
    const slot = perDay.get(day) || { totalTokens: 0, estCostUsd: 0 };
    const input = Number(u.input_tokens) || 0;
    const output = Number(u.output_tokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    const cacheCreation = Number(u.cache_creation_input_tokens) || 0;
    const p = priceFor(model);
    slot.totalTokens += input + output + cacheRead + cacheCreation;
    slot.estCostUsd +=
      (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheCreation * p.cacheWrite) /
      1_000_000;
    perDay.set(day, slot);
  }
}

export async function readFleetUsage(
  agents: AgentRef[],
  windowDays: number = 7
): Promise<FleetUsage> {
  const now = Date.now();
  const windowStartMs = now - windowDays * 24 * 60 * 60 * 1000;

  // Map live agents -> project dirs, grouping agents that share a cwd.
  const byProject = new Map<string, { cwd: string; projectId: string; roles: string[] }>();
  const skippedNoCwd: string[] = [];
  for (const a of agents) {
    const cwd = cwdForPid(a.pid);
    if (!cwd) {
      skippedNoCwd.push(a.role);
      continue;
    }
    const projectId = projectIdFromCwd(cwd);
    const dir = path.join(PROJECTS_DIR, projectId);
    if (!fs.existsSync(dir)) {
      skippedNoCwd.push(a.role);
      continue;
    }
    const entry = byProject.get(projectId) || { cwd, projectId, roles: [] };
    entry.roles.push(a.role);
    byProject.set(projectId, entry);
  }

  const perDay = new Map<string, { totalTokens: number; estCostUsd: number }>();
  const projects: ProjectUsage[] = [];
  // Global dedupe key set, shared across every transcript in this read, so a
  // message re-emitted in a forked session is counted exactly once.
  const seen = new Set<string>();

  for (const { cwd, projectId, roles } of byProject.values()) {
    const dir = path.join(PROJECTS_DIR, projectId);
    const proj: ProjectUsage = {
      projectId,
      cwd,
      label:
        roles.length === 1
          ? roles[0]
          : `${path.basename(cwd)} (${roles.length} agents)`,
      agentRoles: roles,
      sessions: 0,
      totals: emptyBucket(),
      perModel: {},
    };

    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));
    } catch {
      files = [];
    }

    for (const file of files) {
      // mtime guard: a transcript not touched since the window opened can hold
      // no in-window usage. Skips ancient sessions cheaply.
      try {
        if (fs.statSync(file).mtimeMs < windowStartMs) continue;
      } catch {
        continue;
      }
      proj.sessions++;
      await scanTranscript(file, windowStartMs, proj, perDay, seen);
    }

    projects.push(proj);
  }

  // Fleet roll-ups.
  const fleetTotals = emptyBucket();
  const fleetPerModel: Record<string, TokenBucket> = {};
  for (const proj of projects) {
    fleetTotals.input += proj.totals.input;
    fleetTotals.output += proj.totals.output;
    fleetTotals.cacheRead += proj.totals.cacheRead;
    fleetTotals.cacheCreation += proj.totals.cacheCreation;
    fleetTotals.totalTokens += proj.totals.totalTokens;
    fleetTotals.estCostUsd += proj.totals.estCostUsd;
    for (const [model, b] of Object.entries(proj.perModel)) {
      if (!fleetPerModel[model]) fleetPerModel[model] = emptyBucket();
      const t = fleetPerModel[model];
      t.input += b.input;
      t.output += b.output;
      t.cacheRead += b.cacheRead;
      t.cacheCreation += b.cacheCreation;
      t.totalTokens += b.totalTokens;
      t.estCostUsd += b.estCostUsd;
    }
  }

  // Dense per-day series across the window (zero-filled), oldest → newest.
  const perDaySeries: PerDayPoint[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = localDate(now - i * 24 * 60 * 60 * 1000);
    const v = perDay.get(date) || { totalTokens: 0, estCostUsd: 0 };
    perDaySeries.push({ date, totalTokens: v.totalTokens, estCostUsd: v.estCostUsd });
  }

  // Heaviest projects first.
  projects.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    scannedProjects: projects.length,
    skippedNoCwd,
    fleet: { totals: fleetTotals, perModel: fleetPerModel, perDay: perDaySeries },
    projects,
  };
}
