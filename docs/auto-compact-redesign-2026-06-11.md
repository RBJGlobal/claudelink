# Auto-Compact Standing-On Redesign — 2026-06-11 Planning Pass

> **Status:** Planning only. No code changes from this doc. Architect review complete (Plan subagent). Founder Advisor fleet-perspective consult: pending reply, will fold in when it arrives.
>
> **Purpose:** Canonical record of what to do differently for the next standing-on rollout attempt.

---

## 1. Why this doc exists

On 2026-05-30 we armed the standing-on autonomous compact for a 3-worker allowlist (Whisprdesk Developer, iLoveMD Developer, Global Sites Developer). Over the week+ since arming, **zero autonomous fires** landed. The only successful armed fire was the supervised one-shot on Global Sites Developer the morning of arming (611K → 13K, 97.8% reduction, 1-turn recovery, 0 rework) — a hand-driven calibration shot, not the autonomous path.

The founder's read at pickup (2026-06-11): the `thresholdTokens=200000` was sized for Sonnet 200K windows. Most fleet agents are now Opus 4.8 (1M context), so 200K is 20% of available — agents have no felt urgency to act on the protocol. He asked for planning, not development.

This doc is the result of the planning pass: an architect (Plan subagent) review + my own context from the original soak + (pending) Founder Advisor fleet perspective.

---

## 2. What we already know (the evidence ledger)

From the documented 2026-05-30 soak on iLoveMD Developer (opus-4-8, 1M context):

- ✅ New CHECKPOINT_INSTRUCTIONS text reached the agent on a fresh MCP session (verified via PID restart + behavioral test post-restart)
- ✅ Tool channel works end-to-end when explicitly prompted: signal lands in DB, gates flip green, fire-skip logic correctly enforces handoff_path
- ❌ Agent grew context to 290K, sat idle for 7+ min at clear end_turn rest point, never autonomously called `signal_checkpoint`
- ❌ When prompted, the test call used `safe_to_clear=false` + no handoff_path — fire correctly refused, but this revealed `handoff_path` failure is silent to the agent
- ❌ Over the entire week+ standing-on window: zero autonomous fires on any of the 3 allowlisted workers

The instructions-text-alone hypothesis is empirically dead.

---

## 3. Where the design actually fails (architect findings)

Plan's review surfaced gaps I hadn't seen:

### 3.1 `thresholdTokens=200000` is legacy — it's not the live armer

`thresholdTokens` (in `src/context-watcher-settings.ts:42,68`) is explicitly "retained for the projection baseline" — used only in `projectCompactOpportunity()` for the dashboard's retrospective what-if cost view (`src/context-watcher.ts:219-309`). **It does not appear in the live-fire gate path at all.**

The real armer is the **economic trigger** at `src/context-watcher.ts:413-415`:
```
perTurnCostUsd = (contextTokens * cacheReadPrice) / 1_000_000
must exceed dollarPerTurnThreshold (default $0.27)
```

For Opus (cache-read $1.50/Mtok per `src/usage-reader.ts:48`), $0.27/turn ≈ **180K tokens of context**. So the live trigger is effectively "Opus context > 180K" — 18% of a 1M window, exactly the "felt low urgency" zone the founder described.

**The founder's intuition was right about the dimension. He was right about wrong knob.**

### 3.2 The agent has no contextual signal about token count

The current CHECKPOINT_INSTRUCTIONS (`src/index.ts:110-119`, rewritten in commit `4a08a00`) tells agents to call "at every natural rest point… any time it's been many turns since your last call" — **with no token reference at all**. The agent has no felt connection between context size and urgency. So scaling whatever threshold doesn't even reach the agent's reasoning loop, because the agent isn't applying a threshold — the system is.

### 3.3 `MAX_TURNS_SINCE_SIGNAL = 5` is too tight for Opus's quick-turn rhythm

