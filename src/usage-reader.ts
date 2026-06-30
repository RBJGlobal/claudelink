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
// Per-session sub-row for the table's expand (+). Labeled with the agent ROLE
// when the session maps to a known agent (single-agent project, or shared-repo
// once session-capture/transcript_path is populated); otherwise a session-id
// stub so the distribution is still visible.
export interface SessionUsage {
  sessionId: string;
  label: string;
  mapped: boolean; // true = label is a real agent role; false = unattributed session
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
  breakdown: SessionUsage[]; // per-session, heaviest first (for the + expand)
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
  // Compact-savings opportunity, computed in the SAME transcript pass as the
  // meter (no second full scan). Upper-bound — real delta is measured in soak.
  compactOpportunity: {
    thresholdTokens: number;
    compactBaselineTokens: number;
    flaggedTurns: number;
    excessTokensUpperBound: number;
    estUsdUpperBound: number;
  };
}

// Minimal shape of a registered agent the reader needs. Caller passes live
// agents (alive === true) only — we never scan a project with no live agent,
// which is the privacy guardrail: we read FLEET transcripts, not the user's
// entire ~/.claude history.
export interface AgentRef {
  role: string;
  pid: number;
  // From session-capture (v4). When present, maps this agent to its EXACT
  // session transcript so per-agent breakdown is labeled by role even in a
  // shared repo dir. NULL until the hook fires post-deploy.
  transcriptPath?: string | null;
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

// Model-aware cache-read price (USD per million tokens). The $/turn economic
// trigger uses this so the threshold auto-adjusts across models — Opus triggers
// far earlier than Haiku for the same context size, which is correct.
export function cacheReadPricePerMtok(model: string): number {
  return priceFor(model).cacheRead;
}

// Model context window (tokens). Default 200K — the standard window for Opus
// 4.x / Sonnet 4.x / Haiku 4.x. Honors the 1M-context beta when the model id
// carries the `[1m]` suffix or a `-1m` variant. Used by the per-model
// proportional-occupancy threshold so the arming criterion is "what fraction
// of this model's window is currently re-sent each turn" — proportional, not a
// raw-size or raw-dollar absolute. The 50%-of-window default replaces the
// model-blind dollar gate the rollout originally shipped with.
export function modelContextWindow(model: string): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes("[1m]") || m.includes("-1m") || m.includes(" 1m")) return 1_000_000;
  return 200_000;
}

// The window to divide observed context by. The model ID alone is not enough:
// the 1M-context beta is a request HEADER, so Claude Code records the model as
// plain "claude-opus-4-8" even when it's running on a 1M window — modelContextWindow
// then defaults to 200K and occupancy reads >100% (e.g. a real 572K turn shows 286%).
//
// We infer from evidence instead: if a turn's input-side tokens EXCEED 200K, the
// API accepted a request a 200K model would have rejected, so that session is
// provably on a >200K (i.e. 1M) window. Below 200K the label is unchanged —
// correct for a 200K model, harmless for a 1M one — so this only corrects the
// misleading >100% case. Self-correcting, no config, no transcript internals.
export function effectiveContextWindow(model: string, contextTokens: number): number {
  if (contextTokens > 200_000) return 1_000_000;
  return modelContextWindow(model);
}

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
interface OppAccumulator {
  thresholdTokens: number;
  baselineTokens: number;
  flaggedTurns: number;
  excessTokens: number;
}

