# ClaudeLink — Backlog: DONE

> **Snapshot:** 2026-06-12 overnight stabilization pass.
> **Branch:** `feat/fleet-token-meter` (24 commits, unmerged).
> **Public state:** `claudelink@1.4.3` on npm.
>
> This file lists everything that has shipped or been built+verified. The companion file `backlog-open.md` lists everything still open with priority.

---

## Published releases (npm)

| Version | Shipped | What |
|---|---|---|
| **v1.4.3** | 2026-05-25 | fix(scheduler): per-agent recheck before injectKeystroke kills broadcast read-race (spurious "check for updates" eliminated). Commit `87fbf3e`. |
| v1.4.2 | 2026-05-25 | fix(recovery-watcher): closest-to-end matching + multi-line patterns + canonical signatures + re-entrancy guard. Commit `d24b77c`. |
| v1.4.1 | 2026-05-23 | fix(recovery-watcher): raise position threshold 400→1000 to account for CLI prompt chrome. Commit `db5befa`. |
| v1.4.0 | 2026-05-22 | Recovery Watcher MVP — polls scrollback for API-error patterns, types recovery nudge into stuck terminals. Cooldown + signature de-dup + escalate-after-N. Commit `aafbbeb`. |
| v1.3.2 | 2026-05-18 | fix(register): osascript tty-ownership fallback so Codex CLI registers with `terminal_app=iterm2` even when env is stripped. Commit `cf195a9`. |
| v1.3.1 | 2026-05-15 | fix(scheduler): split iTerm2 dispatch into two writes so Codex auto-submits keystrokes (bracketed-paste vs Enter-key). Commit `d9b95a4`. |
| v1.3.0 | 2026-05-12 | Multi-model support (Claude Code + Codex + Gemini + Goose). README repositioning; multi-machine design doc; Command Center favicon. Commit `8d93955`. |
| v1.1.2 | 2026-05-08 | Per-agent autonomous-reply toggle in Command Center. Commit `d4ee281`. |
| v1.1.1 | 2026-05-07 | README docs sync (no code changes). Commit `f268401`. |
| v1.1.0 | 2026-05-07 | Autonomous-reply scaffolding (schema v2, register options, send options, hooks, cap-state, auto-nudge scheduler). Commit `871b1ab`. |

## On main, post-v1.4.3 (not tagged)

- `3a7203f` chore: HANDOVER notes v1.4.3 staged + v1.5 fan-out decision
- `0fbb29a` docs(readme): add hero/marketing artwork above intro
- `3651949` Remove ClaudeLink image from README

---

## Built on `feat/fleet-token-meter` (unmerged, soaking)

24 commits, +3157 / -20 lines, 15 files. All locally available; nothing pushed to origin; nothing on npm.

### Fleet Token Meter (1a)
- **`4a93433` — `src/usage-reader.ts` + `GET /api/usage` + Command Center "Fleet Token Meter" panel.** Reads each live agent's project transcripts at `~/.claude/projects/<projectId>/<sessionUuid>.jsonl`. Per-project / per-model / per-day. Live-fleet scoping (privacy guardrail). Fork dedupe by `message.id`+`requestId` (5.1B from raw 13.1B). Filters `<synthetic>` model. `CLAUDELINK_UI_NO_SERVICES=1` render-only mode for safe screenshots.
- **`3a67a83`** — Tab the Command Center (Overview + Fleet Token Meter).
- **`416544e`** — Adaptive trend: donut for single-day, bars for multi-day.
- **`fa3dec7`** — Fix meter getting stuck on "reading transcripts…" (re-entrancy guard + cache + 120s interval).
- **`8b5af10`** — `+` expand on project rows → per-session breakdown.
- **`5e2134c`** — Label per-session breakdown by REGISTERED agent name (no deploy needed).
- **`8db191f`** — Per-agent timeline: cumulative-lifetime + current-context + compact markers (locked spec).
- **`ac054bd`** — Per-agent timeline legend + auto/manual compact split.

### 1b protocol (mechanism wired, content slot empty)
- `Token & Context Hygiene` section + `<!-- CLAUDELINK:TOKEN_PROTOCOL -->` marker in `CLAUDE_MD_CONTENT` + `AGENTS_MD_CONTENT` (src/cli.ts). Awaiting dev-03's protocol research.

### Tier-2 context-hygiene watcher
- **`21e94cb`** — `src/context-watcher.ts` + `context-watcher-settings.ts` (observe-only). Mode `observe` (logs would-nudge); mode `inject` was a guarded stub.
- **`d108eeb`** — Item 1: $/turn economic trigger (arms ~180K on Opus via contextTokens × cache-read price > $0.27/turn) + separate net-savings fire-decision gated on actively-progressing + rate-of-burn.
- **`cc0ba5b`** — Item 4: session-identity capture from hook stdin (`session_id` + `transcript_path`). Schema v3. `NexusDB.setAgentSession` idempotent. `resolveSession()` uses exact transcript_path when present.
- **`490df44`** — Two-gate observe correlation logging (signal_age_min, safe_to_clear, safety_gate, economic_gate, both_gates_green).

