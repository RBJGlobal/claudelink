# ClaudeLink - Project Instructions

> **Resuming work?** Read `HANDOVER.md` first — it captures the last session's status and what to test next.

## Project layout

ClaudeLink is a Node + TypeScript MCP server with a SQLite shared-state DB and a local web Command Center.

| Path | Role |
|---|---|
| `src/index.ts` | MCP stdio server (the `claudelink-server` binary). Defines tools: `register`, `send`, `broadcast`, `read_inbox`, `get_agents`, `post_bulletin`, `get_bulletin`. `register` and `send` accept v1.1 options (`autonomousReply`, `expectsReply`, `parentMessageId`); `register` auto-detects tty/terminal_app/pane_id from the parent process. On boot, calls `launchUIIfNeeded()` to spawn the Command Center as a detached child. |
| `src/db.ts` | `NexusDB` — better-sqlite3 wrapper around `~/.claudelink/nexus.db`. Schema v2: `agents` (with tty/terminal_app/pane_id/last_seen_active_ts/autonomous_reply), `messages` (with parent_id/expects_reply), `bulletin`. WAL mode, 5s busy_timeout. Migrations are versioned via `PRAGMA user_version`; v2 step wrapped in a transaction. `readInbox` uses `UPDATE...RETURNING` (atomic mark-read); `peekInbox` returns unread without consuming. |
| `src/cli.ts` | `claudelink` CLI: `init`, `status`, `ui`, `install-hooks` (with `--global` / `--uninstall`), `reset`, `help`. |
| `src/cap-state.ts` | Per-TTY auto-fire state for the Stop hook. Counters live at `~/.claudelink/state/<tty>.json`, written atomically. Env-tunable caps (`CLAUDELINK_HARD_CAP`, `CLAUDELINK_COOLDOWN_S`, `CLAUDELINK_CHAIN_CAP`); decisions logged to `~/.claudelink/auto-fire.log`. |
| `src/hooks/stop-hook.ts` | Stop hook entry. Looks up the TTY's registered agent, peeks inbox (does not consume), filters by `expects_reply` + chain cap, applies cap state, emits `{decision:"block","reason":"call read_inbox"}` directive on fire. Advisor branch (`autonomous_reply=0`) consumes via `readInbox` for stderr emit instead. Fail-open by default; `CLAUDELINK_HOOK_STRICT=1` for fail-loud dev mode. |
| `src/hooks/user-prompt-submit-hook.ts` | UserPromptSubmit hook. Resets the per-TTY counter file so the next Stop hook fire starts at 0. |
| `src/scheduler.ts` | Auto-nudge scheduler — primary autonomous-reply mechanism. Periodic tick, smart trigger (only fires for agents with unread mail at the SQL filter), per-terminal-app dispatch (tmux send-keys / iTerm2 osascript). Audit at `~/.claudelink/scheduler.log`. |
| `src/scheduler-settings.ts` | Persistent settings at `~/.claudelink/scheduler.json` ({enabled, intervalMin}). Atomic writes (tmp + rename). Defaults: enabled=false (opt-in via Command Center UI), intervalMin=5, clamped to [1, 120]. |
| `src/ui-server.ts` | Local HTTP server (`127.0.0.1:7878`). Endpoints listed below. Embeds the single-page HTML UI (with the new Auto-nudge panel) as a template literal — no build step beyond `tsc`. Spawns both the Path C notifier (osascript display notification) and the auto-nudge scheduler in `startUIServer`; both stop on SIGTERM/SIGINT/exit. |
| `src/ui-launcher.ts` | Singleton enforcement via `~/.claudelink/ui.lock`, browser opener, heartbeat ping. Detached-spawn guarantees the UI outlives the MCP parent. |
| `src/ui-bin.ts` | Entry-point invoked by the detached spawn (`node dist/ui-bin.js <port>`). |
| `bin/*.js` | Thin shims that `require("../dist/...")`. Used by the npm `bin` entries: `claudelink`, `claudelink-server`, `claudelink-ui`, `claudelink-stop-hook`, `claudelink-prompt-hook`. |

### Command Center endpoints (ui-server.ts)
- `GET  /` — single-page HTML UI
- `GET  /api/heartbeat` — `{ ok, pid }`. Used by the launcher to detect a stale lock.
- `GET  /api/state` — `{ servers, agents, health, recent_messages }`
- `POST /api/kill/:pid` — SIGTERM (validated: target must be a `claudelink-server`)
- `POST /api/kill-all` — SIGTERM every `claudelink-server` (excluding self)
- `POST /api/heal` — cascade-clean every dead agent's messages/bulletin/agent rows in one tx
- `POST /api/remove-stale/:agentId` — single-agent cascade clean
- `POST /api/quit-ui` — graceful UI shutdown, removes the lock file
- `GET  /api/scheduler` — `{ enabled, intervalMin }` for the auto-nudge scheduler
- `POST /api/scheduler` — partial update; rewrites `scheduler.json` atomically and reschedules in-process via `schedulerHandle.reschedule()`

### Auto-launch lifecycle
First `claudelink-server` to boot in any terminal calls `launchUIIfNeeded()`. The launcher checks the lock file: if missing or stale (PID dead, no heartbeat), it `spawn(detached: true).unref()`s a fresh `node dist/ui-bin.js` and opens the browser. Subsequent server boots see a valid lock + responsive heartbeat and skip. UI lifecycle is owned by the user — it persists across MCP restarts and exits only on `Quit UI` button or `claudelink ui --stop`. Opt out with `CLAUDELINK_UI=off`.

