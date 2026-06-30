// Manual-override decision core — pure logic for a founder-initiated /compact
// or /clear handshake, triggered by a Command Center button rather than the
// occupancy threshold.
//
// A click is EXPLICIT per-terminal authorization, so the autonomous path's
// gates — occupancy threshold, economics, the fail-closed allowlist — are all
// bypassed. What remains are the SAFETY gates, and they are non-negotiable:
//
//   • never act on an ambiguous (shared-repo) session,
//   • never interrupt work — only when the agent is idle at a turn boundary,
//   • FIRE only on a GENUINE consent (checkpoint_safe_to_clear === 1, set solely
//     by an explicit signal_checkpoint(true)) that POSTDATES the request — so we
//     ask first and fire on the agent's acknowledgement, never on a stale yes it
//     happened to leave at an earlier, unrelated rest point,
//   • for the destructive /clear, additionally require a verified-fresh handoff,
//   • expire a forgotten request rather than fire it hours later.
//
// Kept pure so the postdate discriminator and the clear-needs-handoff gate —
// both safety-critical and new — can be pinned by tests independently of the
// watcher's transcript/DB plumbing (mirrors compact-decision.ts).

export type ManualAction =
  | { kind: "fire"; command: "/compact" | "/clear" } // postdated consent + idle (+ handoff for clear)
  | { kind: "ask" } // no postdated consent yet → type the ask, throttled
  | { kind: "skip"; reason: string };

export interface ManualDecisionInput {
  // What the founder asked for on this terminal.
  requested: "compact" | "clear";
  // Live idle read (last turn ENDED + quiet, not mid-tool-call), re-checked at
  // decision time so a fire never lands on a now-busy agent.
  idle: boolean;
  // Shared-repo session we can't safely target — never act.
  ambiguous: boolean;
  // Durable consent gate: checkpoint_safe_to_clear === 1. Set ONLY by an
  // explicit signal_checkpoint(safe_to_clear=true).
  safeToClear: boolean;
  // When that consent was stamped (checkpoint_consent_ts, ms), or null if never.
  consentTs: number | null;
  // When the founder clicked (manual_action_ts, ms). Consent only counts if it
  // POSTDATES this — a yes given before the ask is not a yes to this ask.
  requestedTs: number;
  // A verified-fresh handoff file is on record. Required for /clear (destructive,
  // no in-place summary); advisory for /compact.
  handoffOk: boolean;
  // Time since this agent was last ASKED this session, or null if not yet asked.
  // Throttles re-asking; does NOT throttle firing.
  msSinceLastAsk: number | null;
  askCooldownMs: number;
  // Age of the pending request (now - requestedTs). Past ttl → expire.
  ageMs: number;
  ttlMs: number;
}

// Precedence: expire → FIRE (non-ambiguous + postdated consent + idle [+ handoff
// for clear]) → ASK (idle, throttled) → skip. FIRE is evaluated before the ask
// cooldown so an acknowledgement is never starved by the re-ask throttle.
//
// AMBIGUITY gates FIRE, not ASK. A parked terminal in a shared repo goes
// transcript-stale and reads as ambiguous, but the ASK only types a consent
// prompt, and injection targets by tty/pane (exact per-terminal) — never by the
// ambiguous transcript. The agent's reply + signal_checkpoint then refreshes the
// transcript and clears ambiguity before any FIRE. So ambiguity must not starve
// the ask (the very thing that wakes a parked terminal); it stays a hard stop on
// FIRE as belt-and-suspenders. Same safety envelope as the parked-idle relaxation.
export function decideManualAction(i: ManualDecisionInput): ManualAction {
  // A long-forgotten click must not fire later — drop it.
  if (i.ageMs > i.ttlMs) return { kind: "skip", reason: "expired" };

  // POSTDATED genuine consent: the agent said yes AFTER we asked (for this
  // request), not at some earlier unrelated checkpoint. Pre-existing consent is
  // deliberately excluded so the prompt is never skipped.
  const consentPostdates =
    i.safeToClear && i.consentTs !== null && i.consentTs > i.requestedTs;

  if (consentPostdates) {
    // Never inject /compact|/clear into a session we can't confirm. In practice
    // the postdating consent has just refreshed the transcript, so this rarely
    // trips — but it stays as a hard safety stop on the destructive action.
    if (i.ambiguous) return { kind: "skip", reason: "ambiguous-session" };
    // Consent is necessary, not sufficient — re-check idle at FIRE time.
    if (!i.idle) return { kind: "skip", reason: "consented-but-not-idle" };
    // Destructive /clear: only against a verified handoff written for THIS
    // request (consent_ts > requestedTs guarantees the handoff_path stamped in
    // the same signal_checkpoint call is the one for this clear, not a stale one).
    if (i.requested === "clear" && !i.handoffOk)
      return { kind: "skip", reason: "clear-needs-verified-handoff" };
    return { kind: "fire", command: i.requested === "clear" ? "/clear" : "/compact" };
  }

  // No fire-eligible consent yet → ASK. Only when idle (won't interrupt), and
  // throttled so we don't re-ask every tick while waiting for the agent.
  if (!i.idle) return { kind: "skip", reason: "not-idle" };
  if (i.msSinceLastAsk !== null && i.msSinceLastAsk < i.askCooldownMs)
    return { kind: "skip", reason: "ask-cooldown" };
  return { kind: "ask" };
}
