# ClaudeLink — Backlog: OPEN

> **Snapshot:** 2026-06-12 overnight stabilization pass.
> **Branch:** `feat/fleet-token-meter` (24 commits, unmerged).
>
> Priority-ordered. The companion file `backlog-done.md` lists shipped + verified items.

---

## Priority key

- **P0** — Ship-blocker / safety-critical. Required before any next standing-on arming.
- **P1** — Standing-on rollout reliability. Do these alongside the next rollout pass.
- **P2** — Polish + observability + correctness cleanup.
- **P3** — Roadmap (v1.5+) — separate from the current Fleet Token Meter wave.

> "Open" includes items still in design (no code) and items partially built but gated. "Done" means shipped, working, or verified empirically. Crossovers (e.g., observe-only watcher) are listed Done where the observe path is verified and Open where the armed path is incomplete.

---

## P0 — Ship-blocker (do before any next standing-on arming)

### P0-1. Per-tick gate-status logging (instrument-first)
**Why:** the 2026-05-30 → 2026-06-11 standing-on produced **zero autonomous fires across 12 days** with effectively unknown failure mode. Without per-tick observability, every redesign is unfalsifiable. Redesign doc §9.1 Step 1 + §4.5.
**What:** emit a structured log line every watcher tick **for every armed-allowlist agent**:
```
gate-status role=X arming=B signal_age_turns=N signal_age_min=M handoff_ok=B idle=B ambiguous=B occupancy_pct=N
```
Grep-able, per-agent, per-tick. Audit log at `~/.claudelink/context-watcher.log`.
**Plus** denominator filtering on autonomous-call rate (§9.4): measure only on sessions that crossed threshold, not all sessions.
**Acceptance:** next rollout has 24h-success-criterion ground truth instead of week-long mystery. Concrete success criterion: within 24h, ≥2 of 3 allowlisted agents reach all-green at least once.
**Owner:** ClaudeLink developer · **Blocking:** nothing · **Est:** 1 session.

### P0-2. Per-model proportional threshold (the cheap win)
**Why:** the live armer (`dollarPerTurnThreshold = 0.27`) effectively triggers at ~180K Opus context = **18% of a 1M window** — exactly the "no felt urgency" zone the founder identified. Redesign doc §3.1 + §4.1 + §9.1 Step 2 + Founder Advisor §7.1.
**What:** replace `dollarPerTurnThreshold` with `contextOccupancyThreshold` expressed as fraction of model window. Founder Advisor's recommended formula:
```ts
const THRESHOLDS: Record<string, number> = {
  "claude-sonnet-4-6": 100_000,    // 50% of 200K
  "claude-opus-4-7":   500_000,    // 50% of 1M
  "claude-opus-4-8":   500_000,    // 50% of 1M
  "claude-haiku-4-5":  100_000,    // 50% of 200K, hits floor
};
const DEFAULT = (window: number) => Math.max(Math.floor(window / 2), 100_000);
```
Plus `minPerTurnCostUsd` floor (~$0.15) so Haiku at 50% doesn't spuriously fire. Keep `thresholdTokens` for dashboard projection only. Model→window lookup lives next to `PRICES` in `src/usage-reader.ts`. Unknown-model fallback: conservative 200K + log warning.
**Acceptance:** Sonnet armer at 100K, Opus armer at 500K, lookup-first-then-fallback. Settings UI exposes the threshold.
**Owner:** ClaudeLink developer · **Blocking:** P0-1 must land first to measure delta · **Est:** 1 session.

### P0-3. Silent handoff_path failure → surface to agent
**Why:** the agent calls `signal_checkpoint({safe_to_clear: true, handoff_path: "..."})`. If the path doesn't exist or is <200 bytes, `verifyHandoff` returns `ok:false`, the watcher silently skips, **and the agent gets a success response with no feedback their signal was useless.** Highest-friction surface in the protocol — observed 2026-05-30 on iLoveMD. Redesign doc §3.4.
**What:** the `signal_checkpoint` tool handler should call `verifyHandoff` synchronously when `handoff_path` is provided and `safe_to_clear=true`. If the handoff is invalid, return a tool error (not exception — a structured "handoff-not-ready" warning) so the agent's next turn can react. Calls without `handoff_path` continue to update the freshness signal without verification.
**Acceptance:** agent that calls with a bad path gets feedback in the tool response; agent that calls without a path is unchanged.
**Owner:** ClaudeLink developer · **Blocking:** nothing · **Est:** small.

