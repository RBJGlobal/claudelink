// Compact-loss analyzer (read-only) — the calibration engine for intelligent
// auto-compact. Scans the fleet's existing transcripts for compact events and,
// for each, records the ground-truth effect + four intelligence-LOSS signals
// in the surrounding turns. Run on NATURALLY-OCCURRING compacts (the founder's
// manual /compact discipline + Claude Code's built-in auto-compact), so we
// build a labeled loss dataset and validate the heuristics BEFORE the watcher
// ever auto-triggers one. No injection, no terminal contact.
//
// Ground truth is exact: Claude Code records each compact as a transcript line
//   { type:"system", subtype:"compact_boundary",
//     compactMetadata:{ trigger:"auto"|"manual", preTokens, postTokens, durationMs } }
// so we know the real context size before/after — no estimation.
//
// CAVEAT (carried into the case study): manual compacts fire at task
// boundaries; the auto-trigger fires at an economic threshold (mid-task). These
// are different populations. This analyzer validates the loss-signal DETECTION
// MECHANICS on real events; the loss RATES it reports for manual compacts are
// NOT extrapolatable to auto-trigger rates — the armed soak measures those.

import fs from "fs";
import path from "path";
import readline from "readline";
import { cwdForPid, projectIdFromCwd, PROJECTS_DIR } from "./usage-reader.js";

// Window sizes (in real user/assistant turns) for signal computation, kept
// tight so legitimate repeats far from a compact don't register as loss.
const PRE_WINDOW = 12;
const POST_WINDOW = 12;
const REEXPLAIN_CHARS = 1500; // a human user message longer than this = re-explain

interface Turn {
  role: "user" | "assistant";
  text: string;
  textLen: number;
  toolSigs: string[]; // tool_use signatures in this turn
  readSigs: string[]; // subset: read-type tool signatures
  isCompactSummary: boolean; // the auto-generated summary re-injected post-compact
}

export interface CompactEvent {
  project: string;
  roles: string[];
  trigger: string | null; // "auto" | "manual"
  preTokens: number | null;
  postTokens: number | null;
  reductionPct: number | null;
  durationMs: number | null;
  // Loss signals (see header). reworkHits / refetchHits are robust-ish;
  // turnsToRecover / userReexplain are heuristic — validated by founder labels.
  reworkHits: number; // post-compact tool actions repeating a pre-compact action
  refetchHits: number; // post-compact re-reads of pre-compact reads (re-ask proxy)
  turnsToRecover: number | null; // turns until first NEW productive tool action
  userReexplain: boolean; // a long human message post-compact (excl. the summary)
}

export interface CompactAnalysis {
  generatedAt: string;
  windowDays: number;
  totalEvents: number;
  byTrigger: Record<string, {
    count: number;
    medianPreTokens: number;
    medianPostTokens: number;
    medianReductionPct: number;
    reworkRate: number; // share of events with >=1 rework hit
    refetchRate: number;
    userReexplainRate: number;
    medianTurnsToRecover: number | null;
  }>;
  events: CompactEvent[];
}

interface AgentRef {
  role: string;
  pid: number;
}

// Primary distinguishing argument per tool, so a signature captures "same
// action" without being so loose it matches everything.
function toolSignature(name: string, input: any): string {
  const i = input || {};
  if (name === "Bash") return "Bash:" + String(i.command || "").slice(0, 80);
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) return name + ":" + (i.file_path || "");
  if (["Grep", "Glob"].includes(name)) return name + ":" + (i.pattern || i.glob || "");
  // generic: name + a short stable slice of the args
  try {
    return name + ":" + JSON.stringify(i).slice(0, 80);
  } catch {
    return name;
  }
}
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

function parseTurn(o: any, prevWasBoundary: boolean): Turn | null {
  const t = o?.type;
  if (t !== "user" && t !== "assistant") return null;
  const m = o?.message;
  if (!m) return null;
  const toolSigs: string[] = [];
  const readSigs: string[] = [];
  let text = "";
  let isToolResult = false;
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        const sig = toolSignature(b.name, b.input);
        toolSigs.push(sig);
        if (READ_TOOLS.has(b.name)) readSigs.push(sig);
      } else if (b.type === "text") {
        text += b.text || "";
      } else if (b.type === "tool_result") {
        isToolResult = true;
      }
    }
  } else if (typeof m.content === "string") {
    text = m.content;
  }
  // A user line that is purely a tool_result is not a human turn; skip for
  // re-explain purposes but it's still a turn for recovery counting.
  return {
    role: t,
    text,
    textLen: text.length,
    toolSigs,
    readSigs,
    // The compact summary is the large user message immediately after the
    // boundary (and is flagged by the harness as a compact summary in content).
    isCompactSummary: t === "user" && prevWasBoundary && !isToolResult && text.length > 0,
  };
}