`freshConsent` is turn-based (`src/context-watcher.ts:48`): the signal stales after 5 real turns. An Opus agent doing 5 quick small follow-ups (e.g., reviewing PR comments one at a time) goes stale fast, even at a clean boundary. *The cheaper Opus chats, the faster consent expires* — an anti-pattern for the deployment reality.

### 3.4 `handoff_path` failure is silent

`verifyHandoff` (`src/compact-executor.ts:70-77`) requires the path to exist AND be >200 bytes. If the agent calls `signal_checkpoint` with `handoff_path="none"` or any non-existent file, `verifyHandoff` returns `ok:false`, the gate quietly skips, and **the agent is never told the signal was useless**. This is the highest-friction surface in the protocol — agents that try and fail get no feedback to try differently next time.

### 3.5 The gate stack's interactions are subtle

The full gate conjunction (`src/context-watcher.ts:485-493`): `idle && freshConsent && handoffOk && !ambiguous`. Plus implicit `activelyProgressing` (last turn within 15 min) for the economic trigger to even fire. The combination "recently working but currently idle" is a narrow window — most observed gate failures during the soak were `handoffOk=false` and `freshConsent=false`, never the idle/ambiguous pair.

---

## 4. What to do differently — concrete recipe

In priority order. None of this is code yet; this is what the next implementation pass should target.

### 4.1 Replace `dollarPerTurnThreshold` with `contextOccupancyThreshold`

Express the armer as a **fraction of the model's context window** rather than a dollar amount.

- Default: `contextOccupancyThreshold = 0.25` (25% of model window)
- For Opus 4.8 (1M): triggers at 250K context
- For Sonnet 4.6 (200K): triggers at 50K
- Keep a `minPerTurnCostUsd` floor (say $0.15) so a Haiku agent at 25% doesn't trigger spuriously

This requires a model → context-window-size table, naturally placed next to `PRICES` in `src/usage-reader.ts`. Cleanly retrofits the existing `latestTurnEconomics` model-string output.

Keep `thresholdTokens` as a hard ceiling for the legacy projection only.

### 4.2 Add a Stop-hook checkpoint nudge

The Stop hook (`src/hooks/stop-hook.ts`) is the only place that runs *inside the agent's loop boundary*. Everything else (scheduler keystroke, AppleScript inject) is exogenous and racy.

After the existing inbox decision:
- Check turns since last `signal_checkpoint` AND current context occupancy
- When both exceed thresholds (e.g., 20+ turns AND 40%+ occupancy):
  - **autonomous_reply=0 path:** stderr-emit a directive
  - **autonomous_reply=1 path:** when no inbox eligible-message would fire, emit a `decision:"block"` directive
- Directive text: *"Your context is at X% of model capacity (~$Y/turn) and you have not checkpointed in N turns. If you are at a safe stopping point, write a handoff to {{PATH}} and call signal_checkpoint with that path and safe_to_clear=true."*
- Rate-limit: max 1 nudge per 5 turns per agent (extend cap-state)
- Back off entirely after 3 unanswered nudges in a row → surface in dashboard as "checkpoint protocol unresponsive"

### 4.3 Pre-create the handoff stub

The agent's #1 friction is deciding *where* to write and *what* to write. Pre-emptively lay it down:
- When the Stop-hook nudges, also write or refresh a stub at `handoffPathFor(agentId)` (already exists in `src/compact-executor.ts:47`)
- Stub content from `HANDOFF_TEMPLATE` (`src/compact-executor.ts:32-45`) — placeholder sections agent can fill
- Pass the path explicitly in the nudge directive
- Agent friction drops from "decide where + write content + call tool" to "fill in template + call tool"
- `handoffOk`'s >200-byte check already passes a half-filled handoff

`handoffPathFor` lives under `~/.claudelink/handoffs/` so we never write into the agent's repo. Document that explicitly.

### 4.4 Loosen `freshConsent` to a hybrid time+turn rule

Replace `turnsSinceSignal ≤ 5` with:
```
(turnsSinceSignal ≤ 10) OR
(wallClockSinceSignal ≤ 20 min AND no tool_use since signal)
```