---

## P1 — Standing-on rollout reliability

### P1-1. Pre-create handoff stub
**Why:** removes the "where do I write?" friction that's blocking adoption. The agent's path of least resistance becomes "fill in the template + call the tool" instead of "decide where + write content + call tool." Redesign doc §4.3.
**What:** when the Stop-hook (P1-3) decides to nudge, ALSO write or refresh a stub at `handoffPathFor(agentId)` (already exists at `src/compact-executor.ts:47`). Stub content from `HANDOFF_TEMPLATE`. Pass the path explicitly in the nudge directive. Stub lives under `~/.claudelink/handoffs/` — never inside the agent's repo.
**Acceptance:** stub exists pre-nudge; the >200-byte gate passes on a half-filled template.
**Owner:** ClaudeLink developer · **Blocking:** P1-3 lands first · **Est:** small.

### P1-2. Loosen `freshConsent` to hybrid time+turn rule
**Why:** `turnsSinceSignal ≤ 5` is too tight for Opus's quick-turn rhythm (the cheaper Opus chats, the faster consent expires — an anti-pattern). Redesign doc §3.3 + §4.4.
**What:** replace with:
```
(turnsSinceSignal ≤ 10) OR
(wallClockSinceSignal ≤ 20 min AND no tool_use since signal)
```
The "no tool_use since signal" piece is the real safety property. Requires tracking the index of the signal turn during transcript scan (modest change in `armGate`).
**Acceptance:** agent that signal_checkpoints then has 6 quick chat-only follow-ups within 20 min still passes freshConsent.
**Owner:** ClaudeLink developer · **Blocking:** P0-1 (instrumentation) so we can compare before/after · **Est:** medium.

### P1-3. Graded escalating Stop-hook nudge
**Why:** founder advisor and architect both converged on "instruction recall, not comprehension" — the agent has the tool, isn't pattern-matching when to call. The Stop hook runs inside the agent's loop boundary (only exogenous-free injection point we have). Redesign doc §4.2 + §9.1 Step 3.
**What:** after the existing inbox decision, check turns since last `signal_checkpoint` AND current context occupancy. Graded by % of threshold:
- 50% of threshold → silent (no injection)
- 75% → light system-reminder: *"Context is moderate. Consider whether you've reached a natural checkpoint."*
- 90% → heavier: *"Context is heavy. Recommend calling `signal_checkpoint` at the next natural pause."*
- 100% → existing armed behavior
**Plus** rate-limit: max 1 nudge per 5 turns per agent (extend `cap-state.ts`). Back off after 3 unanswered nudges → surface in dashboard as "checkpoint protocol unresponsive."
**Acceptance:** A/B against P0-2 (threshold only) — does graded nudge raise autonomous-call rate?
**Owner:** ClaudeLink developer · **Blocking:** P0-1 (measurement) + P0-2 (threshold formula needs to be right first) · **Est:** medium.

### P1-4. Retry-on-transient-fail in armed inject
**Why:** the 2026-05-29 ~05:24 first armed-fire attempt returned `spawnSync osascript ETIMEDOUT` (transient iTerm2 unresponsive). Current behavior: latches the one-shot anyway. Standing-on self-retries via cooldown, but a same-tick retry would be cleaner.
**What:** wrap `injectKeystroke` in 1-2 retries within the tick. Latch BEFORE the FIRST attempt (preserve crash-safe ordering from `7f9e0e7`). Log each attempt.
**Acceptance:** transient ETIMEDOUT no longer wastes the one-shot.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

### P1-5. Per-role coordinator threshold
**Why:** Founder Advisor + clawdemy-lead have different context economics than workers (longer orchestration sessions, different work shape). Current batch-1 was workers-only — coordinator threshold is the FOLLOW-UP, on-paper not built.
**What:** extend `context-watcher-settings.ts` with optional per-role threshold map; default falls back to global. Document the allowlist semantics: a role in the allowlist with no override uses the global threshold.
**Acceptance:** coordinator agents can have their own (higher) threshold.
**Owner:** ClaudeLink developer · **Blocking:** P0-2 (threshold formula) · **Est:** small.

