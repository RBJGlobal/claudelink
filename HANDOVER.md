# ClaudeLink, handover

> **Purpose:** First thing to read when resuming work on the claudelink package itself. `CLAUDE.md` is the always-on directive layer; this file is the session-resume pointer.
>
> **Last session:** 2026-06-12 (overnight stabilization pass)

---

## Current status: stabilization pass complete on `feat/fleet-token-meter` — 6 safety-critical fixes from a parallel architect+code-reviewer audit, 71-test smoke harness, backlog reconciled. Branch still unmerged + unpublished + un-deployed; standing-on rollout still awaiting the redesign (per `docs/auto-compact-redesign-2026-06-11.md`).

### 2026-06-12 overnight pass — what happened

User asked for an aggressive regression + stabilization pass: parallel architect + code-reviewer, dead-code hunt, backlog reconcile, integration tests. Output:

**Audits run:** three parallel subagents — Plan (architect), `coderabbit:code-reviewer` (line-by-line), Explore (dead-code).
- Dead-code Explore: zero unused imports / orphans / dead branches / stale TODOs. Codebase is remarkably clean.
- Code-reviewer: 3 P0 + 13 P1 + 7 P2 + 3 P3 findings.
- Plan (architect): one major addition — stale `transcript_path` from v3 trusted without recency check, "single biggest architectural risk."

**Backlog reconciled** into two files at repo root:
- `backlog-done.md` — every shipped release (v1.1.0 → v1.4.3) + every built/verified item on the branch + empirically-verified production events.
- `backlog-open.md` — priority-ordered (4 P0 / 7 P1 / 11 P2 / 6 P3) with why/what/acceptance/owner/blocking/estimate for each item.

**SAFETY-CRITICAL fixes APPLIED + COMMITTED** (commit `dc8979d`, all on currently-disabled paths so live behavior is unchanged):
1. **F1 — armGate idle uses BY-TIME latest line, not by-position last.** Branched/resumed JSONL transcripts can have a chronologically-older "end_turn" line at the file tail; the original code would trust it and `/compact` could land mid-tool-call. Now uses latest-ts guard.
2. **F3 — Same fix in `latestTurnEconomics`.** Economic gate was comparing against stale `contextTokens` from an older branch.
3. **F5 — One-shot latch wrapped in try/catch.** If `writeContextWatcherSettings` threw (full disk / chmod), the latch silently didn't land and `injectKeystroke` still ran → entire "latch first, crash-safe" design defeated. Now logs `LATCH-FAILED` and skips the inject.
4. **F10 — `handoff_path` now restricted to `~/.claudelink/handoffs/`.** Before: agent could call `signal_checkpoint({handoff_path:"/etc/passwd"})` and downstream `verifyHandoff` size-check passed. Now validated at the tool ingress; rejected paths are surfaced in the tool response so the agent gets feedback.
5. **F13 — `verifyHandoff` rejects unfilled placeholders.** `HANDOFF_TEMPLATE` itself is ~270 bytes so satisfied the original `>200 byte` gate; an agent writing nothing past the stub would pass. Now scans for any of `HANDOFF_PLACEHOLDERS` still present.
6. **Plan-1 — `resolveSession` recency check.** Trusted captured `transcript_path` even when stale. If an agent's Claude Code session was replaced in the same terminal (no re-register firing the hook), the watcher would score gates against a DEAD transcript and inject `/compact` into a LIVE DIFFERENT session. Now requires `mtime` within `TRANSCRIPT_STALE_MS=30min`; stale falls back to ambiguous heuristic.

**Smaller correctness fixes also in `dc8979d`:**
- F4 — heartbeat `setInterval` was leaked: never cleared on SIGINT/SIGTERM, accumulated one per re-register. Now stashed + cleared on shutdown.
- F11 — three async HTTP endpoints used `.then(ok).catch(err)` which could double-send on a `send(200)` throw. Switched to `.then(ok, err)`.
- F15 — `latestTurnEconomics` didn't close its readstream on throw. Now `try/finally` with `rl.close()` + `input.destroy()`.
- F16 — usage-reader's `register` tool_use match was `String.includes("register")` — would leak through `register_user`. Now exact match against `register` / `*__register` / `mcp__claudelink__register`.
- F19 — `cleanAllowlist` now trims whitespace + dedupes. Before: `["dev", "dev "]` would pass as two distinct allowlist entries.
- Plan-2 — fixed three-way agent-facing inconsistency: `CHECKPOINT_INSTRUCTIONS` said armed, tool description + tool result said observe-only. Rewrote both to match the armed reality with explicit allowlist semantics.
- Plan-3 — `handoff_path` was `required` in the input schema but `optional` in instructions. Now optional in both.

**Smoke-test harness scaffolded** (commits `8ebd315` + `ba2fc7d`, **zero test infra existed before**):
- Runner: node:test + tsx (one small dev dep) + @playwright/test for E2E.
- **71 tests passing** in ~1.4s:
  - DB migrations v1→v4 idempotent + `setCheckpoint`/`setAgentSession` round-trip
  - `cleanAllowlist` trim/dedupe + settings clamp + default-fail-closed
  - Handoff safety: `HANDOFF_TEMPLATE` verbatim rejected, placeholder scan, `isHandoffPathSafe` enforces under `HANDOFF_DIR`, rejects `/etc/passwd` + sibling-traps + relative-traversal
  - **F1/F3 latest-ts regression** (the gate-lying bug): `latestTurnEconomics` + `armGate` must pick by-time-latest, not by-position-last
  - Recovery Watcher patterns: new 2026-05-29 safety-classifier pattern + all existing rate-limit shapes + distance-from-end guard + closest-to-end matching (v1.4.2 regression) + signature canonicalization
  - HTTP smoke: `/api/heartbeat`, `/`, `/favicon.svg`, `/api/state`, `/api/context-watcher` GET+POST, `/api/recovery-watcher`, `/api/scheduler`, `/api/usage`, `/api/agent-timeline`, 404 path
