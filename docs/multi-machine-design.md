# ClaudeLink Multi-Machine Design (v1.2)

**Status:** Approved — Phase 0 sign-off complete on 2026-05-08. Phase 1 build cleared to start.
**Last updated:** 2026-05-08
**Owner:** Junaid

## Goal

Run a single ClaudeLink mesh across two laptops on a home LAN, so an advisor agent on laptop A can send a message to a developer agent on laptop B and the developer's terminal gets nudged automatically. The user-facing experience should be indistinguishable from today's single-machine flow except for a small `🖥 hostname` chip on each agent row.

## Non-goals (v1.2)

- Multi-machine across the public Internet, hostile networks, hotel WiFi
- TLS / mTLS — bearer-token auth only, scoped to LAN
- More than two machines (it should "just work" but isn't a tested path)
- Hub failover or HA. If the hub is offline, the spoke is offline. The user accepts this — both laptops stay on during work.
- State replication, CRDTs, peer-to-peer DB. The DB lives in exactly one place.
- Encryption at rest. Out of scope for v1.2; tracked as a separate roadmap item.
- Apple Terminal support on the spoke. Still gated by the existing Accessibility-prompt issue. iTerm2 / tmux only.

## Architecture

Hub-and-spoke. One laptop owns the source of truth; the other talks to it over HTTP.

```
LAPTOP A (HUB)                              LAPTOP B (SPOKE)
┌────────────────────────────────┐          ┌──────────────────────────────────┐
│ ~/.claudelink/nexus.db         │          │ (no local DB)                    │
│                                │          │                                  │
│ ui-server :7878 (LAN-bound)    │◀── HTTP ─│ claudelink-spoke daemon          │
│   GET  /                       │          │   ├─ short-polls /api/v1/dispatch│
│   GET  /api/v1/inbox           │          │   └─ types into local iTerm/tmux │
│   POST /api/v1/send            │          │                                  │
│   POST /api/v1/register        │          │ claudelink-server (per Claude    │
│   GET  /api/v1/dispatch        │          │   Code instance)                 │
│   ... (full surface below)     │          │   tools call HTTP, not SQLite    │
│                                │          │                                  │
│ in-process scheduler           │          │                                  │
│   dispatches for host=local    │          │                                  │
│                                │          │                                  │
│ claudelink-server (per Claude  │          │                                  │
│   Code instance) talks to      │          │                                  │
│   local DB directly            │          │                                  │
└────────────────────────────────┘          └──────────────────────────────────┘
```

Three operational modes, configured via `~/.claudelink/config.json`:

| Mode | DB | UI | Scheduler | When |
|---|---|---|---|---|
| `local` (default, today's behavior) | local SQLite | loopback | local | Single laptop |
| `hub` | local SQLite | LAN-bound | local + dispatch queue | The "owns the data" laptop |
| `spoke` | none, HTTP to hub | none | spoke daemon (keystroke only) | The "remote" laptop |

Backward compat: a v1.1.x install with no `config.json` defaults to `local`. Zero behavior change.

## End-to-end walkthrough

Advisor on laptop A (hub) sends to a developer agent registered on laptop B (spoke).

1. **Spoke registration.** When developer's Claude Code starts on B, its `claudelink-server` reads `config.json`, sees `mode: spoke`, and POSTs `/api/v1/register` to the hub with `{role, hostname: "macbook-b", tty, terminal_app: "iTerm2", pane_id, ...}`. Hub writes one row to the `agents` table with `host="macbook-b"`.
2. **Send.** Advisor's MCP `send` tool runs locally on the hub, hits the local DB directly (it's hub-mode for itself), inserts a `messages` row addressed to developer's agent_id.
3. **Spoke poll.** Spoke daemon on B short-polls `GET /api/v1/dispatch?host=macbook-b` every 3 seconds. Hub returns the list of agent_ids on host `macbook-b` that have unread mail (and aren't in cooldown).
4. **Local nudge.** Spoke daemon types `check for updates` into the right iTerm2 tab (uses today's `scheduler.ts` keystroke code, just running on the spoke).
5. **Developer reads.** Claude Code on B picks up the keystroke, the stop hook fires, developer calls `read_inbox` via its `claudelink-server` — which now POSTs `/api/v1/inbox` to the hub instead of touching local SQLite. Hub atomically marks-read and returns the messages.
6. **Reply.** Developer calls `send` back. Same path in reverse. Advisor on the hub picks it up via local DB read or via its own stop hook.

The advisor never knows where the developer was running. The developer never knows the DB is remote. Same MCP tool surface for both.

## Components

### What changes (existing files)

| File | Change |
|---|---|
| `src/db.ts` | Refactored. `NexusDB` becomes one implementation of a new `NexusBackend` interface. Adds `host` column to `agents` (schema v3 migration). |
| `src/index.ts` | At MCP boot, read `config.json`. Instantiate `LocalNexusBackend` (hub/local) or `RemoteNexusBackend` (spoke). All tool handlers call the abstraction. |
| `src/scheduler.ts` | The keystroke-dispatch code becomes a library function callable from both the in-process hub scheduler AND the new spoke daemon. The "find agents with unread mail" SQL query becomes a hub-side function exposed via `/api/v1/dispatch`. |
| `src/ui-server.ts` | New `/api/v1/...` endpoints. Bind address becomes configurable. Bearer-token middleware on `/api/v1/...`. Agent rows in the HTML show a `host` chip. |
| `src/cli.ts` | New flags: `claudelink init --hub`, `claudelink init --spoke <url> --token <t>`. New command: `claudelink token` (print/regenerate, hub-only). `status` shows mode. |
| `src/ui-launcher.ts` | On hub mode, prints LAN IP + token + spoke setup snippet on first launch. |

### What's new

| File | Role |
|---|---|
| `src/nexus-backend.ts` | The interface both implementations satisfy. |
| `src/remote-nexus.ts` | HTTP client implementation. Used by spoke-mode MCP servers. |
| `src/config.ts` | Reads/writes `~/.claudelink/config.json`. Defines mode, hub URL, token, bind address. |
| `src/auth.ts` | Token generation, persistence at `~/.claudelink/token` mode 0600, middleware. |
| `src/spoke-daemon.ts` + `src/spoke-bin.ts` | Standalone process. Lock at `~/.claudelink/spoke.lock`. Short-polls hub every 3s (override via `CLAUDELINK_POLL_MS`), dispatches local keystrokes. **Does not heartbeat on behalf of agents** — each `claudelink-server` updates its own `last_seen_active_ts`, so a crashed Claude Code instance correctly shows stale in the UI. |
| `bin/claudelink-spoke.js` | Shim, registered in `package.json` `bin`. |

## Schema (v3 migration)

In-place additive migration, wrapped in transaction, gated by `PRAGMA user_version`.

```sql
ALTER TABLE agents ADD COLUMN host TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_agents_host_tty ON agents(host, tty);
PRAGMA user_version = 3;
```

Existing rows get `host=''`. Hub backfills its own rows on first scheduler tick (`UPDATE agents SET host=? WHERE host='' AND pid IN (local_pids)`). Spoke registrations populate `host` on insert. No FK changes needed — `messages.agent_id` and `bulletin.agent_id` both reference UUIDs which are globally unique already.

## HTTP API contract

All `/api/v1/...` endpoints require `Authorization: Bearer <token>` (when token is configured, which is the default for hub mode).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `POST` | `/api/v1/register` | `{role, capabilities, autonomous_reply, hostname, tty, terminal_app, pane_id}` | `{agent_id, host}` |
| `POST` | `/api/v1/send` | `{from_role, to_role, content, expects_reply?, parent_message_id?}` | `{message_ids[]}` |
| `POST` | `/api/v1/broadcast` | `{from_role, content}` | `{message_ids[]}` |
| `GET` | `/api/v1/inbox` | `?agent_id=...` | `{messages[]}` (atomic mark-read) |
| `GET` | `/api/v1/inbox/peek` | `?agent_id=...` | `{messages[]}` (non-consuming) |
| `GET` | `/api/v1/agents` | — | `{agents[]}` |
| `POST` | `/api/v1/bulletin` | `{from_role, content}` | `{bulletin_id}` |
| `GET` | `/api/v1/bulletin` | — | `{entries[]}` |
| `POST` | `/api/v1/heartbeat` | `{agent_id}` | `{ok}` |
| `GET` | `/api/v1/dispatch` | `?host=...` | `{agent_ids_with_unread[]}` |
| `GET` | `/api/v1/topology` | — | `{hub_url, spokes_seen[], schema_version}` |

Existing `/api/state`, `/api/heartbeat`, `/api/heal`, `/api/kill/*`, `/api/agents/:id/autonomous`, `/api/scheduler` — unchanged. Token-protected on hub.

## Configuration

`~/.claudelink/config.json`:

```json
{
  "mode": "hub",
  "bindAddress": "192.168.1.42",
  "port": 7878,
  "token": null
}
```

Spoke version:

```json
{
  "mode": "spoke",
  "remote": "http://192.168.1.42:7878",
  "token": "8f1a...e2c4"
}
```

`~/.claudelink/token` (hub-only, mode 0600): the bearer token. Generated on `claudelink init --hub` first run; rotatable via `claudelink token --rotate`.

## CLI surface

```bash
# Local mode (today's behavior; default if no flag)
claudelink init

# Hub setup
claudelink init --hub
# → Detects en0 LAN IP. Generates token. Writes config.json. Prints:
#
#   ClaudeLink hub ready at http://192.168.1.42:7878
#   Token: 8f1ae2c4...
#   On the spoke laptop run:
#     claudelink init --spoke http://192.168.1.42:7878 --token 8f1ae2c4...

# Spoke setup
claudelink init --spoke <hub-url> --token <token>
# → Verifies hub is reachable + token is valid. Backs up any existing
#   ~/.claudelink/nexus.db to nexus.db.backup-<ts>. Writes config.json.

# Switch hub later
claudelink init --hub --import ~/Downloads/nexus.db   # adopts a transferred DB

# Status
claudelink status
# → Mode: hub
#   Bind: 192.168.1.42:7878
#   Agents: 4 (3 local, 1 on macbook-b)
#   Schema: v3
```

## Security model

- **Bearer token.** 32-byte random, hex-encoded. Stored at `~/.claudelink/token` mode 0600. Token is required for all `/api/v1/...` AND `/api/...` calls when set.
- **Browser token UX.** Loopback access (`http://127.0.0.1:7878` on the hub itself) is unauthenticated. LAN access requires the token. First visit is `http://<hub-ip>:7878?token=<token>` — the page reads the token from the query string, sets an HTTP-only cookie, and redirects to the bare URL. After that the cookie carries the token automatically for that browser. One paste per browser per laptop, ever.
- **Bind address.** Hub binds to a specific LAN IP (e.g. `192.168.1.42`), not `0.0.0.0`. This avoids accidentally exposing the hub on a hotel WiFi or Tailscale interface. Override via `--bind` flag.
- **No TLS in v1.2.** Documented as LAN-only. Token is the only barrier; on a hostile LAN this is not enough. Acceptable for the user's home-office scope.
- **Token rotation.** `claudelink token --rotate` regenerates on the hub and prints the new token; spokes need to be re-pointed manually. Not graceful, but rare.

## Failure modes

| Scenario | Behavior |
|---|---|
| Hub unreachable from spoke | MCP tool calls return `MCPError("hub unreachable: ...")`. Spoke daemon backs off exponentially up to 30s, retries indefinitely. Claude Code agents on the spoke see clear error messages in chat. |
| 401 (token mismatch) | Tool call surfaces the auth error verbatim. Spoke daemon stops polling and writes a one-line warning to `~/.claudelink/spoke.log` until config is fixed. |
| Schema version mismatch (older spoke binary against newer hub) | Hub returns `426 Upgrade Required`. Spoke logs a clear message. |
| Hub restarts while spoke is running | Spoke MCP servers' next call gets a fresh connection. Agents may need to re-register (handled via `404 agent_not_found` → MCP server transparently re-registers). |
| Two machines with same hostname | First registration wins. Second is auto-suffixed with the first 4 hex chars of the machine's `machineId` (or a random 4-char hex if `machineId` is unavailable), e.g. `macbook-pro` and `macbook-pro-a3f1`. The Command Center shows the disambiguated host transparently; user does nothing. A `WARN` line is logged to `spoke.log` so the collision is auditable. |
| Spoke laptop sleeps mid-conversation | Existing in-flight messages stay queued in hub DB. On wake, spoke daemon resumes polling, picks up nudges. No data loss. |

## Phased build plan

Each phase is shippable in isolation. Local-mode users see no change until Phase 4 (which adds the new CLI flags and is opt-in).

| Phase | Deliverable | Tests required | Done when |
|---|---|---|---|
| **0. Design** | This doc | User sign-off | Junaid approves the doc |
| **1. Backend abstraction** | `NexusBackend` interface, `LocalNexusBackend` extracted from current `NexusDB`. All MCP tool handlers call the interface. No behavior change. | Existing single-machine tests still pass | All current MCP tools work identically on local mode |
| **2. Schema v3** | `host` column + index + migration. Backfill on hub registration. | Migration on a fresh DB and on a v2 DB. | `PRAGMA user_version = 3` on upgraded DBs, no row corruption |
| **3. Hub HTTP API** | `/api/v1/...` endpoints on the UI server. Token middleware. Hub mode in config. | Curl-driven smoke test of every endpoint with valid + invalid tokens | All endpoints return correct shapes and 401 on bad token |
| **4. Auth + LAN bind + `init --hub`** | Token persistence, bind-address selection, CLI flow. | `claudelink init --hub` on a fresh machine produces a working LAN-accessible hub | Curl from another LAN device (phone, browser) hits the hub successfully |
| **5. RemoteNexusBackend + `init --spoke`** | HTTP client backend. Spoke MCP mode. CLI sets up spoke. | A spoke-mode MCP server can register, send, read_inbox against a hub on the same machine for testing | All tools work via HTTP, end-to-end |
| **6. Spoke daemon** | `claudelink-spoke` binary. Polls hub, dispatches local keystrokes. Lock-file singleton. | Manual: agent on spoke gets nudged when hub flags it | Keystrokes land in the right iTerm2 tab on the spoke |
| **7. Command Center UI** | Host chip on agent rows. Topology section. Token-aware HTML serving. | Visual verification on both machines | UI shows agents from both hosts correctly |
| **8. End-to-end on real two-laptop setup** | Run advisor on laptop A, developer on laptop B (M5), do a real conversation, run for an hour. | Real-world soak test | Advisor → developer → reply round-trip works without manual intervention |

## Test plan

CI can't run multi-machine integration. Manual test matrix on the actual two laptops:

1. **Cold install** — fresh `npm install -g claudelink` on both. Hub init on A, spoke init on B. No prior state.
2. **Round-trip messaging** — advisor on A sends to developer on B. Developer's iTerm2 tab gets nudged. Developer reads, replies. Advisor reads.
3. **Broadcast** — bulletin post on A, both A and B agents see it.
4. **Hub restart** — kill `claudelink-server` on A. Spoke retries. Restart hub. Spoke resumes.
5. **Token mismatch** — change hub token. Spoke gets 401. Helpful error in `spoke.log`.
6. **One-hour soak** — run a real coding session with agents on both machines.
7. **Mid-session laptop sleep** — close laptop B's lid for 10 minutes. Reopen. Pending messages flush, no duplicates.

## Resolved decisions (Phase 0 sign-off, 2026-05-08)

1. **Polling interval — short-poll at 3s.** Configurable via `CLAUDELINK_POLL_MS` env var. Long-poll considered and rejected for v1.2 — short-poll is debuggable, dumb, and fine on a home LAN.
2. **Heartbeat semantics — MCP-driven.** Each `claudelink-server` updates its own `last_seen_active_ts`. The spoke daemon does NOT heartbeat on behalf of agents. Honest > pretty: a crashed Claude Code instance correctly shows stale in the UI, and the existing Heal button cleans it up.
3. **Browser token UX — query-param-on-first-visit + cookie.** First LAN load is `http://<hub-ip>:7878?token=<token>`; the page sets an HTTP-only cookie and redirects to the bare URL. Subsequent loads in that browser use the cookie. Loopback access on the hub itself is unauthenticated.
4. **Hostname collision — auto-suffix with machine-id.** When two laptops register with the same hostname, the second is appended with the first 4 hex chars of `machineId` (e.g. `macbook-pro-a3f1`). User does nothing; the Command Center shows the disambiguated host. A `WARN` line in `spoke.log` makes the collision auditable.

## Future open questions (post-v1.2)

None right now. Add as they arise.

## Future work (post-v1.2)

- TLS via self-signed cert + pinning (so it works over Tailscale/WireGuard cleanly)
- Multiple spokes — should mostly work, formalize testing
- Spoke-side Command Center (read-only mirror of the hub)
- Encryption at rest on the DB
- Apple Terminal support (paired with the broader Accessibility-prompt plan)
- Cross-WAN deployments via a gateway pattern

## Sign-off

This doc is the contract for the v1.2 build. Phase 1 doesn't start until Junaid signs off. Changes to scope or design after sign-off should land here as edits with a dated note in the change log below.

### Change log

- **2026-05-08** — Initial draft.
- **2026-05-08** — Phase 0 sign-off. Open questions 1-4 resolved: 3s short-poll, MCP-driven heartbeat, query-param-on-first-visit + cookie for browser auth, auto-suffix with machine-id on hostname collision. Phase 1 cleared to start.