### P1-6. Recovery Watcher false-fire tightening (older rate-limit patterns)
**Why:** observed 2026-05-29 ~10:38 — patterns hit false positives on agents *discussing* "API Error ... rate limit" in conversation, not actually halted. The new classifier pattern (`ad7ef82`) is structurally distinctive enough to avoid this; the older rate-limit patterns are not.
**What:** revisit ERROR_PATTERNS 2-5 in `src/recovery-watcher.ts`. The "API Error:" prefix design rule should be enforced *more strictly*: require the prefix to be at the START of a visible line, not anywhere within a 200-char window. Test against agents writing about ClaudeLink (the original false-positive shape: build-log writers describing rate-limit incidents).
**Acceptance:** no false fire on a synthetic "discussion case" with realistic chrome.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** medium (regression-test heavy).

### P1-7. Item 4 hook deployment broader coverage
**Why:** session-id capture only populates after each agent's Stop hook fires once on the new code. Still hook-enabled-agents-only; ambiguity persists for the 8-clawdemy shared-repo cluster until session-id capture covers them.
**What:** documentation + UI flag in Command Center showing which agents have populated session_id vs not. Per-agent "needs restart for session capture" banner. Don't auto-restart anything.
**Acceptance:** founder can see at a glance which agents still owe a Stop-hook fire.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

---

## P2 — Polish + observability

### P2-1. Ambiguity-flag false-positive sampling
**Why:** Founder Advisor §7.4 — false-positive rate >5% on ambiguity will train operators to ignore the signal.
**What:** log `ambiguous_reason` on every skip; periodic audit query that samples N ambiguous skips and asks the operator to label them. Quantifies the false-positive rate.
**Acceptance:** dashboard shows ambiguous-skip false-positive rate over the last 7 days.
**Owner:** ClaudeLink developer · **Blocking:** P0-1 (logging foundation) · **Est:** small.

### P2-2. MCP-session-restart baseline reset test
**Why:** Founder Advisor §7.5 — potential bug: if an MCP session starts mid-task (agent crashed and resumed), does the watcher get the correct baseline for "context-at-session-start" or does it inherit stale state from the prior session?
**What:** unit test (in the new test harness) that simulates MCP-session-restart with a partial transcript replay, asserting baseline correctness. If the bug exists, fix.
**Acceptance:** test passes; if a bug surfaces, code fix lands in the same pass.
**Owner:** ClaudeLink developer · **Blocking:** new test harness (Phase 4 of this overnight) · **Est:** small.

### P2-3. Apple Terminal support (Accessibility-permission gated)
**Why:** scheduler currently skips Terminal.app with `terminal_app="terminal"`. Same gap flagged across multiple sessions.
**What:** `claudelink doctor` command that detects Terminal.app, explains the System Events Accessibility permission, walks through granting it. No silent prompts.
**Acceptance:** doctor command exists; granting permission makes scheduler/recovery-watcher work on Terminal.app.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** medium.

### P2-4. Token-based UI auth
**Why:** anything on localhost can hit `/api/scheduler` POST and toggle the scheduler off. Personal-laptop scope makes this low priority, but worth noting.
**What:** lightweight bearer token stored at `~/.claudelink/ui.token`; CC asks for it on first load; localhost-only, no TLS.
**Acceptance:** unauthenticated POST returns 401.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

### P2-5. Backoff for stale unread (scheduler)
**Why:** if user is AFK, scheduler keeps typing every interval. Self-corrects when read, but noisy.
**What:** if same N unread messages pending for K cycles, fall back to slower cadence (or skip entirely until count changes).
**Acceptance:** scheduler.log shows "backoff: stale-unread" lines under simulated AFK.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

### P2-6. KeystrokeDispatcher mutex keyed by TTY
**Why:** scheduler + recovery-watcher + context-watcher could all want to inject into the same terminal in overlapping windows. Currently no coordination.
**What:** ~30-line mutex keyed by tty; serializes writes to a given terminal across all subsystems. Wrap `injectKeystroke` callers.
**Acceptance:** under stress, no two keystroke writes overlap on the same tty.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

### P2-7. Re-escalation interval for Recovery Watcher
**Why:** currently one-shot desktop notification on N consecutive fires. If API down for hours, silent after the first.
**What:** re-emit the desktop notification on a slower cadence (every 30 min) until error clears.
**Acceptance:** simulated hours-long API outage produces hourly nudges.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** small.