async function scanTranscript(
  file: string,
  windowStartMs: number,
  proj: ProjectUsage,
  perDay: Map<string, { totalTokens: number; estCostUsd: number }>,
  seen: Set<string>,
  opp: OppAccumulator,
  fileBucket: TokenBucket,
  fileInfo: { registerRole: string | null }
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Capture the agent's self-identified role: each session registers through
    // ClaudeLink, so the transcript contains its own register tool_use with the
    // role. This labels per-session sub-rows by registered name with no
    // dependence on the deploy/session-capture. Cheap-gated on the substring.
    if (fileInfo.registerRole === null && line.indexOf("register") !== -1) {
      try {
        const ro = JSON.parse(line);
        const content = ro?.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (
              b && b.type === "tool_use" &&
              typeof b.name === "string" &&
              // Tighten match: an MCP server with a tool named e.g.
              // "register_user" would have leaked through includes("register").
              // The ClaudeLink register tool is namespaced under mcp__claudelink
              // by Claude Code, so the trailing-name is "register" or
              // "mcp__claudelink__register" — match the suffix exactly.
              (b.name === "register" ||
                b.name.endsWith("__register") ||
                b.name === "mcp__claudelink__register") &&
              b.input && typeof b.input.role === "string" && b.input.role
            ) {
              fileInfo.registerRole = b.input.role;
              break;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
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

    // Compact-opportunity, same pass: a turn's input-side tokens = context
    // occupancy; count the excess over the post-compact baseline for turns
    // above threshold (upper-bound savings if compacted at threshold).
    const ctxTokens =
      (Number(u.input_tokens) || 0) +
      (Number(u.cache_read_input_tokens) || 0) +
      (Number(u.cache_creation_input_tokens) || 0);
    if (ctxTokens > opp.thresholdTokens) {
      opp.flaggedTurns++;
      opp.excessTokens += Math.max(0, ctxTokens - opp.baselineTokens);
    }

    addUsage(proj.totals, model, u);
    if (!proj.perModel[model]) proj.perModel[model] = emptyBucket();
    addUsage(proj.perModel[model], model, u);
    addUsage(fileBucket, model, u); // per-session total for the + expand

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

// ── Per-agent timeline (the 3 dashboard surfaces, locked spec lines 175-194) ──
// #1 cumulative-lifetime (all-time, monotonic — a sliding window would NOT be
// monotonic, so this is all-time per-agent), #2 current-context-size (the live
// window, resets on compact), #3 compact-event markers. Attributed per-AGENT
// (register-role), summed across ALL the agent's sessions — never per-session
// (a /clear starts a fresh transcript that a per-session sum would zero out).
export interface CompactMarker {
  ts: string;
  trigger: string;
  preTokens: number;
  postTokens: number;
}
export interface AgentTimeline {
  role: string;
  cumulativeTokens: number; // #1 all-time, all sessions
  cumulativeEstUsd: number;
  currentContextTokens: number; // #2 latest turn of the most-recent session
  currentContextPerTurnUsd: number;
  compactEvents: CompactMarker[]; // #3 timeline markers (most recent last)
  sessions: number;
  lastActivity: string | null;
}

interface FileTimeline {
  registerRole: string | null;
  tokens: number;
  estUsd: number;
  compacts: CompactMarker[];
  latestCtxTokens: number;
  latestModel: string;
  latestTs: number;
}

async function scanFileForTimeline(file: string, seen: Set<string>): Promise<FileTimeline> {
  const out: FileTimeline = { registerRole: null, tokens: 0, estUsd: 0, compacts: [], latestCtxTokens: 0, latestModel: "", latestTs: 0 };
  const bucket = emptyBucket();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    // compact boundary marker (#3)
    if (line.indexOf("compact_boundary") !== -1) {
      try {
        const o = JSON.parse(line);
        if (o?.type === "system" && o?.subtype === "compact_boundary") {
          const cm = o.compactMetadata || {};
          out.compacts.push({ ts: o.timestamp || "", trigger: cm.trigger ?? "?", preTokens: cm.preTokens ?? 0, postTokens: cm.postTokens ?? 0 });
          // A compact is the most-recent EVENT when the agent hasn't taken a
          // turn since — current-context is then the post-compact size (e.g.
          // 13K), not the stale pre-compact turn. Latest event wins.
          const cts = Date.parse(o.timestamp || "") || 0;
          if (cts >= out.latestTs && cm.postTokens != null) { out.latestTs = cts; out.latestCtxTokens = cm.postTokens; }
          continue;
        }
      } catch { /* fall through */ }
    }
    // register-role capture (agent identity)
    if (out.registerRole === null && line.indexOf("register") !== -1) {
      try {
        const c = JSON.parse(line)?.message?.content;
        if (Array.isArray(c)) for (const b of c) if (b && b.type === "tool_use" && typeof b.name === "string" && b.name.includes("register") && b.input && typeof b.input.role === "string" && b.input.role) { out.registerRole = b.input.role; break; }
      } catch { /* ignore */ }
    }
    if (line.indexOf('"usage"') === -1) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o?.message;
    const u = msg?.usage;
    if (!u || !msg?.model || msg.model === "<synthetic>") continue;
    if (msg.id && o.requestId) { const k = msg.id + "::" + o.requestId; if (seen.has(k)) continue; seen.add(k); }
    addUsage(bucket, msg.model, u);
    const ts = Date.parse(o.timestamp || "") || 0;
    // current-context = the chronologically-latest turn's input-side tokens
    const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (ts >= out.latestTs) { out.latestTs = ts; out.latestCtxTokens = ctx; out.latestModel = msg.model; }
  }
  out.tokens = bucket.totalTokens;
  out.estUsd = bucket.estCostUsd;
  return out;
}

export async function readAgentTimelines(agents: AgentRef[]): Promise<AgentTimeline[]> {
  // Group by project; remember each project's roles + transcript_path→role map.
  const byProject = new Map<string, { dir: string; roles: string[]; pathRole: Map<string, string> }>();
  for (const a of agents) {
    const cwd = cwdForPid(a.pid);
    if (!cwd) continue;
    const id = projectIdFromCwd(cwd);
    const dir = path.join(PROJECTS_DIR, id);
    if (!fs.existsSync(dir)) continue;
    const e = byProject.get(id) || { dir, roles: [], pathRole: new Map<string, string>() };
    e.roles.push(a.role);
    if (a.transcriptPath) e.pathRole.set(a.transcriptPath, a.role);
    byProject.set(id, e);
  }

  const perRole = new Map<string, AgentTimeline>();
  const get = (role: string): AgentTimeline => {
    let t = perRole.get(role);
    if (!t) { t = { role, cumulativeTokens: 0, cumulativeEstUsd: 0, currentContextTokens: 0, currentContextPerTurnUsd: 0, compactEvents: [], sessions: 0, lastActivity: null }; perRole.set(role, t); }
    return t;
  };
  const seen = new Set<string>();
  const latestTsByRole = new Map<string, number>();

  for (const { dir, roles, pathRole } of byProject.values()) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)); } catch { continue; }
    for (const file of files) {
      const ft = await scanFileForTimeline(file, seen);
      if (ft.tokens === 0 && ft.compacts.length === 0) continue;
      // attribute: transcript_path map → role; else register-role; else single-agent project's role; else skip
      const role = pathRole.get(file) || ft.registerRole || (roles.length === 1 ? roles[0] : null);
      if (!role) continue;
      const t = get(role);
      t.cumulativeTokens += ft.tokens;
      t.cumulativeEstUsd += ft.estUsd;
      t.sessions += 1;
      for (const c of ft.compacts) t.compactEvents.push(c);
      // current-context = latest turn across the role's most-recent session
      if (ft.latestTs > (latestTsByRole.get(role) || 0) && ft.latestCtxTokens > 0) {
        latestTsByRole.set(role, ft.latestTs);
        t.currentContextTokens = ft.latestCtxTokens;
        t.currentContextPerTurnUsd = (ft.latestCtxTokens * priceFor(ft.latestModel).cacheRead) / 1_000_000;
        t.lastActivity = new Date(ft.latestTs).toISOString();
      }
    }
  }

  for (const t of perRole.values()) t.compactEvents.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  return [...perRole.values()].filter((t) => agents.some((a) => a.role === t.role)).sort((a, b) => b.cumulativeTokens - a.cumulativeTokens);
}