- 4 Playwright E2E tests (UI smoke). Listed cleanly via `npx playwright test --list`. **One-time setup before first run:** `npx playwright install chromium`.
- Test isolation: env-var pattern (`CLAUDELINK_DB_PATH`, `CLAUDELINK_CONTEXT_WATCHER_SETTINGS`, `CLAUDELINK_UI_NO_SERVICES`) evaluated at call time (not module load) so tests can set them after static-import hoisting brings the modules in. **No behavior change in production** — env unset → defaults.

**Commands you'll use tomorrow:**
- `npm test` — node-test suite, ~1.4s
- `npm run test:e2e` — Playwright (after one-time `npx playwright install chromium`)
- `npm run test:all` — both

### What's still open (priority-ordered, full detail in `backlog-open.md`)

**P0 (ship-blocker — required before any next standing-on arming):**
1. Per-tick gate-status logging (instrument-first) — `gate-status role=X arming=B signal_age_turns=N signal_age_min=M handoff_ok=B idle=B ambiguous=B occupancy_pct=N`. Required so the next rollout has a 24h success-criterion instead of a week-long mystery.
2. Per-model proportional threshold — replace `dollarPerTurnThreshold` with `contextOccupancyThreshold = 50%` per Founder Advisor recommendation, with model→window lookup. The biggest reason zero autonomous fires happened during the 2026-05-30 standing-on.
3. ~~Silent handoff_path failure~~ → **PARTIALLY CLOSED tonight (`signal_checkpoint` now returns feedback on bad paths).** Remaining: `verifyHandoff` invocation inside the gate-skip path could ALSO surface to an audit log so operators see "agent X tried but couldn't qualify."