### Compact analyzer + §C state preservation
- **`501c55c`** — `compact-analyzer.ts` (read-only, `GET /api/compact-analysis`). Loss calibration over natural compacts. First fleet distribution: MANUAL n=125 median 332K→10K (97%); AUTO n=18 median 1.0M→13K (99%). Artifact: `compact-analysis.json` at repo root.
- **`efd8257`** — §C state-preservation: `src/compact-executor.ts` — Path A (`/compact`+handoff) and Path B (CLEAR+reinject) as **dry planners**. `executeCompact` armed mode throws. `verifyHandoff` (>200 bytes). `HANDOFF_TEMPLATE`. `pathALossBaseline()` over 143 historical compacts.

### `signal_checkpoint` MCP primitive
- **`2b5635c`** — New MCP tool `signal_checkpoint({safe_to_clear, handoff_path, note})`. Schema v4 (checkpoint_ts / safe_to_clear / handoff_path / note). Logs to `~/.claudelink/checkpoint.log`. Instantaneous signal (freshness judged at watcher tick time).
- **`1cd7efd`** — Wire `CHECKPOINT_INSTRUCTIONS` into MCP server `instructions` field (self-conveying habit, <2KB).
- **`4a08a00`** — Rewrite `CHECKPOINT_INSTRUCTIONS` for armed-watcher era (replaces stale "observe-only" sentence with call-to-action).

### Armed inject path (gated)
- **`e0f9c62`** — `src/arm-compact.ts` — one-shot armed `/compact` CLI runner (dry default, `--fire` to inject). Founder-supervised only.
- **`7f49493`** — Arm inject path in context-watcher: system one-shot `/compact` (off by default).
- **`7f9e0e7`** — Fix: latch BEFORE inject in the one-shot path (crash-safe; commit pinned this ordering).
- **`6fca68e`** — **C1 — fail-closed role allowlist for armed inject.** `injectAllowlist: string[]` default `[]` arms nobody. FIRST gate in inject branch. Verified fail-closed in clean-room test.

### Recovery Watcher additions
- **`ad7ef82`** — Match Claude Code safety-classifier auto-mode failures (`/\bis temporarily unavailable, so auto mode cannot determine the safety\b/i`). 5/5 smoke test.

### Documentation
- **`50fabff`** — `docs/auto-compact-redesign-2026-06-11.md` — post-soak planning pass. Includes architect (Plan) review + Founder Advisor formal recommendations (§9).
- **`0fd08cc`** — HANDOVER notes for the wave.

---

## Empirically verified (production)

| Date | What | Result |
|---|---|---|
| 2026-05-29 10:46 | First end-to-end armed auto-compact (supervised, Global Sites Developer) | Watcher autonomously evaluated two gates → selected ONLY Global Sites (isolation held) → latch-first → injected `/compact` → `compact_boundary` 14→15 with **611,035 → 13,290 tokens (97.8% reduction)** ~2 min. Founder visually confirmed. |
| 2026-05-30 | Standing-on armed for 3-worker allowlist (Whisprdesk, iLoveMD, Global Sites) | Channel proven end-to-end on iLoveMD: tool discoverable, signal lands in DB, gate logic correctly enforces `handoff_path`, signal_age staling behaves. |
| 2026-05-30 → 2026-06-11 | 12-day standing-on window | **Zero autonomous fires** across the allowlist. CHECKPOINT_INSTRUCTIONS reach the agent on session start; agents do not pattern-match "I should call this now" mid-session. Root-cause analysis → `docs/auto-compact-redesign-2026-06-11.md`. |
| 2026-06-02 | CHECKPOINT_INSTRUCTIONS rewrite (commit `4a08a00`) loaded on fresh MCP child | New text reaches agent. Empirical finding: rewrite alone is insufficient — iLoveMD still did not call autonomously over 7+ min of clear rest-point state. Tracked as backlog item. |

---

## Documented (process / strategy)

- **Public engineering case study** at `rbjglobal.com/engineering` — Recovery Watcher coverage + multi-machine roadmap. Voice/scrub rules in `reference_engineering_case_study.md`.
- **v1.5 multi-machine design** at `docs/multi-machine-design.md` — hub-and-spoke, schema v3 (host column), bearer token, 8-phase build plan.
- **Auto-compact redesign 2026-06-11** at `docs/auto-compact-redesign-2026-06-11.md` — 9 sections covering the failed standing-on, what's wrong with the gate stack, concrete recipe, sequencing recommendations, anti-recommendations.
- **v1.5 broadcast fan-out decision** captured in HANDOVER — replace `broadcastMessage()` with N directed rows at send time; v1.4.3 recheck becomes defense-in-depth.
- **CHECKPOINT_INSTRUCTIONS conveyance verified** via Claude Code docs / claude-code-guide — Claude Code DOES inject MCP server's `initialize.instructions` into context, automatically, every session, truncated at 2KB. Confirmed empirically.

---

## Decisions made (for reference)

- **Model selection policy** (CLAUDE.md top section, 2026-05-07): Sonnet 4.6 default; Opus 4.7 for protocol/race/security. Iterative tuning.
- **Cost framing** — "API-equivalent value at list price." Max plan = flat fee, not a bill. Used throughout the Fleet Token Meter UI.
- **Symlink fact** — global `claudelink` is `npm-link`ed to the repo, so `npm run build` is LIVE for newly-spawned `claudelink-server`. "Deploy" for a terminal = restarting it. Running daemons keep in-memory old code until restarted.
- **No npm publish without founder OTP.** 2FA-on-publish enabled.
- **Branch protection.** `feat/fleet-token-meter` not merged to main; will not publish until standing-on rollout completes a clean supervised soak + loss data is collected + founder approves.