## Common pitfalls when working on this codebase

- **better-sqlite3 v12+ enables `foreign_keys = ON` by default.** Any `DELETE FROM agents` must first delete dependent `messages`/`bulletin` rows in the same transaction (see `pruneDeadAgents`). Don't add FK references without thinking about cascade.
- **The agents table allows duplicate `role` values.** `sendMessage` fans out to all matches. Don't add a UNIQUE index on `role` without updating the send semantics.
- **Lock-file races are intentional.** Two MCP servers booting near-simultaneously may both try to start the UI. Whichever loses the `port.listen` race exits; the winner serves. The launcher's heartbeat ping confirms a real listener before the loser would even try.
- **`pid` in the agents table is the PID of the `claudelink-server` that registered, not the Claude Code parent.** When matching a server process to its registered agent, compare against `claudelink-server` PIDs from `ps`, not Claude Code PIDs.
- **The CLI's `init` writes a hardcoded CLAUDE.md template inlined in `src/cli.ts` (the `CLAUDE_MD_CONTENT` constant). It does NOT read this file.** Keep the agent-behavior section below in sync with that constant when changing either.
- **Stop hook is opt-in via `claudelink install-hooks`; not auto-installed during `claudelink init`.** Hard gate from v1.1.0 design: don't auto-roll into `~/.claude/settings.json` until each user has consented. The CLI's install logic preserves any pre-existing hooks (idempotent merge by command-name suffix); `--uninstall` reverses cleanly.
- **Claude Code's prompt-injection defense flags external content steering outbound tool calls.** The Stop hook works fine for triggering `read_inbox` (Claude has agency over its own tool calls), but Claude may decline an autonomous `send` reply if it conflates the inbox content with a deviation from the user's most recent prompt. This is responsible safety behavior. The auto-nudge scheduler bypasses this entirely by typing the keystroke (a path Claude treats as user-driven). When debugging "why didn't agent X reply autonomously?" — check `~/.claudelink/auto-fire.log` first; if the hook fired but Claude refused outbound, that's the safety boundary, not a bug.
- **The auto-nudge scheduler is keyed by `agents.tty` and `agents.terminal_app`.** Agents that registered before the v2 schema have NULL there and will be filtered out at the SQL trigger. To bring them under the scheduler, restart their Claude Code sessions so they re-register with v2 columns populated. Avoid manual SQL backfills — risk of mismatching a TTY with the wrong agent.
- **Apple Terminal is currently unsupported by the scheduler dispatch.** AppleScript keystroke into Terminal.app needs Accessibility permission which we don't silently prompt for. tmux + iTerm2 work without permission; everything else logs as "skip" in `scheduler.log`.

## How to ship changes

```bash
# build + globally re-install (live for the next claudelink-server spawn,
# not the running ones)
npm run build && npm install -g .

# kill running servers so the next Claude Code session picks up the new code
ps aux | grep claudelink-server | grep -v grep | awk '{print $2}' | xargs kill

# verify
node dist/ui-bin.js 7878 &  # or start any Claude Code session
curl -sS http://127.0.0.1:7878/api/heartbeat
```

### npm release flow

```bash
# bump (creates commit + tag automatically)
npm version patch    # or minor / major
git push origin main --follow-tags

# preview tarball contents
npm publish --dry-run

# requires interactive npm login (browser OTP). Once logged in:
npm publish

# verify on registry
npm view claudelink version
```

`npm publish` syncs both the package and the README displayed on npmjs.com. Doc-only README changes still need a patch publish if you want them reflected on the package page.

## Autonomous Agent Communication (IMPORTANT)

You are part of a multi-agent team. Other agents are running in separate terminals and may send you messages at any time.

### Automatic Inbox Checking

- **BEFORE starting any task**: Check your inbox using `read_inbox` first
- **AFTER completing any task**: Check your inbox again using `read_inbox`
- If you receive a message, acknowledge it and act on it before moving on
- If a message requires you to change your current work, do so immediately
- If a message is from another agent asking for information, respond using `send` before continuing your own work
- High-priority messages take precedence over your current task

### Autonomous Collaboration

- When you finish a piece of work that another agent might care about, proactively send them an update without being asked
- If you encounter a problem that another agent's role could help with, send them a message asking for help
- When you make a decision that affects the project, post it to the bulletin board
- If you're blocked waiting for another agent, say so and check inbox again

### Example: What autonomous looks like

User says: "Fix the bug in auth.ts"

What you do:
1. Check inbox (maybe the reviewer already sent you details about the bug)
2. Fix the bug
3. Send a message to the reviewer: "Fixed the bug in auth.ts, here's what I changed..."
4. Post to bulletin board: "auth.ts bug fixed — token validation now handles expired tokens"
5. Check inbox again (maybe someone sent something while you were working)

The user should NOT have to tell you to check messages or send updates. Do it automatically.

## Communication Shortcuts

These shorthand phrases map to specific actions:

- **"check response"** or **"check messages"** — Use `read_inbox` to check for new messages
- **"ask the [role]"** — Send a message to that role and check inbox for their reply
- **"tell the [role]"** — Send a one-way message to that role
- **"wait for response"** — Keep checking inbox until a reply arrives
- **"who's online"** — Use `get_agents` to list all connected agents
- **"update the board"** — Use `post_bulletin` to post a status update
- **"check the board"** — Use `get_bulletin` to read the bulletin board