async function analyzeFile(file: string, seenBoundaries: Set<string>, out: CompactEvent[], projectLabel: string, roles: string[]): Promise<void> {
  // Load the ordered raw lines we care about. We need turn context around each
  // boundary, so collect a lightweight sequence: boundaries + real turns.
  type Item = { kind: "boundary"; meta: any; uuid: string } | { kind: "turn"; turn: Turn };
  const seq: Item[] = [];
  let prevWasBoundary = false;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "system" && o?.subtype === "compact_boundary") {
      seq.push({ kind: "boundary", meta: o.compactMetadata || {}, uuid: o.uuid || `${file}:${seq.length}` });
      prevWasBoundary = true;
      continue;
    }
    const turn = parseTurn(o, prevWasBoundary);
    if (turn) {
      seq.push({ kind: "turn", turn });
      prevWasBoundary = false;
    }
  }

  // Index the turn positions for windowing.
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i];
    if (it.kind !== "boundary") continue;
    if (seenBoundaries.has(it.uuid)) continue; // dedupe forked re-emits
    seenBoundaries.add(it.uuid);

    const meta = it.meta;
    const pre = meta.preTokens ?? null;
    const post = meta.postTokens ?? null;

    // Gather pre/post turns (real turns only) within the windows.
    const preTurns: Turn[] = [];
    for (let j = i - 1; j >= 0 && preTurns.length < PRE_WINDOW; j--) {
      if (seq[j].kind === "turn") preTurns.push((seq[j] as any).turn);
    }
    const postTurns: Turn[] = [];
    for (let j = i + 1; j < seq.length && postTurns.length < POST_WINDOW; j++) {
      if (seq[j].kind === "turn") postTurns.push((seq[j] as any).turn);
      if (seq[j].kind === "boundary") break; // stop at the next compact
    }

    const preToolSigs = new Set<string>();
    const preReadSigs = new Set<string>();
    for (const t of preTurns) {
      t.toolSigs.forEach((s) => preToolSigs.add(s));
      t.readSigs.forEach((s) => preReadSigs.add(s));
    }

    let reworkHits = 0;
    let refetchHits = 0;
    let turnsToRecover: number | null = null;
    let userReexplain = false;
    let recoverCount = 0;

    for (const t of postTurns) {
      recoverCount++;
      // rework: a post-compact tool action whose signature appeared pre-compact
      for (const s of t.toolSigs) if (preToolSigs.has(s)) reworkHits++;
      // refetch (re-ask proxy): a post-compact read of something read pre-compact
      for (const s of t.readSigs) if (preReadSigs.has(s)) refetchHits++;
      // recovery: first post-compact assistant turn issuing a NEW tool action
      if (turnsToRecover === null && t.role === "assistant") {
        const hasNew = t.toolSigs.some((s) => !preToolSigs.has(s));
        if (hasNew) turnsToRecover = recoverCount;
      }
      // re-explain: a human user message (not the summary, not a tool_result)
      // longer than the threshold
      if (!t.isCompactSummary && t.role === "user" && t.toolSigs.length === 0 && t.textLen > REEXPLAIN_CHARS) {
        userReexplain = true;
      }
    }

    out.push({
      project: projectLabel,
      roles,
      trigger: meta.trigger ?? null,
      preTokens: pre,
      postTokens: post,
      reductionPct: pre && post && pre > 0 ? Math.round((100 * (pre - post)) / pre) : null,
      durationMs: meta.durationMs ?? null,
      reworkHits,
      refetchHits,
      turnsToRecover,
      userReexplain,
    });
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Path-A loss baseline + A-vs-B comparison harness (design §C / §D) ──
// Deeper read of the HISTORICAL /compact events (= Path A): does loss scale with
// context size? what do the worst cases look like? The comparison harness is
// pre-instrumented so the soak drops Path-B events in for a clean A-vs-B. We do
// NOT fabricate a B side — there is no historical CLEAR+reinject data.

export interface LossBucket {
  bucket: string;
  count: number;
  reworkRate: number;
  reexplainRate: number;
  medianTurnsToRecover: number | null;
}
export interface LossBaseline {
  source: string;
  totalEvents: number;
  byPreTokenBucket: LossBucket[];
  worstCases: Array<{
    project: string;
    preTokens: number | null;
    reworkHits: number;
    turnsToRecover: number | null;
    userReexplain: boolean;
  }>;
  comparison: {
    pathA: { source: string; events: number; reworkRate: number; reexplainRate: number; medianTurnsToRecover: number | null };
    pathB: null; // awaiting the founder-gated soak — cannot be measured read-only
    defaultSoakPath: "A";
    note: string;
  };
}