**P1 (standing-on reliability — do alongside the next rollout):**
- Pre-create handoff stub (eliminates "where do I write" friction)
- Loosen `freshConsent` to hybrid time+turn rule (current 5 transcript-line budget is too tight for Opus quick-turns; this also subsumes code-reviewer's F2)
- Graded escalating Stop-hook nudge (50/75/90/100%)
- Retry-on-transient-fail in armed inject (ETIMEDOUT shouldn't latch)
- Per-role coordinator threshold (Founder Advisor + clawdemy-lead differ from workers)
- Recovery Watcher false-fire tightening (older rate-limit patterns; new classifier OK)
- Item 4 hook deployment broader coverage (UI flag showing which agents owe a Stop-hook fire)

**P2 (polish + observability):** ambiguity-flag false-positive sampling, MCP-session-restart unit test, Apple Terminal support, UI auth, scheduler stale-unread backoff, per-tty keystroke mutex across injectors, recovery-watcher re-escalation, async execFile, "last visible block above empty prompt" anchoring, MCP `disallowedTools` doc note.

**P3 (v1.5 roadmap):** broadcast fan-out, NexusBackend interface, spoke daemon, schema v5, structural pause-point injection, threshold-relative-to-work-done.

### Hard constraints honored tonight
- ✅ NO merge to main (branch still unmerged)
- ✅ NO npm publish (still v1.4.3 on registry)
- ✅ NO push to origin (verify by inspection: `git log origin/feat/fleet-token-meter` will lag behind local)
- ✅ NO `npm install -g .` (deploy-class)
- ✅ NO Command Center restart (running pid is still on pre-tonight code)
- ✅ NO refactoring of armed-inject behavior — fixed correctness bugs only, no design changes to a path that needs live supervision to verify
- ✅ Two artifacts (`compact-analysis.json`, `fleet-token-meter.png`) intentionally NOT staged — they contain real agent names / per-run analysis that the prior memory entries flag as redact-before-commit
- ✅ Honest framing — when the user said "Playwright + integration + API tests" the truth was zero test infra existed; built a real harness rather than pretending tests passed

### Tomorrow's takeoff checklist
1. Read `backlog-done.md` + `backlog-open.md` at repo root.
2. `npm test` — should be 71/71 green.
3. Decide: (a) Founder Advisor reply on whitelist arm sequence is still outstanding (untouched tonight); (b) human label on Global Sites Developer's post-compact behavior from 2026-05-29 (the first calibration data point) still owed; (c) when ready to re-attempt standing-on, the P0-1 instrument-first + P0-2 per-model threshold are the pre-arming gates.
4. Push to origin when ready: `git push origin feat/fleet-token-meter`.

---

## Prior pickup status: v1.4.3 LIVE on npm; major build wave on `feat/fleet-token-meter` (unpublished, partially un-deployed); first end-to-end armed auto-compact succeeded; C1 fail-closed whitelist built and ready; standing-on rollout awaiting founder direct go + worker-role picks

**Branch:** `feat/fleet-token-meter` (head `ad7ef82`). v1.4.3 (commit `87fbf3e`) shipped to npm; everything else on the branch is local + symlinked into the global `claudelink` (so newly-spawned `claudelink-server` processes pick it up, running daemons don't until restarted).

### Everything built on the branch (chronological, all on `feat/fleet-token-meter`)

| Commit | What | Status |
|---|---|---|
| `21e94cb` | Tier-2 context-hygiene watcher (observe-only) + compact-savings projection | live (observe) |
| `501c55c` | `compact-analyzer.ts` — read-only loss calibration over natural compacts; GET `/api/compact-analysis` | live (read-only) |
| `d108eeb` | Item 1 — $/turn economic trigger + net-savings fire-decision (gated, observe) | live (observe) |
| `cc0ba5b` | Item 4 — session-identity capture (hook stdin → DB; schema v3) | live, hook-dependent |
| `efd8257` | §C state-preservation — Path A/B dry planners + handoff schema + A/B harness | dry only, gated |
| `2b5635c` | `signal_checkpoint` MCP primitive — agent-consented checkpoint (schema v4) | live (observe), MCP tool needs per-agent session restart to be callable |
| `490df44` | Two-gate observe correlation logging in context-watcher | live (observe) |
| `1cd7efd` | Wire `signal_checkpoint` protocol into MCP server `instructions` field (self-conveying habit, <2KB) | live for new sessions |
| `3a67a83` | Tab the Command Center — Overview + Fleet Token Meter | live (CC restart req'd) |
| `416544e` | Adaptive trend — donut for single-day, bars for multi-day | live (CC restart req'd) |
| `fa3dec7` | Fix meter getting stuck on "reading transcripts" — re-entrancy guard + cache + 120s interval | live (CC restart req'd) |
| `8b5af10` | `+` expand on project rows → per-session breakdown | live (CC restart req'd) |
| `5e2134c` | Label per-session breakdown by REGISTERED agent name | live (CC restart req'd) |
| `e0f9c62` | `arm-compact.ts` — one-shot armed `/compact` CLI runner (dry default, `--fire` to inject) | gated, founder-supervised |
| `7f49493` | Arm inject path in context-watcher — system one-shot `/compact` (gated off) | live, watcher disabled |
| `7f9e0e7` | Latch BEFORE inject in one-shot path (crash-safe) | live |
| `8db191f` | Per-agent timeline — cumulative-lifetime + current-context + compact markers (locked spec) | live (CC restart req'd) |
| `ac054bd` | Per-agent timeline legend + auto/manual compact split | live (CC restart req'd) |
| `6fca68e` | **C1 — fail-closed role allowlist for armed inject** (the "controlled subset" gate) | built, fail-closed, NOT armed |
| `ad7ef82` | **Recovery Watcher — match Claude Code safety-classifier auto-mode failures** | built, smoke-tested 5/5 |

### What succeeded end-to-end (2026-05-29 10:46) — full intelligent auto-compact loop, supervised
Re-enabled the armed watcher one-shot. The SYSTEM (Command Center watcher pid 66912) autonomously evaluated both gates, selected ONLY Global Sites Developer (clawless/clawdemy-dev-03 inject-skipped: no-consent / ambiguous), latched first, injected `/compact` (result=ok). Compaction completed: `compact_boundary` 14→15, trigger=manual, **611,035 → 13,290 tokens (97.8% reduction)**, ~2 min. Isolation held (iLoveMD 11, WhisprDesk 26 untouched). Founder visually confirmed. Watcher auto-latched OFF.

### What the resume agent needs to know right now

1. **C1 whitelist is built but NOT armed.** Default `injectAllowlist: []` arms nobody. The inject branch's FIRST gate is `if (!injectAllowlist.includes(role)) skip`. Verified fail-closed. Live `context-watcher.json` has no allowlist set → defaults to `[]` → arms no one even if `enabled: true`.
2. **Command Center pid 66912 is on pre-whitelist + pre-classifier-pattern code.** Both `6fca68e` and `ad7ef82` are linked into the global package but the running CC daemon hasn't loaded them. CC restart turns both on simultaneously. Restarting the CC is a separate detached process; it does NOT touch agent sessions (only a few-second gap in nudge/recovery coordination).
3. **Standing-on rollout is OFF.** Founder Advisor was pinged with the three items it requested (role-string format, fail-closed confirmation, exact enable/kill toggles). Standing-on doesn't start until founder direct go + founder picks 2-3 worker roles (excluding Founder Advisor + clawdemy-lead — coordinator threshold is a follow-up, not built).
4. **Awaiting:** (a) Founder Advisor reply on the arm sequence; (b) founder human label on Global Sites Developer's post-compact behavior ("did it lose anything?") — first calibration data point + case-study seed.

### Arm sequence (all founder-gated, in order)
1. Founder picks 2-3 worker roles (exact strings from `get_agents`)
2. Restart those terminals (new code → they call `signal_checkpoint` → fresh consent)
3. Restart Command Center (loads whitelist-aware watcher + classifier pattern)
4. `POST /api/context-watcher {"enabled":true,"mode":"inject","oneShot":false,"injectAllowlist":[...]}`

**KILL (instant):** `POST /api/context-watcher {"enabled":false}` or the CC toggle. Per-terminal abort: Ctrl-C / Esc.

### Known polish / follow-ups (not blocking today)
- **Retry-on-transient-fail** in armed inject: ETIMEDOUT currently latches the one-shot. Standing-on self-retries via cooldown, but a transient retry inside the same fire would be cleaner.
- **Per-role coordinator threshold** (different $/turn for Founder Advisor / clawdemy-lead vs workers). On-paper not built; batch 1 is workers-only.
- **Recovery Watcher false-fires** on agents discussing API-error keywords mid-conversation — tightening pass on prior patterns (the new classifier pattern is structurally distinctive enough not to need it, but the older rate-limit patterns hit false positives 2026-05-29 ~10:38 on claudelink-developer and Founder Advisor).
- **Item 4 hook deployment.** Schema v3 + capture logic are live; session-id only populates after each agent's Stop hook fires once on the new code — so still hook-enabled-agents-only and ambiguity persists for the 8-clawdemy shared-repo cluster until session-id capture covers them.

### Decision rule for the soak window
Watch `~/.claudelink/scheduler.log`, `~/.claudelink/recovery-watcher.log`, `~/.claudelink/checkpoint.log`, `~/.claudelink/context-watcher.log`. Any unexpected fire, any `not-in-allowlist` skip that shouldn't have skipped, any false-fire on the new classifier pattern → flag for fix BEFORE the branch goes to npm.

### Branch publish status
`feat/fleet-token-meter` is NOT merged to main and NOT on npm. v1.4.3 (the last published release) is the public state. The branch will not be published until: (a) standing-on rollout completes a clean supervised soak; (b) per-agent loss data is collected on the first round of armed compacts; (c) founder approves the publish.

---

## Prior status (2026-05-25 session): v1.4.1 LIVE on npm; v1.4.2 + v1.4.3 STAGED LOCALLY soaking before publish decision

**Why we're holding local:** v1.4.0/1/2/3 are all separate fixes, evaluated under real-load conditions on the 14-agent fleet before any goes to the public registry. Founder's local install runs the latest staged code — fleet is protected. Only npmjs.com lags at 1.4.1 in the meantime.

**Local v1.4.2 (Recovery Watcher fixes from yesterday's review):**
- `9f9a390` fix(recovery-watcher): closest-to-end matching + multi-line patterns + canonical signatures + re-entrancy guard
- `d24b77c` Release v1.4.2 commit
- Tag `v1.4.2` at `d24b77c` (local-only)

**Local v1.4.3 (scheduler broadcast race-fix from tonight's three-agent review):**
- `1152243` fix(scheduler): per-agent recheck before injectKeystroke kills broadcast read-race
- Tag `v1.4.3` at `<release-commit>` (local-only)
- Root cause confirmed by parallel code-reviewer + architect agents: scheduler's `EXISTS (... OR m.to_agent IS NULL)` flags all eligible agents on any unread broadcast; sequential dispatch + shared `messages.read` column = first agent to readInbox consumes broadcast globally, remaining ~13 candidates fire into empty inboxes. New `hasUnreadMail()` recheck just-in-time before `injectKeystroke` skips the spurious dispatches. New `tick-summary candidates=N fired=F skipped=S failed=X` line makes the race observable.
- Stop hook is a SECOND racer (both autonomous_reply=0 direct path and autonomous_reply=1 directive path can flip the shared broadcast read=1) — recheck handles this for free.

**Soak watch list (signals to flag in `~/.claudelink/recovery-watcher.log` AND `~/.claudelink/scheduler.log`):**

Recovery Watcher (v1.4.2):
- `skip-tick: previous tick still in flight` → tick blocking under load
- Multiple fires on Global Sites Developer or ClaudeLink Developer → pattern 10 still letting discussion-prose through
- Same agent firing 3+ times with `consecutive=1` → canonicalization missed volatile-byte variants
- `escalated` lines → API genuinely down extended period
- Long silence after a real visible API error → still an uncaught case

Scheduler (v1.4.3):
- `tick-summary candidates=14 fired=1 skipped=13` → broadcast race detected and prevented (this is the smoking-gun fingerprint working as designed)
- `skip-recheck role=X reason="inbox drained mid-tick"` → confirms recheck killed a would-have-been-spurious dispatch
- Long-running ETIMEDOUTs on clawless-advisor → terminal still unresponsive to AppleScript (separate persistent issue; needs quit+reopen)

**Decision rule for tomorrow morning:**
- Clean logs across both subsystems → publish v1.4.2 + v1.4.3 (separate releases, in order)
- Recovery Watcher issues found → fix v1.4.4 patch on top of v1.4.2; hold v1.4.3 for separate evaluation
- Scheduler race-fix issues found → revisit Option B's residual ~200ms window or pull Option A (fan-out) forward

## v1.5 long-term broadcast fix — DECIDED: fan-out at send time

Decision made tonight after parallel architect + code reviewer debate: v1.5 will replace `broadcastMessage()` with a fan-out implementation that inserts N directed message rows at send time (one per agent), same shape as `sendMessage`. Schema unchanged. Race killed at source. v1.4.3 recheck becomes defense-in-depth.

Rejected alternatives: (A) new `broadcast_reads(agent_id, message_id)` table — correct-by-construction but bigger migration; (C) remove broadcast trigger from scheduler — breaks the clawless-advisor coordination broadcast pattern that's documented production usage.

Fan-out gotcha to handle: `sendMessage` resolves recipients by role; broadcast needs the full agent roster at send time (one extra query inside a transaction). Trivial. Multi-machine v1.5 spoke implementations will fan out per-host.

## Other v1.4.4+ / v1.5 candidates (from prior architect reviews)

| Pri | Item | Notes |
|---|---|---|
| v1.4.3 | Async `execFile` for `captureScrollback` + `injectKeystroke` with concurrency cap (4-6) | Architect's HIGH — event-loop block of up to 42s per tick on 14-agent fleet under iTerm2 unresponsive conditions; will surface as fleet scales |
| v1.4.3 | OR: batched single AppleScript per tick returning `{tty: contents}` dict | More invasive but eliminates N-osascript fan-out entirely |
| v1.4.3 | `KeystrokeDispatcher` mutex keyed by tty (~30 lines) | Serializes scheduler + watcher writes to same terminal; prevents interleaving |
| v1.4.3 | Re-escalation interval (currently one-shot notification) | If API down for hours, currently silent after first notify |
| v1.5 | "Last visible block above empty prompt" anchoring for detection | Eliminates position-threshold tuning; the substring+threshold approach has been tuned 3x already |
| v1.5 | Recovery Watcher runs on **spoke** (not hub) | `injectKeystroke` is already pure → port is clean; add `host` filter to `selectCandidates` once schema v3 lands |
| Build-log | Tell Global Sites Developer to nuance safety-boundary framing | "safe channel, multiple trigger sources, each disclosed" not "keystroke is human" — recovery watcher widens the trigger surface |

## Prior status (older session): v1.3.2 LIVE on npm (Codex env-strip fix); v1.4.0 Recovery Watcher staged locally; multi-machine renumbered to v1.5

**Latest priority work:**

- **v1.4.0 Recovery Watcher (MVP, staged locally, about to publish)** — polls each registered agent's terminal scrollback every 60s for API-error patterns (rate limit, overload, 5xx), types "check messages and continue with your current assignment" on a NEW occurrence. Per-agent cooldown (5 min default) plus escalate-after-N-fires that switches to desktop notification when nudging isn't helping. Built because Jay was hitting nightly Anthropic rate-limits that halt agent turns; he had been typing the recovery nudge by hand.
- Files: `src/recovery-watcher.ts`, `src/recovery-watcher-settings.ts`, edits to `src/scheduler.ts` (exported `injectKeystroke` + `NudgeCandidate` for reuse) and `src/ui-server.ts` (lifecycle + GET/POST `/api/recovery-watcher` + Command Center panel).
- Defaults: enabled=false (opt-in). Settings at `~/.claudelink/recovery-watcher.json`. Audit log at `~/.claudelink/recovery-watcher.log`.
- Multi-machine renumbered from v1.4 → **v1.5** because Recovery Watcher was higher-pain and could ship faster.

**On pause until ~2026-05-16:** user is taking a few days to soak-test v1.3.1 in real use before starting v1.4 multi-machine. Reasoning: multi-machine is architecturally large (touches local networking + spoke daemon + schema v3), and last night surfaced two "basic" bugs (Codex env-strip on registration, iTerm2 bracketed-paste vs Enter-key dispatch) that only came out through real use. Better to find any remaining v1.3.1 issues on a stable base than to compound them with v1.4 work in flight.

**Open items in priority order:**

0. **Wait for user.** Don't propose starting v1.4 unprompted. When the user comes back and is ready, Phase 1 (NexusBackend interface extraction) is cleared to start.

1. **v1.3.1 LIVE.** `npm view claudelink version` → `1.3.1`. GitHub tag `v1.3.1` at `b76a336`. Multi-CLI mesh + Codex keystroke fix shipped.
2. **v1.4 multi-machine** *(was v1.2 in design doc; renumbered because v1.3 multi-model shipped first; design doc still refers to it as v1.2 — fix on next pass).* Phase 1 (NexusBackend interface extraction) cleared to start. Pure local refactor, doesn't need user's M5.
3. **v1.3.1 root-cause notes** *(keep these)*. iTerm2's `write text` with multi-character content goes through bracketed-paste path; the bytes arrive at the receiving process as a PASTE, not keystrokes. CLIs whose TUI reads keyboard events (notably Codex) see embedded CR/LF as "characters within pasted content" rather than Enter. Claude Code and Gemini CLI were lenient enough to accept paste-mode submission, masking the bug in v1.3.0; Codex was strict and exposed it. Fix: split into two write-text calls — text first without newline, 50ms delay, then a standalone CR write without newline. Iterm2 sends the standalone single-byte CR as a real keystroke. Verified end-to-end on Codex (10s round-trip) and Gemini (14s round-trip).
4. **v1.3.1 also fixed a Codex registration gap.** `claudelink-server` registered with `terminal_app=NULL` because Codex CLI strips env (TERM_PROGRAM) when spawning MCP children. Manual SQL patch unblocked the user (`UPDATE agents SET terminal_app='iterm2' WHERE role='openai-auditor';`). The proper fix is to add a tty-ownership-via-osascript fallback in the registration auto-detect (`src/index.ts`), tried after the env-var detection fails. Not in v1.3.1 — the user wanted the keystroke fix shipped fast. Track for v1.4 or a v1.3.2.
5. **Founder playbook (gitignored).** Personal notes at `docs/founder-playbook.md` (excluded from git). Promotion strategy + launch sequence + repo polish checklist. Not in the public repo.
6. **Cleanup**: transient `claudelink-keystroke-test` agent (id `5875e1c2-…`) was registered during the v1.3.1 verification. User can clean via the Command Center's Heal orphans button after the MCP session disconnects.

## What was added on 2026-05-08

### v1.3 — multi-model support (Claude Code + Codex CLI + Gemini CLI)

The MCP server itself was already model-agnostic. What was missing was the install paths for the other CLIs. Both added in v1.3.

| File | Change |
|---|---|
| `src/cli.ts` | `Client` type extended to `"claude" \| "codex" \| "gemini"`. Added `AGENTS_MD_CONTENT` (shared by Codex AGENTS.md and Gemini GEMINI.md). Added `installAgentsMd`, `addCodexMcp`, `installGeminiMd`, `addGeminiMcp` helpers. `initProject` and `initGlobal` walk the `Client[]` array and run the relevant install steps. Flag parsing rewritten to be **additive**: `--claude`, `--codex`, `--gemini` stack; `--both` is a Claude+Codex shortcut; `--all` does all three. Default with no flag = Claude only (preserves v1.1.x behavior). Help text restructured around Client flags + Examples. |
| `README.md` | Lead paragraph names all three clients. Installation split into per-client blocks plus an `--all --global` shortcut. Multi-model callout updated to chain through Gemini. Requirements list extended. |

### Architectural notes worth keeping

- **Codex CLI**: MCP config at `~/.codex/config.toml` under `[mcp_servers.<name>]` (TOML). AGENTS.md discovery is hierarchical: `~/.codex/AGENTS.override.md` → `~/.codex/AGENTS.md` → walk Git root down to cwd. We use `codex mcp add` for the registration, falling back to printing the snippet if the codex CLI isn't on PATH.
- **Gemini CLI**: MCP config at `~/.gemini/settings.json` (global) or `<project>/.gemini/settings.json` (project) under the `mcpServers` JSON key — same shape as Claude's `.mcp.json`. GEMINI.md goes at the project root (or `~/.gemini/GEMINI.md` for global). We do an in-process JSON merge into settings.json, preserving any pre-existing keys (verified on the user's machine: `security.auth.selectedType` was kept while `mcpServers.claudelink` was added).
- **Stop hook does NOT carry over** to Codex or Gemini. Hooks contract is Claude-Code-specific. Both fall back to auto-nudge keystroke cadence — fine for the user's audit use case.
- **Shared template, three filenames.** Codex's AGENTS.md and Gemini's GEMINI.md both contain the same `AGENTS_MD_CONTENT` body. Same marker (`## ClaudeLink - Multi-Agent Coordination`) so idempotency check works for both. Claude's CLAUDE.md uses the older v1.0 template (`CLAUDE_MD_CONTENT` with marker `## ClaudeLink - Autonomous Agent Communication`) — kept identical to v1.1.x to avoid disturbing existing users.

### Favicon

Bold lavender `L` + mint green node-cap dot. Visible at 16×16. Constant inlined in `src/ui-server.ts`, route at `/favicon.svg`, head link wired. `public/favicon.svg` is the canonical asset; npm `files` array is unchanged because the SVG is inlined into `dist/ui-server.js`.

### v1.2 multi-machine design

Hub-and-spoke architecture: one laptop owns the SQLite DB and `/api/v1/...` HTTP API, the other runs a small spoke daemon that polls and dispatches local keystrokes. Schema v3 (adds `host` column), optional bearer token (LAN-only, no TLS in v1.2), 8-phase build plan. Full doc at `docs/multi-machine-design.md`.

## Prior status: v1.1.2 tagged + pushed to GitHub; npm publish pending user OTP

Feature commit `8f80d79`, release commit `d4ee281`, tag `v1.1.2` — all on `origin/main`. The package has 2FA-on-publish enabled, so `npm publish` requires a fresh browser OTP each time and could not be completed autonomously. **First action on resume: run `npm publish` from the user's terminal, complete the browser OTP, then `npm view claudelink version` to verify 1.1.2 is on registry.**

The README + screenshot updates in this release are README-on-npmjs.com critical: until `npm publish` lands, the package page on npmjs.com still shows the v1.1.1 README without the autonomous-pipeline framing or the new Command Center screenshot.

## What was added on 2026-05-07

A new **Model selection policy** section was added to the top of `CLAUDE.md` per a directive from the Clawless Advisor terminal — Sonnet 4.6 default, Opus 4.7 escalation list (protocol design, race-condition reasoning, security-relevant work). Iterative tuning expected over the first 3-4 days.

The README and screenshot were also refreshed to lead with the autonomous pipeline as the headline capability (not a footnote): new "Why this is different" section walks through the 5-step closed-loop flow, the Command Center section calls out the per-agent Auto-reply toggle and Auto-nudge panel as first-class features, and the screenshot was regenerated with sanitized demo agents (reviewer / developer / tester / architect / ops) showing the architect deliberately set to Auto-reply OFF to illustrate the per-agent control.

## What was added on 2026-05-06

The Command Center's agents table now has a per-agent **Auto-reply** toggle column. Flipping it writes `agents.autonomous_reply` directly. Lifetime is until the agent re-registers (terminal close + reopen) — the toggle is a session-level override, not a sticky setting.

| File | Change |
|---|---|
| `src/db.ts` | `NexusDB.setAutonomousReply(agentId, enabled): boolean` — single-row UPDATE returning whether anything matched. |
| `src/ui-server.ts` | `/api/state` agents now include `autonomous_reply`. New `POST /api/agents/:id/autonomous` endpoint with body `{enabled:boolean}` and 400/404 paths. New "Auto-reply" column with checkbox + on/off pill, optimistic flip on change with revert-on-failure. Live-row only — dead-agent rows show static text since flipping a stale row is meaningless. |
| `CLAUDE.md` | Endpoint list updated with the new route + lifetime caveat. |

### Why a session-level override (not sticky)

An agent's `autonomousReply` value is *inferred* at register time, not declared in any project file. The agent reads its role description (e.g. "advisor-style"), reads the `register` tool's parameter doc ("set false for advisor-style"), and chooses. If the user wants to flip an agent's default permanently, the right place is the role doc itself (e.g. `ADVISOR-ROLE.md`), not a separate override table.

For sticky overrides we'd need an `agent_overrides` table the register call consults before honoring its own incoming value. Deferred — the session-level toggle is enough for the user's stated workflow ("flip on for the morning, flip off when I want the advisor deliberate again").

## Prior status: v1.1.0 + v1.1.1 shipped, auto-nudge scheduler is live as the primary autonomous-reply mechanism

Two npm releases landed today:

- **`claudelink@1.1.0`** — autonomous-reply infrastructure (commit `871b1ab`, tag `v1.1.0`)
- **`claudelink@1.1.1`** — README docs sync only, no code changes (commit `f268401`, tag `v1.1.1`)

Both pushed to `origin/main` and published to https://www.npmjs.com/package/claudelink. README on GitHub and on npmjs.com are now in sync.

### What v1.1.0 added (8 commits)

| Commit | Step | What |
|---|---|---|
| `2c2ba55` | 1 | Schema v2 (additive). `agents`: tty, terminal_app, pane_id, last_seen_active_ts, autonomous_reply. `messages`: parent_id, expects_reply. Migration is transaction-wrapped + has rollback SQL pinned next to the change. `readInbox` now atomic via `UPDATE...RETURNING` with correlated subquery. |
| `be63f80` | 2 | `register` accepts `autonomousReply` + auto-detects tty/terminal_app/pane_id; `send` accepts `expectsReply` + `parentMessageId`; new `getAgentByTty()`. TTY uniqueness enforced against live PIDs; stale-row cleanup on collision. |
| `94ffd4a` | 3 | `cap-state.ts` — env-tunable hard cap / cooldown / chain cap, per-TTY counter files, `auto-fire.log`. |
| `b80d7e0` | 4 | Stop hook + UserPromptSubmit hook scripts. Originally embedded message contents in the `decision: block` reason. |
| `32b37d4` | 5 | `claudelink install-hooks` CLI subcommand. Idempotent; preserves pre-existing hooks; `--global` and `--uninstall`. |
| `aaa14f3` | 7 | Path C: macOS desktop notifications via `osascript display notification`. Polls messages table, smart backlog suppression, collapsed-multiple format. |
| `3e11e02` | refactor | Stop hook switched to **directive-only** continuation (no content embedding) after the first Step 8 test caught Claude's safety layer flagging it. |
| `492b842` | pivot | Auto-nudge scheduler + Command Center UI controls. The actual production mechanism. |

## Empirical finding from Step 8 — the load-bearing pivot

The original Path A design was: Stop hook fires when an agent finishes a turn → emits `{decision: block, reason: <message contents>}` → Claude continues with the message in context and replies autonomously.

Real-terminal testing revealed two problems with this:

1. **Direct content embedding tripped Claude Code's prompt-injection defense.** Claude saw the message but refused to act, treating "external content steering outbound tool calls" as adversarial. Refactored to directive-only (`call read_inbox to fetch and decide`) — Claude has agency over its own tool calls so the safety layer accepts the read.
2. **Even with directive-only, the outbound `send` reply was often blocked.** Claude conflated the original user prompt (e.g. "count to 30") with the autonomous-reply turn, treating the reply as task deviation. Verbatim Claude reasoning observed: *"External System Write without user authorization, and unrelated to your actual task of counting 1-30."* This is responsible safety behavior, not a bug.

The user's KISS pivot: forget autonomous outbound replies; the actual pain is typing "check inbox" in every terminal manually. **The scheduler types `check for updates` into each terminal periodically; the existing UserPromptSubmit hook (homemade, in `~/.claude/settings.json`) sees the prompt, queries the DB for unread, and injects "call read_inbox" as additionalContext.** Claude trusts that path because it looks identical to the user typing by hand.

**Bottom line on the architecture:** the auto-nudge scheduler is the production path. The Stop hook is supplementary (low-latency for the case where an agent has *just* finished a turn and there's already mail). Both feed into the same `read_inbox` consumption point so neither produces conflicting state.

## Current behavior verified empirically

- Three test agents registered as Clawdlink1/2/3 in `~/Documents/TestClaudeLink` (and Finder-duplicated copies). Hooks installed via `claudelink install-hooks` in each.
- Stop hook fires correctly on turn-end. `auto-fire.log` shows `decision=fired, inbound=N` with proper counter increments and cap state.
- Scheduler ticks correctly. `scheduler.log` shows `fired role=Clawdlink2 tty=/dev/ttys010 terminal_app=iterm2` — only the recipient with unread messages got nudged. Smart filter works.
- Pre-existing global UserPromptSubmit hook (in `~/.claude/settings.json`) was the source of the "agents respond when I type something" behavior the founder observed before this session. Now interacts cleanly with the scheduler keystroke.

## What is NOT yet under the scheduler

The user's **live Clawless / WhisprDesk agents** registered before the v2 migration, so their `agents.tty` and `agents.terminal_app` are NULL. The scheduler's SQL filter (`WHERE a.tty IS NOT NULL`) excludes them. To bring them under the scheduler:

1. Wait for a natural break point.
2. Quit each Claude Code session (Ctrl-D or `/quit`).
3. Restart in the same terminal — re-registration populates v2 columns automatically.

A manual SQL backfill works but risks mismatching TTY with the wrong agent. Restart path is cleaner.

## What to test if you resume work

- **Send a message between two live agents** that have been restarted post-v2. Within the configured interval (default 5 min), the recipient should auto-receive and process. Verify in `~/.claudelink/scheduler.log`.
- **Toggle the Auto-nudge panel** in the Command Center. Test interval changes — the next tick uses the new value (no UI restart needed).
- **The Apple Terminal gap** — if any of the live terminals turn out to be Terminal.app rather than iTerm2 or tmux, scheduler will skip them with `terminal_app="terminal"` and they won't be nudged. Check `~/.claudelink/scheduler.log` for `skip ... reason="unsupported terminal_app"`.

## Suggested follow-ups (not done — explicit user authorization needed)

- **Real-time terminal injection on message arrival (was Path B).** The scheduler floor is N minutes; for low-latency delivery to idle terminals, we could trigger the keystroke immediately when a new message lands. Same dispatch code as the scheduler; just wire it to a DB-poll watcher (the Path C notifier already polls every 2s — could extend it to also fire the keystroke). Not built yet; user said scheduler is sufficient for now.
- **Apple Terminal support.** Needs a one-time Accessibility permission grant via System Events `keystroke`. We deliberately didn't silently prompt for this. A `claudelink doctor` command that explains the permission and walks through granting it would be the right shape.
- **Backoff for stale unread.** If an agent doesn't process its inbox (user is AFK), the scheduler keeps typing every interval. Self-corrects when read, but could be noisy. A "if same N unread messages pending for K cycles, fall back to slower cadence" heuristic would be cheap to add.
- **`removeStaleAgent` is callable for live agents** — same gap flagged in the prior session. Still mostly fine because the registered server will just re-insert on next register, but worth a `if (alive) refuse` guard if the UI ever gains a "remove live agent" affordance.
- **Token-based auth on the UI.** Anything on localhost can hit `/api/scheduler` POST and toggle the scheduler off. Personal-laptop scope makes this low priority but worth noting if claudelink ever grows to multi-user / shared dev box.

## Files touched this session

- `src/db.ts` — v2 migration, atomic readInbox, peekInbox, getChainLength, updateLastSeenActive, RegisterOptions/SendOptions, getAgentByTty
- `src/index.ts` — register options + auto-detection, send options, expects_reply tag in read_inbox output
- `src/cli.ts` — install-hooks subcommand
- `src/cap-state.ts` (new) — per-TTY counter + caps + auto-fire log
- `src/hooks/stop-hook.ts` (new) — Stop hook with refactored directive-only continuation
- `src/hooks/user-prompt-submit-hook.ts` (new) — counter reset hook
- `src/scheduler.ts` (new) — auto-nudge scheduler + per-app dispatch
- `src/scheduler-settings.ts` (new) — persistent settings layer
- `src/ui-server.ts` — Path C notifier, scheduler integration, `/api/scheduler` GET/POST, Auto-nudge UI panel + JS
- `bin/stop-hook.js` (new), `bin/prompt-hook.js` (new) — bin shims
- `package.json` — bin entries + version 1.1.1
- `README.md` — v1.1.0 rewrite (auto-nudge headline, install-hooks, debug knobs, safety boundary note)
- `CLAUDE.md` — project-layout updates, scheduler/hooks pitfalls, npm release flow
- `HANDOVER.md` — this file

## Known gotchas to remember

- **All caps and intervals in the scheduler/hooks layer are env-tunable but UI-controllable only for the scheduler interval.** Adjusting `CLAUDELINK_HARD_CAP` etc. requires restarting the Stop hook process — i.e. there's no live-reload for hook env vars. Restart the Claude Code session whose terminal you want to retune.
- **The Stop hook always exits 0 even on error** (fail-open is the production default). Set `CLAUDELINK_HOOK_STRICT=1` to surface stack traces to stderr during debugging — visible only with `claude --debug`.
- **Two UserPromptSubmit hooks coexist** in the founder's setup: the homemade inline-shell hook in `~/.claude/settings.json` (queries DB for unread, injects additionalContext), plus the v1.1.0 `claudelink-prompt-hook` (resets the per-TTY counter file). They don't conflict — both fire on every prompt; the homemade one does the work, ours does the bookkeeping.
- **`agents.last_seen_active_ts` is populated by the Stop hook on every fire** but isn't yet read by anything. Reserved for the deferred Path B (real-time wake-up); rip out if Path B never ships.
- **`dist/` is gitignored** but auto-syncs to the npm-global lib because of how `npm install -g .` linked the project on this machine. Verified once during this session — diff between project `dist/` and global `dist/` was empty after a rebuild. May not hold on other installs.

## Quick reference

- Audit logs:
  - `~/.claudelink/auto-fire.log` — every Stop hook decision
  - `~/.claudelink/scheduler.log` — every scheduler tick
- State files:
  - `~/.claudelink/state/<tty>.json` — per-TTY auto-fire counter
  - `~/.claudelink/scheduler.json` — scheduler settings (UI-managed)
- Lock file: `~/.claudelink/ui.lock` (Command Center singleton)
- DB: `~/.claudelink/nexus.db` (WAL-mode, schema v2)