The "no tool_use since signal" piece is the real safety property: if the agent only chatted in follow-up turns, no in-flight state was created, so the signal is still meaningful. Requires tracking the *index* of the signal turn during the transcript scan (modest change in `armGate`).

### 4.5 Add per-tick gate-status logging — measure success in 24h, not a week

Add a new log line type emitted **every tick** for armed allowlist agents:
```
gate-status role=X arming=B signal_age_turns=N signal_age_min=M handoff_ok=B idle=B ambiguous=B occupancy_pct=N
```

Grep-able, per-agent, per-tick. Success criteria for the next rollout: **within 24h, at least 2 of 3 allowlisted agents reach all-green at least once** (whether or not we fire). If still zero all-greens at 24h, the gate stack — not the threshold — is wrong, and we abort and re-design rather than wait another week.

---

## 5. Risks and mitigations

### 5.1 False-positive fires (founder's red zone)

The new occupancy-fraction trigger could fire on a long-running Opus agent doing a single coherent unit of work. The `idle` + `handoffOk` + `freshConsent` gates still hold; residual risk is the agent *believing* it's at a safe point but actually having critical state in scratchpad memory the handoff omits.

**Mitigations:**
- Keep `oneShot:true` (single autonomous fire then auto-disarm) for the first 2 weeks of any new config
- Extend `verifyHandoff` to require a minimum *count* of the four template sections, not just byte size
- Add a `recent_tool_use` check — refuse to fire if any `tool_use` occurred in the last 3 turns since the signal, even if signal is fresh

### 5.2 Stop-hook nudge becoming spam

If the agent ignores the nudge, the next turn-end re-fires it. This pollutes the agent's context with repeated directives that themselves grow context.

**Mitigations:**
- Cooldown on nudges (5 turns or 10 min between per agent)
- Back off entirely after 3 unanswered nudges in a row
- Surface unresponsive agents in the dashboard for operator intervention

### 5.3 Stub handoff pre-creation visibility

Writing into `~/.claudelink/handoffs/` is fine, but document explicitly that we never write into the agent's repo. The stub path should always start with the home dir, never inside any project directory.

### 5.4 Hybrid `freshConsent` transcript re-scan cost

The "no tool_use since signal" rule requires re-scanning the transcript from the signal turn onward. Already happening in `armGate` (line 314), so the additional cost is modest — but the check needs to *remember the index* of the signal turn, not just count past it. Flag for implementer.

### 5.5 Per-model context-window table maintenance

Model windows aren't static (Opus 4.7 → 4.8 was a 1M extension). The lookup table in `src/usage-reader.ts` will drift as Anthropic ships new models. Mitigation: when an unknown model is encountered, fall back to a conservative 200K window assumption + log a warning so we know to update the table.

---

## 6. Critical files for the implementation pass

- `src/context-watcher.ts` — economic trigger logic, gate stack, freshConsent rule
- `src/context-watcher-settings.ts` — config schema (add `contextOccupancyThreshold`, `minPerTurnCostUsd`)
- `src/hooks/stop-hook.ts` — checkpoint nudge insertion point
- `src/index.ts` — possibly tighter tool description on `signal_checkpoint`; maybe add the stub handoff hint into CHECKPOINT_INSTRUCTIONS
- `src/usage-reader.ts` — model → context-window-size table
- `src/compact-executor.ts` — handoff stub pre-creation (`handoffPathFor` already exists)
- `src/cap-state.ts` — extend for per-agent nudge cooldown

---

## 7. Founder Advisor — fleet-perspective additions

Folded in from Founder Advisor's reply (2026-06-11). Their data-scope caveat up front: their fleet visibility is heavy on Clawdemy authoring, where typical context is 50-120K and 200K is rare — so they have limited direct soak data on Whisprdesk/Global Sites/iLoveMD behavior specifically. Their inputs below are architecture-level + cross-fleet pattern reads, not first-hand observation of the failed standing-on.

