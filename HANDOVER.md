# ClaudeLink, handover

> **Purpose:** First thing to read when resuming work on the claudelink package itself. `CLAUDE.md` is the always-on directive layer; this file is the session-resume pointer.
>
> **Last session:** 2026-05-04

---

## Current status: FK-prune fix shipped + Command Center UI shipped

Two shippable changes landed on `main` tonight, both pushed to `origin/main` at https://github.com/jaysidd/claudelink:

| Commit | What |
|---|---|
| `e2e075a` | Fix FOREIGN KEY constraint failure in pruneDeadAgents |
| `7b536a5` | Add Command Center UI that auto-launches with the first agent |
| `ee296ab` | Quiet the Command Center when the server is down |

Globally installed (`npm install -g .`). Currently zero `claudelink-server` processes running — was killed at end of session so the user's next `claude` launch boots the new code clean.

## What was wrong

User had 5 ClaudeLink agents across terminals. Closed a terminal abruptly (red-X), orphaning rows in `agents`. On next agent registration, every `register` and `get_agents` call failed with `SQLITE_CONSTRAINT_FOREIGNKEY`.

**Root cause:** `pruneDeadAgents` does `DELETE FROM agents` for any row whose PID is no longer alive. The `messages.from_agent` and `bulletin.from_agent` FKs reference `agents(id)` with no `ON DELETE CASCADE`. Worked silently while SQLite `foreign_keys` was off, but **better-sqlite3 v12 enables `foreign_keys = 1` by default** — so the prune started failing the moment any dead agent had ever sent a message. The agent's own diagnosis (re-pasted in transcript) misattributed this to the INSERT step; it's actually the prune.

Verified live: `PRAGMA foreign_keys` was 1 in better-sqlite3, naive `DELETE FROM agents` for any sender of messages threw `SQLITE_CONSTRAINT_FOREIGNKEY`, but `PRAGMA foreign_key_check` returned 0 violations (i.e. no orphan ROWS — the violations would only manifest at delete time).

## What was fixed