### P2-8. Async `execFile` for `captureScrollback` + `injectKeystroke`
**Why:** event-loop block of up to 42s per tick on 14-agent fleet under iTerm2 unresponsive conditions. Will surface as fleet scales. Architect HIGH from prior reviews.
**What:** swap `execFileSync` → `execFile` (promisified) + concurrency cap 4-6. Or: batched single AppleScript per tick returning `{tty: contents}` dict (more invasive but eliminates N-osascript fan-out).
**Acceptance:** tick stays sub-5s under simulated 14-agent fleet with 3 unresponsive iTerm2 sessions.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** medium.

### P2-9. "Last visible block above empty prompt" anchoring (Recovery Watcher)
**Why:** substring + position-threshold approach has been tuned 3x already (v1.4.0, v1.4.1, v1.4.2). Brittle.
**What:** anchor matches by finding "last visible block above the empty prompt line." Eliminates the position-threshold tuning entirely.
**Acceptance:** Recovery Watcher tests still pass; threshold constant removed.
**Owner:** ClaudeLink developer · **Blocking:** new test harness · **Est:** medium.

### P2-10. MCP `disallowedTools` server-level pattern audit
**Why:** Claude Code v2.1.172 (2026-06) fixed a bug where `mcp__server` patterns in `disallowedTools` were ignored. ClaudeLink itself isn't affected, but users may have had broken patterns that now work — could surprise.
**What:** doc note in README + CLAUDE.md about the new tool-permission `Tool(param:value)` wildcard syntax. No code change.
**Acceptance:** doc note exists.
**Owner:** ClaudeLink developer · **Blocking:** none · **Est:** trivial.

### P2-11. Operational: founder-playbook merge gate
**Why:** the branch is the largest unmerged work in the project's history (3157 lines). Merging without a founder review session is risky.
**What:** when standing-on rollout is verified clean, schedule a founder review session before merge. Capture merge criteria explicitly.
**Acceptance:** merge happens with explicit founder approval at a single point in time, not drift.
**Owner:** founder · **Blocking:** P0 items + P1 rollout success · **Est:** N/A.

---

## P3 — Roadmap (v1.5 multi-machine + structural work)

### P3-1. v1.5 broadcast fan-out at send time (DECIDED)
**Why:** v1.4.3's per-agent recheck is defense-in-depth; the root cause is the shared `messages.read` column on a single broadcast row. Decided design (HANDOVER prior session): insert N directed message rows at send time, same shape as `sendMessage`.
**What:** `broadcastMessage()` reads agents at send time (inside a transaction); inserts N rows. v1.4.3 recheck remains, becomes defense-in-depth.
**Acceptance:** broadcast race is impossible by construction; recheck still passes its tests.
**Owner:** ClaudeLink developer · **Blocking:** founder green-light on v1.5 timing · **Est:** medium.

### P3-2. NexusBackend interface extraction (v1.5 Phase 1)
**Why:** prep for hub-and-spoke. Pure local refactor; no breaking change.
**What:** extract a `NexusBackend` interface from `NexusDB`; provide a `LocalBackend` implementation that wraps the existing SQLite path. Future `RemoteBackend` calls the hub via HTTP.
**Acceptance:** test suite passes against both LocalBackend and a mock RemoteBackend.
**Owner:** ClaudeLink developer · **Blocking:** founder green-light on v1.5 timing · **Est:** large.

### P3-3. v1.5 spoke daemon
**Why:** Recovery Watcher + scheduler are already pure functions on `NudgeCandidate`. Port to spoke is clean once schema v5 lands.
**What:** small spoke daemon that polls hub's `/api/v1/...` and dispatches local keystrokes. Bearer token over LAN.
**Acceptance:** two-machine test: agent registered on host A, message routed via hub to spoke on host B, keystroke lands.
**Owner:** ClaudeLink developer · **Blocking:** P3-2 · **Est:** large.

### P3-4. Schema v5 (host column)
**Why:** `agents.host` enables routing in multi-machine.
**What:** additive column, populated on register from spoke daemon; legacy NULL = "hub" by convention.
**Acceptance:** clean v1→v4→v5 migration on existing live DB.
**Owner:** ClaudeLink developer · **Blocking:** P3-2 · **Est:** small.