### 7.1 Concrete threshold formula

Founder Advisor recommends `threshold = max(0.5 × model_window, 100K_floor)`:
- Sonnet 4.6 (200K) → 100K threshold (50%, hits the floor)
- Opus 4.7/4.8 (1M) → 500K threshold (50%)
- Haiku (~200K) → 100K threshold (50%, hits the floor)

Rationale: 50% is the rough "half-full → start watching" intuition. The 100K floor catches small-window edge cases. Per-model proportion is more robust than a hard cap because the model fleet will keep growing.

**More aggressive than my §4.1 default of 0.25.** Founder will need to pick between 25% (earlier intervention, more false-positive risk) and 50% (later intervention, less noise). Recommend 50% for initial standing-on rollout to minimize false-fire risk in the soak window; can tighten later once we have loss data.

### 7.2 The "instruction recall" reframing of the uptake gap

Founder Advisor reframes the agent-uptake problem as instruction RECALL, not instruction COMPREHENSION. The MCP `initialize` instructions load once at session start; long sessions drift far from that context as the transcript accumulates. "The agent has the tool; it's just not pattern-matching 'I should use it now.'"

This is a different angle on the same conclusion Plan reached via Stop-hook nudges (§4.2). Both point to: **periodic in-session reinforcement of the protocol, not just one-time delivery at MCP-init.** The Stop-hook is one delivery vector; system-reminder-style mid-session injection is another. Both should be on the table.

### 7.3 "Three layers of self-noticing" — the uptake friction surface

Founder Advisor's diagnostic frame for why instruction-text-alone fails:

The agent must (i) notice context is heavy, (ii) classify the situation as appropriate for the tool, (iii) interrupt the task to act. Miss rates compound across the three layers — even if each layer is 70% accurate, end-to-end uptake is only ~34%.

Plan's §4.2 (Stop-hook nudge) and §4.3 (stub handoff) explicitly address layers (i) and (iii): the system does the noticing, and pre-creates the handoff to reduce the interrupt cost. Layer (ii) — classifying the situation as tool-appropriate — is what the nudge directive's wording does. **The full proposal addresses all three layers in concert, which is why it should be evaluated as a stack, not as three independent options.**

### 7.4 Additional measurement: ambiguity-flag false-positive rate

Founder Advisor flagged: a false-positive rate on the ambiguity flag above ~5% will create noise that trains agents (and users) to ignore the signal. Worth measuring explicitly from soak logs — not just whether it skipped, but whether the skips were correct.

**Action for next implementation pass:** add to the per-tick gate-status log (§4.5) a `ambiguous_reason` field when ambiguity is true, plus a periodic audit query that samples N ambiguous skips and asks the operator to label them. Quantifies the false-positive rate.

### 7.5 Edge case: MCP-session-start baseline reset

Founder Advisor flagged a potential bug: if an MCP session starts mid-task (agent crashed and resumed), does the watcher get the correct baseline for "context-at-session-start," or does it inherit stale state from the prior session? Could create cases where threshold-relative-to-baseline computes wrong.

**Action for next implementation pass:** add a unit test that simulates MCP-session-restart with a partial transcript replay, asserting baseline correctness. If the bug exists, fix in same pass.

### 7.6 Suggested next data-collection step (NOT urgent)

Founder Advisor suggests pinging Whisprdesk Developer + Global Sites Developer + iLoveMD Developer directly with "did you ever observe an autonomous signal_checkpoint call (vs explicit user prompt)?" Gives N=3 grounded data points instead of relying on Founder Advisor's narrow Clawdemy-focused observation.

**Note:** likely yields confirmation of zero autonomous calls + low-signal self-explanation from the agents ("I had the tool, didn't call, not sure why"). Probably not worth the interrupt cost during active work. Defer until founder picks this work up again; if helpful then, the founder can authorize.

### 7.7 Pending: Founder Advisor's formal 1-page writeup