**`src/db.ts` — `pruneDeadAgents` now cascades in a single `db.transaction()`:** delete dependent `messages` and `bulletin` rows first, then the `agents` rows. Avoids a schema migration for existing users (we'd have to rebuild tables to retroactively add `ON DELETE CASCADE`). Test at `/tmp/test-claudelink-prune-fix.js` (transient, OS-cleaned) reproduces the original failure and asserts the fix.

## What was added

**Command Center UI** (`src/ui-server.ts` + `src/ui-launcher.ts` + `src/ui-bin.ts` + `bin/claudelink-ui.js`):

- Local HTTP server on `127.0.0.1:7878`, single-page HTML UI embedded as a template literal (no build step beyond `tsc`).
- Auto-launches on first `claudelink-server` boot via `launchUIIfNeeded()` in `src/index.ts`. Singleton via `~/.claudelink/ui.lock` (PID + port + heartbeat ping). Detached child — survives MCP server exits.
- Endpoints: `/api/state`, `/api/heartbeat`, `/api/kill/:pid`, `/api/kill-all`, `/api/heal`, `/api/remove-stale/:id`, `/api/quit-ui`. Kill endpoints validate the target is a `claudelink-server` (via `ps -p <pid>`) before sending SIGTERM — so the API can't be used to kill arbitrary processes.
- CLI: `claudelink ui` to launch manually, `claudelink ui --stop` to stop. `CLAUDELINK_UI=off` to suppress.
- Disconnected-state UX: after 2 consecutive failures, polling slows from 2s → 10s, an amber banner appears with a "Retry now" button, and unhandled-rejection logs for our own polling are suppressed.

Verified end-to-end before pushing: heartbeat, state, full HTML render, singleton (2nd `launchUIIfNeeded` reuses), real MCP boot path (`node dist/index.js`) auto-launches detached UI, `stopUI()` cleans up.

## Cleanup performed on user's data

- Archived 6 orphan-blocking messages from the dead "Clawless Advisor" (PID 47991) to `~/.claudelink/orphan-messages-archive-20260504-005731.json` (32 KB).
- Deleted those 6 rows in a single `BEGIN IMMEDIATE` transaction. Triggering registration then auto-pruned the 3 dead agent rows (47991, 47745, 38361). Live agents (`Clawdemy-Educational_Site` PID 50937, `clawless-developer` PID 60033) preserved.

## Test plan for next session

User said they'd test in the morning. The natural test:

1. **Auto-launch** — `claude` in any terminal. Browser should open to `http://127.0.0.1:7878` showing the Command Center within ~1s of MCP boot.
2. **Singleton** — open Claude Code in a second terminal. No second tab; the existing one should pick up the new server in its 2s poll.
3. **Disconnected polish** — close all Claude Code sessions, leave the browser tab open. Within 4s the amber banner should appear; polling should drop to 10s.
4. **Heal flow** — fake a stale agent: open two terminals, register agents in both, abruptly close one terminal (red-X). The Command Center should show that agent as `offline` with `msgs_from > 0`. The `Heal orphans` button should clean it up. **This is the exact scenario that bit us today** — should now self-heal in one click.

## Suggested follow-ups (not done — explicit user authorization needed)

- **Bump version + npm publish.** `package.json` is still at `1.0.0`. The FK fix is a real correctness bug that other users will hit; the UI is a substantial feature. Recommend `1.1.0` and `npm publish` so external users get both.
- **Schema migration to add `ON DELETE CASCADE`.** Current cascade is application-level (in `pruneDeadAgents`). A real `ON DELETE CASCADE` in the FK definition would make any future `DELETE FROM agents` path safe by default. Requires `CREATE TABLE` rebuild via migration since `CREATE TABLE IF NOT EXISTS` won't alter existing columns. Lower priority since the only `DELETE FROM agents` path is now fixed.
- **`removeStaleAgent` is callable for live agents too** — the API doesn't refuse to remove a row whose PID is alive. Mostly fine since the registered server will just re-insert on its next register call, but worth a `if (alive) refuse` check if the UI ever gains a "remove live agent" affordance.
- **Token-based auth on the UI.** Currently anything on localhost can hit `/api/kill/:pid`. The `claudelink-server`-only validation contains the blast radius (can only kill claudelink-servers), but for a multi-user system or shared dev box, generate a session token, write to lock file (mode 600), require it in the URL fragment / cookie. Personal-laptop scope makes this low priority.

## Files touched this session

- `src/db.ts` (modified) — cascading pruneDeadAgents
- `src/index.ts` (modified) — call launchUIIfNeeded after MCP boot
- `src/cli.ts` (modified) — `ui` / `ui --stop` commands
- `src/ui-server.ts` (new) — HTTP server + embedded HTML
- `src/ui-launcher.ts` (new) — singleton/lock + browser opener
- `src/ui-bin.ts` (new) — detached-process entry
- `bin/claudelink-ui.js` (new) — bin shim
- `package.json` (modified) — bin entry for `claudelink-ui`
- `CLAUDE.md` (modified) — added project layout, pitfalls, ship-changes sections
- `HANDOVER.md` (new) — this file

`dist/` is gitignored; rebuilt by `npm run build`.

## Known gotchas to remember

- **better-sqlite3 v12 enables foreign_keys by default per connection.** The `sqlite3` CLI defaults differently — don't trust CLI `PRAGMA foreign_keys` results to reflect what the Node process sees.
- **`pruneDeadAgents` runs inside `registerAgent` and `getAgents`.** Any code path that calls those hits the prune. Errors there propagate out as registration failures.
- **The FK enforcement state is per-connection.** Adding `pragma("foreign_keys = OFF")` to the constructor would silently restore pre-v12 behavior — tempting as a one-line workaround, but it would mask future FK bugs. The cascade fix is the right shape.
- **`claudelink init` inlines the agent-behavior CLAUDE.md template in `src/cli.ts` (`CLAUDE_MD_CONTENT`).** This is a separate copy from the project-level `CLAUDE.md` in this repo. When changing the agent-facing instructions, update the constant in `cli.ts` too.
