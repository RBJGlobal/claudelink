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
  // A /compact was typed to this agent moments ago (see inFireQuiet). Holds
  // back the ASK only.
  fireQuiet?: boolean;
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
  if (i.fireQuiet) return { kind: "skip", reason: "fire-quiet" };
  if (i.msSinceLastAsk !== null && i.msSinceLastAsk < i.askCooldownMs)
    return { kind: "skip", reason: "ask-cooldown" };
  return { kind: "ask" };
}

// Quiet period after a FIRE. For 30 to 60 s after /compact is typed the
// transcript still shows the pre-compact size, so the next tick would see
// "over threshold, no consent" and ask again while the compact is running
// (seen 2026-11-20: fire at 15:37:31Z, a second ask at 15:38:03Z). A short
// dedicated quiet period covers that window. It is separate from the ask
// cooldown on purpose: the cooldown is as long as a founder click lives
// (30 min), so reusing it would let a click made soon after a fire expire
// before its consent prompt was ever typed. This only ever suppresses an ASK;
// neither decision function reads it on the FIRE branch.
export const FIRE_QUIET_MS = 5 * 60 * 1000;

// lastFiredAt after a fire attempt: a keystroke that landed ("ok") or may have
// landed ("unknown") starts the quiet period; one that did not leaves it alone.
export function firedAtAfter(result: string, nowMs: number, lastFiredAt: number): number {
  return result === "ok" || result === "unknown" ? nowMs : lastFiredAt;
}

export function inFireQuiet(lastFiredAt: number, nowMs: number, quietMs = FIRE_QUIET_MS): boolean {
  return lastFiredAt > 0 && nowMs - lastFiredAt < quietMs;
}
