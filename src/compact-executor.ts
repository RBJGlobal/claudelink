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

const HANDOFF_DIR = path.join(os.homedir(), ".claudelink", "handoffs");

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
export function verifyHandoff(file: string): { ok: boolean; bytes: number } {
  try {
    const st = fs.statSync(file);
    return { ok: st.size > 200, bytes: st.size }; // >200 bytes = more than the template stub
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