Founder Advisor offered to send a focused "advisor-perspective recommendations" doc. Accepted. Will append as §9 when it arrives.

---

## 8. Decision points for the next pickup

**Sequencing note (from §9.1):** Founder Advisor's writeup reframes the rollout ordering. The implementation pass should NOT bundle all of §4 at once. Recommended sequence:

- **Instrument first** (§9.1 Step 1 + §4.5) — 2 days of baseline data before any threshold/nudge change. Without this, every change is unfalsifiable.
- **Then the cheap threshold fix** (§4.1 + §9.1 Step 2) — high-probability partial gap-closure
- **Then test graded nudges** (§9.1 Step 3 supersedes §4.2 — graded 50/75/90/100% escalation is a better design than the original single-nudge proposal)
- **Only if Steps 2+3 insufficient: structural pause-point fix** (§9.1 Step 4)

When founder picks this up again, the decisions to greenlight:

1. **Pick the threshold formula.** Recommended: Founder Advisor's `max(0.5 × model_window, 100K)` with the per-model lookup table from §9.1 Step 2. Earlier alternative (Plan's 0.25) on the table if 0.50 turns out to be too late in baseline data.
2. **Greenlight the instrumentation-first sequencing** (§9.1 Step 1) — including denominator filtering on autonomous-call rate (§9.4) so we measure correctly.
3. **Greenlight the graded escalating nudge** (§9.1 Step 3) — replaces §4.2's single-nudge model. Test as A/B against threshold-only.
4. **Decide on the handoff stub pre-creation** (§4.3) — slightly more intrusive (writes to disk on every nudge); worth a yes/no.
5. **Greenlight the per-tick gate-status logging + 24h success criterion** (§4.5) — same-day evaluation rather than week-long mystery.
6. **Greenlight ambiguity-flag false-positive sampling** (§7.4) and the MCP-session-restart unit test (§7.5).
7. **Decide whether Step 4 (structural pause-point injection)** is on the explicit roadmap or only triggered conditionally on Steps 2+3 failing.
8. **Pick the test allowlist for the re-rollout** — same 3 workers? Different subset?
9. **Decide whether to do the §7.6 data-collection ping** to Whisprdesk/Global Sites/iLoveMD, or skip.

Anti-recommendations from §9.2 are red-lines worth re-reading before any design discussion:
- Don't fork the tool surface into more sub-tools
- Don't move to mandatory compaction at threshold
- Don't blame the model

Implementation estimate: instrumentation pass is 1 session (mostly logging additions). Threshold + graded nudge pass is 1-2 sessions. Step 4 (structural) is a separate design exercise, not a coding task.

## 9. Founder Advisor's formal recommendations writeup

Received 2026-06-11 06:05. Lightly edited for doc consistency; substance preserved.

### 9.1 Recommended sequencing — what to test first, what to defer

The redesign has many possible levers. Some are cheap and high-probability; some are high-effort and experimental. Sequence matters because the cheap ones may close the gap and make the expensive ones unnecessary.

**Step 1 — Instrument before changing anything.** The current data is "we observed zero autonomous calls on iLoveMD; unknown elsewhere." That's not enough to evaluate any fix. Before shipping a new threshold formula, instrument:

- **Autonomous-call rate** — % of post-threshold-cross moments where the agent calls `signal_checkpoint` without user prompt. Per-agent + fleet aggregate.
- **Time-to-first-autonomous-call** — from threshold cross to first call. Distribution, not just mean.
- **Ambiguity-flag false-positive rate** — from soak logs; categorize by type.
- **Cross-session correlation** — does an agent that called autonomously once tend to call again? Tells us whether recall is uniform-low or bimodal.

Two days of instrumented baseline gives real ground truth to evaluate Steps 2-4 against. Without it, every change is unfalsifiable.

**Step 2 — Per-model proportional threshold (the cheap win).** Detailed in §7.1. Implementation shape:

```ts
const THRESHOLDS: Record<string, number> = {
  "claude-sonnet-4-6": 100_000,    // 50% of 200K
  "claude-opus-4-7":   500_000,    // 50% of 1M
  "claude-opus-4-8":   500_000,    // 50% of 1M
  "claude-haiku-4-5":  100_000,    // 50% of 200K, hits floor
};
const DEFAULT = (window: number) => Math.max(Math.floor(window / 2), 100_000);
```

Lookup-first-then-fallback; new models added to the lookup as they land. Server-side change in the watcher; no agent-side rollout needed; deployable without breaking existing sessions.

High probability of partially closing the gap. Won't fully close it (instruction-recall is orthogonal), but removes the "20% of window, why act?" objection cleanly.

**Step 3 — Threshold-relative escalating nudge (medium effort, experimental).** Once Step 2 lands, the periodic-nudge hypothesis becomes testable:

- At 50% of threshold: silent (no injection)
- At 75% of threshold: light system-reminder injection — *"Context is moderate. Consider whether you've reached a natural checkpoint."*
- At 90% of threshold: heavier injection — *"Context is heavy. Recommend calling `signal_checkpoint` at the next natural pause."*
- At 100% of threshold: existing watcher behavior

Graded escalation gives the agent multiple shots at noticing without the heavy injection arriving like a thunderclap. Test as A/B against Step 2 alone — does the escalating nudge actually raise autonomous-call rate? If yes, ship. If no (agents still don't act), the problem is deeper than nudge frequency and Step 4 becomes load-bearing.

**Step 4 — Piggyback on natural pause points (higher effort, structural).** If Steps 2 and 3 don't close the gap, the "three layers of self-noticing" problem (§7.3) points to a structural fix: don't ask the agent to interrupt its task to do meta-housekeeping. Inject the checkpoint consideration into a beat the agent is already taking.

Specifically: between user-prompt-submit and first tool call, the agent has a natural "what am I about to do?" beat. If the watcher injects a checkpoint-relevant signal AT THAT BEAT (not mid-task), the agent's task-frame already includes a planning step the meta-action can piggyback on. The barrier is much lower than "interrupt yourself mid-task."

Significantly more design work (instrumentation of "natural beats," interaction with existing turn structure). Worth only if Steps 2 + 3 demonstrably insufficient.

### 9.2 Anti-recommendations

- **Don't fork the tool surface into more sub-tools.** Adding `check_context` / `propose_checkpoint` / `confirm_checkpoint` tools doesn't help recall and adds complexity. Single `signal_checkpoint` is right.
- **Don't move to mandatory compaction at threshold.** Killing agent autonomy at threshold kills the design philosophy and creates bad UX. Keep autonomy; improve the nudge.
- **Don't blame the model.** Instruction surface and timing are the load-bearing levers. Designing the harness right is cheaper and more reliable than waiting for model improvements.

### 9.3 Architect-subagent questions still open

Three questions Founder Advisor's writeup doesn't fully resolve and which the next implementation pass should address before Step 4:

1. **What does "natural pause point" look like operationally?** End-of-turn? End-of-subtask? Specific tool-call patterns? Need a concrete definition before Step 4 is implementable.
2. **Threshold relative to TOKENS or WORK DONE?** A session can be 300K tokens of mostly-cached prompt-cache hits (cheap to continue) or 300K tokens of fresh work (expensive). Cost calculus differs; token-count may not be the right metric.
3. **Cost-vs-disruption tradeoff at 50% threshold.** Means more compactions per session. If sessions typically 3-5x the threshold, that's 3-5 compactions vs current ~1. Check that's the right cost shape.

### 9.4 Cross-product framing — denominator filtering

The standing-on feature is most valuable for long-running orchestration sessions (advisor terminals, lead terminals, anything that runs many hours). Least valuable for short tactical sessions. If most fleet sessions are short, autonomous-call rate will look low even with perfect design — no opportunity to call.

**Critical metric refinement:** autonomous-call rate should be measured ON SESSIONS THAT CROSS THRESHOLD, not on all sessions. Filter the denominator.