const BUCKETS: Array<[string, number, number]> = [
  ["<100K", 0, 100_000],
  ["100-250K", 100_000, 250_000],
  ["250-500K", 250_000, 500_000],
  ["500K-1M", 500_000, 1_000_000],
  [">=1M", 1_000_000, Infinity],
];

export function pathALossBaseline(events: CompactEvent[]): LossBaseline {
  const rate = (es: CompactEvent[], pred: (e: CompactEvent) => boolean) =>
    es.length ? es.filter(pred).length / es.length : 0;

  const byPreTokenBucket: LossBucket[] = BUCKETS.map(([label, lo, hi]) => {
    const es = events.filter((e) => (e.preTokens ?? 0) >= lo && (e.preTokens ?? 0) < hi);
    const recov = es.map((e) => e.turnsToRecover).filter((n): n is number => n !== null);
    return {
      bucket: label,
      count: es.length,
      reworkRate: rate(es, (e) => e.reworkHits > 0),
      reexplainRate: rate(es, (e) => e.userReexplain),
      medianTurnsToRecover: recov.length ? median(recov) : null,
    };
  }).filter((b) => b.count > 0);

  const worstCases = [...events]
    .sort((a, b) => b.reworkHits - a.reworkHits || (b.turnsToRecover ?? 0) - (a.turnsToRecover ?? 0))
    .slice(0, 5)
    .map((e) => ({
      project: e.project,
      preTokens: e.preTokens,
      reworkHits: e.reworkHits,
      turnsToRecover: e.turnsToRecover,
      userReexplain: e.userReexplain,
    }));

  const recovAll = events.map((e) => e.turnsToRecover).filter((n): n is number => n !== null);
  return {
    source: "historical Path-A (Claude Code /compact); HEURISTIC signals; NON-representative of auto-trigger rates (manual = task-boundary timing). Validates detection mechanics, not arming-phase loss rates.",
    totalEvents: events.length,
    byPreTokenBucket,
    worstCases,
    comparison: {
      pathA: {
        source: "historical /compact (this dataset)",
        events: events.length,
        reworkRate: rate(events, (e) => e.reworkHits > 0),
        reexplainRate: rate(events, (e) => e.userReexplain),
        medianTurnsToRecover: recovAll.length ? median(recovAll) : null,
      },
      pathB: null,
      defaultSoakPath: "A",
      note: "Path B (CLEAR+reinject) has no historical data and cannot be measured read-only — its loss signals only exist if the path is executed in the founder-gated soak. A is the conservative-soak default; B is tested against A's measured baseline.",
    },
  };
}

export async function analyzeCompactEvents(
  agents: AgentRef[],
  windowDays = 30
): Promise<CompactAnalysis> {
  const windowStartMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const byProject = new Map<string, { roles: string[]; cwd: string }>();
  for (const a of agents) {
    const cwd = cwdForPid(a.pid);
    if (!cwd) continue;
    const id = projectIdFromCwd(cwd);
    const e = byProject.get(id) || { roles: [], cwd };
    e.roles.push(a.role);
    byProject.set(id, e);
  }

  const events: CompactEvent[] = [];
  const seen = new Set<string>();
  for (const [id, { roles, cwd }] of byProject) {
    const dir = path.join(PROJECTS_DIR, id);
    const label = roles.length === 1 ? roles[0] : `${path.basename(cwd)} (${roles.length} agents)`;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        if (fs.statSync(file).mtimeMs < windowStartMs) continue;
      } catch {
        continue;
      }
      await analyzeFile(file, seen, events, label, roles);
    }
  }

  // Roll up by trigger type.
  const byTrigger: CompactAnalysis["byTrigger"] = {};
  for (const trig of new Set(events.map((e) => e.trigger || "unknown"))) {
    const es = events.filter((e) => (e.trigger || "unknown") === trig);
    const recov = es.map((e) => e.turnsToRecover).filter((n): n is number => n !== null);
    byTrigger[trig] = {
      count: es.length,
      medianPreTokens: median(es.map((e) => e.preTokens || 0)),
      medianPostTokens: median(es.map((e) => e.postTokens || 0)),
      medianReductionPct: median(es.map((e) => e.reductionPct || 0)),
      reworkRate: es.length ? es.filter((e) => e.reworkHits > 0).length / es.length : 0,
      refetchRate: es.length ? es.filter((e) => e.refetchHits > 0).length / es.length : 0,
      userReexplainRate: es.length ? es.filter((e) => e.userReexplain).length / es.length : 0,
      medianTurnsToRecover: recov.length ? median(recov) : null,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totalEvents: events.length,
    byTrigger,
    events,
  };
}
