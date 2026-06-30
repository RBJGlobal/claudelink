// T1 consent handshake — pure decision core for the armed /compact path.
//
// Background: before this, the watcher auto-fired /compact the moment an
// allowlisted agent was idle at a turn boundary (the Stop hook touches
// checkpoint_ts every turn, so the old "fresh_consent" gate was satisfied
// automatically — the agent never actually said yes). This module replaces
// that silent fire with a two-phase handshake:
//
//   ASK  — when occupancy is high + the agent is idle + compacting is
//          economically worth a turn, type a prompt asking the agent to flush
//          its handoff and CONSENT via signal_checkpoint(safe_to_clear=true).
//   FIRE — only once a GENUINE consent is on record (checkpoint_safe_to_clear
//          === 1, set solely by the explicit signal_checkpoint MCP call and
//          unforgeable by the per-turn hook touch) AND that consent is fresh
//          AND the agent is idle right now, type /compact.
//
// The function is pure so the gate ordering + freshness + cooldown logic can be
// pinned by tests independently of the watcher's transcript/DB plumbing.

export type CompactAction =
  | { kind: "fire" } // genuine fresh consent + idle now → type /compact
  | { kind: "ask" } // high + idle + worth it + not spamming → type the ask
  | { kind: "skip"; reason: string };

export interface CompactDecisionInput {
  // Live idle read (last turn ENDED + quiet, not mid-tool-call). Re-checked at
  // decision time every tick, so a "fire" never lands on a now-busy agent even
  // if consent was given several turns ago.
  idle: boolean;
  // Shared-repo session we can't safely target — never act.
  ambiguous: boolean;
  // The DURABLE consent gate: checkpoint_safe_to_clear === 1. Set ONLY by an
  // explicit signal_checkpoint(safe_to_clear=true); the Stop hook's per-turn
  // touch cannot set it. This is the real "yes, compact me".
  safeToClear: boolean;
  // Age of the consent stamp (now - checkpoint_consent_ts), or null if the
  // agent has never consented. Distinct from checkpoint_ts age, which the hook
  // bumps every turn and so cannot tell us how old the YES is.
  consentAgeMs: number | null;
  // Freshness window for a consent to remain fire-eligible.
  consentFreshMs: number;
  // Compacting is economically worth the turn the ASK costs (actively
  // progressing AND projected savings beat handshake overhead). Gates the ASK
  // only — once consent is given, the decision to compact is already made.
  economicGreen: boolean;
  // Time since this agent was last ASKED, or null if not asked this session.
  // Throttles re-asking; does NOT throttle firing.
  msSinceLastAsk: number | null;
  askCooldownMs: number;
}

// Precedence: ambiguous → FIRE (durable consent) → ASK (throttled) → skip.
// FIRE is evaluated BEFORE the ask-cooldown so a yes is never starved by the
// throttle that exists only to stop us re-asking every tick. A fresh consent
// with no prior ask still fires — an agent that volunteered safe_to_clear=true
// on its own is just as valid as one answering our prompt.
export function decideCompactAction(i: CompactDecisionInput): CompactAction {
  if (i.ambiguous) return { kind: "skip", reason: "ambiguous-session" };

  const consentFresh =
    i.safeToClear && i.consentAgeMs !== null && i.consentAgeMs < i.consentFreshMs;
  if (consentFresh) {
    // Consent is necessary, not sufficient — re-check idle at FIRE time.
    if (!i.idle) return { kind: "skip", reason: "consented-but-not-idle" };
    return { kind: "fire" };
  }

  // No fire-eligible consent → consider asking. Asking costs the agent a turn,
  // so only when idle (won't interrupt) and economically worth it.
  if (!i.idle) return { kind: "skip", reason: "not-idle" };
  if (!i.economicGreen) return { kind: "skip", reason: "economics-below-overhead" };
  if (i.msSinceLastAsk !== null && i.msSinceLastAsk < i.askCooldownMs)
    return { kind: "skip", reason: "ask-cooldown" };
  return { kind: "ask" };
}
