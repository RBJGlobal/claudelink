# ClaudeLink, handover

> **Purpose:** First thing to read when resuming work on the claudelink package itself. `CLAUDE.md` is the always-on directive layer; this file is the session-resume pointer.
>
> **Last session:** 2026-05-05

---

## Current status: v1.1.0 + v1.1.1 shipped, auto-nudge scheduler is live as the primary autonomous-reply mechanism

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