### P3-5. Structural pause-point injection (auto-compact §4 Step 4)
**Why:** if P0-2 + P1-3 don't close the autonomous-call gap, the "three layers of self-noticing" problem (Founder Advisor §7.3) points to a structural fix: don't ask the agent to interrupt; inject the checkpoint signal at a natural pause beat (e.g. between user-prompt-submit and first tool call).
**What:** significantly more design work — instrumentation of "natural beats," interaction with existing turn structure. Worth only if Steps 2+3 demonstrably insufficient.
**Acceptance:** N/A — design exercise first, not a coding task.
**Owner:** ClaudeLink developer + architect + Founder Advisor · **Blocking:** P1-3 results · **Est:** TBD.

### P3-6. Threshold-relative-to-WORK-DONE (not tokens)
**Why:** Founder Advisor §9.3 — a session can be 300K tokens of mostly-cached prompt-cache hits (cheap to continue) or 300K tokens of fresh work (expensive). Cost calculus differs.
**What:** consider a "fresh tokens since last compact" metric, separately from raw context size. Could feed the threshold or supplement it.
**Acceptance:** design pass; possibly empirical data first.
**Owner:** ClaudeLink developer + architect · **Blocking:** P0-1 data + P0-2 baseline · **Est:** design.

---

## Data-collection (not urgent, founder-authorized only)

### D-1. Founder human label on Global Sites Developer post-compact behavior
**Why:** the 2026-05-29 supervised compact reduced 611K → 13K with 1-turn recovery, 0 rework. **Did it lose anything?** First calibration data point + case-study seed. Awaiting founder's qualitative read.
**Owner:** founder.

### D-2. Worker survey (§7.6 from redesign doc)
**Why:** Founder Advisor §7.6 suggests pinging Whisprdesk + Global Sites + iLoveMD with "did you ever observe an autonomous `signal_checkpoint` call?" Likely yields confirmation of zero + low-signal self-explanation. Probably not worth the interrupt cost during active work. Defer until founder picks this up.
**Owner:** founder (authorization) → ClaudeLink developer (dispatch).

### D-3. Founder Advisor's formal 1-page writeup follow-on
**Why:** Founder Advisor offered to send a focused "advisor-perspective recommendations" doc and partially delivered (§9 of the redesign doc). Any follow-on additions land in §9 of `docs/auto-compact-redesign-2026-06-11.md`.
**Owner:** Founder Advisor.

---

## Pending founder/advisor decisions (from HANDOVER + redesign §8)

1. **Pick the threshold formula** — recommended: Founder Advisor's `max(0.5 × model_window, 100K)` (P0-2). Alternative: architect's 0.25 if 0.50 turns out too late.
2. **Greenlight instrumentation-first sequencing** — P0-1 lands before any threshold/nudge change. Includes denominator filtering on autonomous-call rate (§9.4).
3. **Greenlight graded escalating nudge** — P1-3, replaces single-nudge model. Test A/B against threshold-only.
4. **Handoff stub pre-creation** (P1-1) — slightly more intrusive (writes to disk on every nudge). Yes/no.
5. **Per-tick gate-status logging + 24h success criterion** (P0-1).
6. **Ambiguity-flag false-positive sampling** (P2-1) + MCP-session-restart unit test (P2-2).
7. **Whether P3-5 (structural pause-point injection) is on the explicit roadmap** or only triggered conditionally on P0-2+P1-3 failing.
8. **Test allowlist for the re-rollout** — same 3 workers (Whisprdesk, iLoveMD, Global Sites)? Different subset?
9. **Whether to do the D-2 worker survey ping**, or skip.
10. **Local build + install + UI restart** for an interactive live demo — not done unprompted; restarts CC which touches the running fleet.
11. **Per-agent attribution within shared project dirs** (8 clawdemy agents share one repo → currently aggregated at project level; true split needs broader Item 4 hook deployment).
12. **`npm publish`** — founder OTP gate; held until standing-on rollout completes a clean supervised soak + loss data is collected.

---

## Anti-recommendations (from Founder Advisor §9.2 — RED LINES)

These are explicitly OUT of scope, surfaced here so they don't sneak back in:

- ❌ **Don't fork the tool surface into more sub-tools.** Adding `check_context` / `propose_checkpoint` / `confirm_checkpoint` tools doesn't help recall and adds complexity. Single `signal_checkpoint` is right.
- ❌ **Don't move to mandatory compaction at threshold.** Killing agent autonomy at threshold kills the design philosophy and creates bad UX. Keep autonomy; improve the nudge.
- ❌ **Don't blame the model.** Instruction surface and timing are the load-bearing levers. Designing the harness right is cheaper and more reliable than waiting for model improvements.
