// Compact executor — the prepare-then-compact handshake and the two
// state-preservation paths (§C of the auto-compact design), built in DRY mode:
// every flow is a PLANNER that logs the ordered steps it WOULD take. The actual
// terminal-injection points are guarded stubs — nothing types into a terminal
// here. Arming (real injection) is founder-gated and happens in the supervised
// soak, where the A-vs-B winner is MEASURED (it cannot be measured read-only:
// a path's loss-signals only exist if that path is executed).
//
// HYPOTHESIS (explicitly a hypothesis, not a measurement) — informs the soak's
// starting posture, does NOT decide it:
//   Path A (/compact + handoff-file) = belt-and-suspenders. Claude Code's own
//     summary PLUS the agent's structured handoff. If the handoff misses
//     something, the model summary is a safety net. Lower risk FLOOR.
//   Path B (CLEAR + handoff-reinject) = total control. Skip /compact entirely;
//     the handoff IS the new context. No dependency on /compact's opaque
//     summarization — potentially a higher ceiling — but if the handoff misses
//     something it is GONE, no safety net. Higher risk floor.
//   => Start the soak with A as the CONSERVATIVE DEFAULT; test B as the
//      optimization against A's measured baseline. (Per senior review + pushback #4.)

import fs from "fs";
import path from "path";
import os from "os";

export type CompactPath = "A" | "B";
export const DEFAULT_PATH: CompactPath = "A"; // conservative-soak default

export const HANDOFF_DIR = path.join(os.homedir(), ".claudelink", "handoffs");

// Marker substrings from HANDOFF_TEMPLATE — used by verifyHandoff to detect a
// "filled in nothing, just kept the stub" handoff. The template itself is
// ~270 bytes which sails over the >200-byte size gate, so a byte-count check
// alone is bypassable. Updated together with HANDOFF_TEMPLATE.
const HANDOFF_PLACEHOLDERS = [
  "<role>",
  "<what you are doing right now",
  "<constraints, choices already made",
  "<the very next action to take on resume>",
  "<anything in flight, awaited, or deferred>",
];

// True iff `p` resolves under ~/.claudelink/handoffs/. Used at the
// signal_checkpoint ingress to reject agent-supplied paths that would let a
// confused agent satisfy the handoff gate with any large file on disk
// (e.g. /etc/passwd, a node_modules tarball). Returns false for any path that
// can't be resolved.
export function isHandoffPathSafe(p: string): boolean {
  try {
    const resolved = path.resolve(p);
    const root = path.resolve(HANDOFF_DIR);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

// The structured essence the agent preserves across a compact. The 780K it
// re-reads every turn is mostly dead weight; this is the few-KB that matters.
export const HANDOFF_TEMPLATE = `# ClaudeLink handoff — <role>

## Current task & progress
<what you are doing right now and how far along>

## Key decisions / context you must NOT lose
<constraints, choices already made, facts that won't be re-derivable>

## Exact next step
<the very next action to take on resume>

## Open threads
<anything in flight, awaited, or deferred>
`;

export function handoffPathFor(agentId: string): string {
  return path.join(HANDOFF_DIR, `${agentId}.md`);
}

// Step 2 of the handshake: the prepare-for-compact prompt (NOT a blind /compact).
export function preparePrompt(perTurnCostUsd: number, handoffFile: string): string {
  return (
    `Your context is now costing ~$${perTurnCostUsd.toFixed(2)}/turn to re-read. ` +
    `Before I compact it, write a handoff to ${handoffFile} capturing: current task + progress; ` +
    `key decisions/context you must not lose; the exact next step; open threads. ` +
    `Reply READY when the file is written.`
  );
}

// Step 6: the post-compact re-orient prompt, points the agent at its essence.
export function postCompactPrompt(p: CompactPath, handoffFile: string): string {
  if (p === "A") {
    return `Context compacted. Resume from your handoff at ${handoffFile} (plus the compact summary above).`;
  }
  return `Fresh context. Your handoff is at ${handoffFile} — resume from it; that is your full working state.`;
}

// Verify the agent actually wrote a non-trivial handoff before compacting.
// Two checks, both required: file must be >200 bytes AND must NOT contain any
// of the HANDOFF_TEMPLATE placeholders unfilled. A byte-count alone is
// bypassable because the template itself is ~270 bytes — an agent that wrote
// the template verbatim with nothing else would satisfy size but have zero
// real content. The placeholder scan catches that.
export function verifyHandoff(file: string): { ok: boolean; bytes: number } {
  try {
    const st = fs.statSync(file);
    if (st.size <= 200) return { ok: false, bytes: st.size };
    const body = fs.readFileSync(file, "utf-8");
    for (const ph of HANDOFF_PLACEHOLDERS) {
      if (body.includes(ph)) return { ok: false, bytes: st.size };
    }
    return { ok: true, bytes: st.size };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

export interface CompactStep {
  action:
    | "send-prepare-prompt"
    | "await-ready"
    | "verify-handoff"
    | "inject-compact"
    | "inject-clear"
    | "reinject-handoff"
    | "send-postcompact-prompt";
  detail: string;
  injects: boolean; // true = a step that types into the live terminal (GATED)
}

// The ordered plan for a given path. This is what the soak would execute; in dry
// mode we only LOG it. The `injects` flags mark exactly which steps touch the
// terminal — all of them stay stubbed until founder-armed.
export function planCompact(
  p: CompactPath,
  perTurnCostUsd: number,
  handoffFile: string
): CompactStep[] {
  const common: CompactStep[] = [
    { action: "send-prepare-prompt", detail: preparePrompt(perTurnCostUsd, handoffFile), injects: true },
    { action: "await-ready", detail: "wait for the agent to reply READY (bounded timeout)", injects: false },
    { action: "verify-handoff", detail: `verify ${handoffFile} exists and is non-trivial`, injects: false },
  ];
  if (p === "A") {
    return [
      ...common,
      { action: "inject-compact", detail: "type /compact (Claude Code summarizes)", injects: true },
      { action: "send-postcompact-prompt", detail: postCompactPrompt("A", handoffFile), injects: true },
    ];
  }
  return [
    ...common,
    { action: "inject-clear", detail: "type /clear (fresh context, no model summary)", injects: true },
    { action: "reinject-handoff", detail: "inject the handoff file contents as the new starting message", injects: true },
    { action: "send-postcompact-prompt", detail: postCompactPrompt("B", handoffFile), injects: true },
  ];
}

export type ExecMode = "dry" | "armed";

export interface ExecResult {
  path: CompactPath;
  mode: ExecMode;
  steps: CompactStep[];
  executed: boolean; // false in dry mode (and currently always false)
  note: string;
}

// Execute (or, in dry mode, PLAN) a compact via the chosen path. In dry mode it
// returns the plan without touching anything. "armed" mode is NOT reachable yet:
// it throws, because real injection is founder-gated and must be wired with the
// idle-prompt safety detector under supervision — not enabled from here.
export function executeCompact(
  agentId: string,
  p: CompactPath,
  perTurnCostUsd: number,
  mode: ExecMode = "dry"
): ExecResult {
  const handoffFile = handoffPathFor(agentId);
  const steps = planCompact(p, perTurnCostUsd, handoffFile);
  if (mode === "armed") {
    throw new Error(
      "compact-executor: armed injection is not enabled — founder-gated, requires the idle-prompt safety detector and a supervised soak."
    );
  }
  return {
    path: p,
    mode: "dry",
    steps,
    executed: false,
    note: "dry plan only — no terminal contact; injection steps marked injects:true are stubbed pending founder-armed soak",
  };
}