export async function readFleetUsage(
  agents: AgentRef[],
  windowDays: number = 7,
  thresholdTokens: number = 200000,
  compactBaselineTokens: number = 60000
): Promise<FleetUsage> {
  const now = Date.now();
  const windowStartMs = now - windowDays * 24 * 60 * 60 * 1000;
  const opp: OppAccumulator = {
    thresholdTokens,
    baselineTokens: compactBaselineTokens,
    flaggedTurns: 0,
    excessTokens: 0,
  };

  // Map live agents -> project dirs, grouping agents that share a cwd. pathRole
  // maps a captured transcript_path to its agent role, so per-session sub-rows
  // can be labeled by agent even in a shared repo dir (once session-capture is
  // populated).
  const byProject = new Map<string, { cwd: string; projectId: string; roles: string[]; pathRole: Map<string, string> }>();
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
    const entry = byProject.get(projectId) || { cwd, projectId, roles: [], pathRole: new Map<string, string>() };
    entry.roles.push(a.role);
    if (a.transcriptPath) entry.pathRole.set(a.transcriptPath, a.role);
    byProject.set(projectId, entry);
  }

  const perDay = new Map<string, { totalTokens: number; estCostUsd: number }>();
  const projects: ProjectUsage[] = [];
  // Global dedupe key set, shared across every transcript in this read, so a
  // message re-emitted in a forked session is counted exactly once.
  const seen = new Set<string>();

  for (const { cwd, projectId, roles, pathRole } of byProject.values()) {
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
      breakdown: [],
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
      const fileBucket = emptyBucket();
      const fileInfo: { registerRole: string | null } = { registerRole: null };
      await scanTranscript(file, windowStartMs, proj, perDay, seen, opp, fileBucket, fileInfo);
      if (fileBucket.totalTokens > 0) {
        const sessionId = path.basename(file).replace(/\.jsonl$/, "");
        // Label priority: (1) exact session-capture map; (2) the agent's own
        // register call found in the transcript (works NOW, no deploy);
        // (3) single-agent project owns its sessions; (4) session-id stub.
        let label: string;
        let mapped: boolean;
        if (pathRole.has(file)) {
          label = pathRole.get(file)!;
          mapped = true;
        } else if (fileInfo.registerRole) {
          label = fileInfo.registerRole;
          mapped = true;
        } else if (roles.length === 1) {
          label = roles[0];
          mapped = true;
        } else {
          label = "session " + sessionId.slice(0, 8);
          mapped = false;
        }
        proj.breakdown.push({
          sessionId,
          label,
          mapped,
          totalTokens: fileBucket.totalTokens,
          estCostUsd: fileBucket.estCostUsd,
        });
      }
    }
    proj.breakdown.sort((a, b) => b.totalTokens - a.totalTokens);

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
    compactOpportunity: {
      thresholdTokens,
      compactBaselineTokens,
      flaggedTurns: opp.flaggedTurns,
      excessTokensUpperBound: opp.excessTokens,
      estUsdUpperBound: (opp.excessTokens * OPUS_CACHE_READ_PER_MTOK) / 1_000_000,
    },
  };
}
