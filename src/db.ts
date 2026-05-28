import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

export interface Agent {
  id: string;
  role: string;
  description: string | null;
  registered_at: string;
  last_seen: string;
  pid: number;
  alive: boolean;
  tty: string | null;
  terminal_app: string | null;
  pane_id: string | null;
  last_seen_active_ts: number | null;
  autonomous_reply: number;
  // v3: captured from the hook payload (session_id / transcript_path), so a
  // registered agent can be mapped to its EXACT Claude Code session transcript
  // — resolving per-agent attribution even when several agents share one repo
  // dir. NULL until the agent's hook fires at least once (hooks must be installed).
  session_id: string | null;
  transcript_path: string | null;
}

export interface RegisterOptions {
  tty: string | null;
  terminalApp: string | null;
  paneId: string | null;
  autonomousReply: boolean;
}

export interface SendOptions {
  expectsReply?: boolean;
  parentMessageId?: number | null;
}

export interface Message {
  id: number;
  from_role: string;
  from_agent: string;
  to_agent: string | null;
  content: string;
  priority: string;
  created_at: string;
  parent_id: number | null;
  expects_reply: number;
}

export interface BulletinEntry {
  id: number;
  from_role: string;
  from_agent: string;
  content: string;
  created_at: string;
}

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const DB_PATH = path.join(NEXUS_DIR, "nexus.db");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class NexusDB {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(NEXUS_DIR)) {
      fs.mkdirSync(NEXUS_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.migrate();
  }

  private migrate(): void {
    // v1 — initial schema. Idempotent CREATEs so fresh installs land here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        description TEXT,
        registered_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now')),
        pid INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        content TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        read INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (from_agent) REFERENCES agents(id)
      );

      CREATE TABLE IF NOT EXISTS bulletin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (from_agent) REFERENCES agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read);
      CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
    `);

    const userVersion = this.db.pragma("user_version", { simple: true }) as number;

    // v2 — autonomous-reply scaffolding + Path B prep.
    // Rollback (SQLite 3.35+ supports DROP COLUMN; better-sqlite3 v12 ships it):
    //   DROP INDEX IF EXISTS idx_messages_parent;
    //   DROP INDEX IF EXISTS idx_agents_tty;
    //   ALTER TABLE messages DROP COLUMN expects_reply;
    //   ALTER TABLE messages DROP COLUMN parent_id;
    //   ALTER TABLE agents   DROP COLUMN autonomous_reply;
    //   ALTER TABLE agents   DROP COLUMN last_seen_active_ts;
    //   ALTER TABLE agents   DROP COLUMN pane_id;
    //   ALTER TABLE agents   DROP COLUMN terminal_app;
    //   ALTER TABLE agents   DROP COLUMN tty;
    //   PRAGMA user_version = 1;
    if (userVersion < 2) {
      // Wrap the entire v2 step in one transaction so a mid-migration
      // failure (OOM, disk full, kill -9) rolls back cleanly. Otherwise
      // a half-applied migration is unrecoverable: ALTER TABLE ADD COLUMN
      // has no IF NOT EXISTS form, so a re-run would fail on the columns
      // that did land.
      const applyV2 = this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE agents   ADD COLUMN tty TEXT;
          ALTER TABLE agents   ADD COLUMN terminal_app TEXT;
          ALTER TABLE agents   ADD COLUMN pane_id TEXT;
          ALTER TABLE agents   ADD COLUMN last_seen_active_ts INTEGER;
          ALTER TABLE agents   ADD COLUMN autonomous_reply INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE messages ADD COLUMN parent_id INTEGER;
          ALTER TABLE messages ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 1;
          CREATE INDEX IF NOT EXISTS idx_agents_tty ON agents(tty);
          CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
          PRAGMA user_version = 2;
        `);
      });
      applyV2();
    }

    // v3 — session identity for exact agent->transcript mapping. Additive,
    // nullable; populated from the hook payload (session_id / transcript_path).
    // Rollback:
    //   ALTER TABLE agents DROP COLUMN transcript_path;
    //   ALTER TABLE agents DROP COLUMN session_id;
    //   PRAGMA user_version = 2;
    if (userVersion < 3) {
      const applyV3 = this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE agents ADD COLUMN session_id TEXT;
          ALTER TABLE agents ADD COLUMN transcript_path TEXT;
          PRAGMA user_version = 3;
        `);
      });
      applyV3();
    }
  }

  registerAgent(
    role: string,
    description: string | null,
    pid: number,
    opts: RegisterOptions
  ): string {
    this.pruneDeadAgents();

    // Enforce one-live-agent-per-TTY. If a tty is provided and another row
    // already holds it, the holder is either:
    //   (a) live  → hard fail with a clear message (the user has two Claude
    //       Code sessions in the same terminal pane, which is the footgun
    //       this guard exists to catch)
    //   (b) dead  → defensive cleanup (pruneDeadAgents already runs above so
    //       this is unreachable in normal flow, but we don't want to rely on
    //       liveness probe edge cases)
    if (opts.tty) {
      const existing = this.db
        .prepare(`SELECT id, role, pid FROM agents WHERE tty = ?`)
        .get(opts.tty) as { id: string; role: string; pid: number } | undefined;
      if (existing) {
        if (isProcessAlive(existing.pid)) {
          throw new Error(
            `TTY ${opts.tty} is already registered to agent "${existing.role}" (pid ${existing.pid}). ` +
              `Deregister that agent first or open a new terminal.`
          );
        }
        const cleanupStale = this.db.transaction(() => {
          this.db.prepare(`DELETE FROM messages WHERE from_agent = ?`).run(existing.id);
          this.db.prepare(`DELETE FROM bulletin WHERE from_agent = ?`).run(existing.id);
          this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(existing.id);
        });
        cleanupStale();
      }
    }

    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO agents (id, role, description, pid, tty, terminal_app, pane_id, autonomous_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        role,
        description,
        pid,
        opts.tty,
        opts.terminalApp,
        opts.paneId,
        opts.autonomousReply ? 1 : 0
      );

    return id;
  }

  getAgentByTty(tty: string): Agent | null {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE tty = ?`)
      .get(tty) as Omit<Agent, "alive"> | undefined;
    if (!row) return null;
    return { ...row, alive: isProcessAlive(row.pid) };
  }

  heartbeat(agentId: string): void {
    this.db
      .prepare(`UPDATE agents SET last_seen = datetime('now') WHERE id = ?`)
      .run(agentId);
  }

  // Stamp the moment the Stop hook fired for this agent's terminal. Used by
  // Path B's idle-detection: a UI watcher that sees a registered agent whose
  // last_seen_active_ts is older than X minutes can fall back to terminal
  // injection rather than trusting the in-flight Stop hook to handle a new
  // message.
  updateLastSeenActive(agentId: string): void {
    this.db
      .prepare(`UPDATE agents SET last_seen_active_ts = ? WHERE id = ?`)
      .run(Date.now(), agentId);
  }

  // Walk the parent_id chain backwards from a message and return the chain
  // length (1 = root, no parent). Used by the Stop hook's chain cap to break
  // A→B→A→B... ping-pong loops at a configurable hop limit.
  // Cycle-safe via a seen-set; in practice messages.parent_id should form a
  // strict DAG since each new message gets a fresh autoincrement id, but we
  // don't trust the schema to be free of operator error.
  getChainLength(messageId: number): number {
    let length = 1;
    let current: number | null = messageId;
    const seen = new Set<number>();
    while (current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
      const row = this.db
        .prepare(`SELECT parent_id FROM messages WHERE id = ?`)
        .get(current) as { parent_id: number | null } | undefined;
      if (!row || row.parent_id === null) break;
      current = row.parent_id;
      length++;
    }
    return length;
  }

  getAgents(): Agent[] {
    this.pruneDeadAgents();

    const rows = this.db
      .prepare(`SELECT * FROM agents ORDER BY registered_at DESC`)
      .all() as Omit<Agent, "alive">[];

    return rows.map((row) => ({
      ...row,
      alive: isProcessAlive(row.pid),
    }));
  }

  sendMessage(
    fromId: string,
    toRole: string,
    content: string,
    priority: string = "normal",
    opts: SendOptions = {}
  ): number {
    const targets = this.db
      .prepare(`SELECT id FROM agents WHERE role = ?`)
      .all(toRole) as { id: string }[];

    if (targets.length === 0) {
      throw new Error(
        `No agent found with role "${toRole}". Use get_agents to see available agents.`
      );
    }

    const expectsReply = opts.expectsReply !== false ? 1 : 0;
    const parentId = opts.parentMessageId ?? null;

    const insert = this.db.prepare(
      `INSERT INTO messages (from_agent, to_agent, content, priority, expects_reply, parent_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const sendAll = this.db.transaction(() => {
      for (const target of targets) {
        insert.run(fromId, target.id, content, priority, expectsReply, parentId);
      }
    });

    sendAll();
    return targets.length;
  }

  broadcastMessage(fromId: string, content: string, opts: SendOptions = {}): void {
    const expectsReply = opts.expectsReply !== false ? 1 : 0;
    const parentId = opts.parentMessageId ?? null;
    this.db
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, content, priority, expects_reply, parent_id)
         VALUES (?, NULL, ?, 'normal', ?, ?)`
      )
      .run(fromId, content, expectsReply, parentId);
  }

  // Read-only inbox inspection. Returns unread messages addressed to this
  // agent WITHOUT marking them read. Used by the Stop hook to count and
  // filter eligible messages for the auto-fire decision. The actual mark-
  // read happens later when Claude calls the read_inbox MCP tool from the
  // continuation — that path has Claude's agency, so its safety layer
  // accepts the tool result; injecting message contents directly into the
  // continuation reason would be flagged as prompt injection.
  peekInbox(agentId: string): Message[] {
    return this.db
      .prepare(
        `SELECT id, from_agent, to_agent, content, priority, created_at,
                parent_id, expects_reply,
                (SELECT role FROM agents WHERE id = messages.from_agent) AS from_role
         FROM messages
         WHERE (to_agent = ? OR to_agent IS NULL)
           AND from_agent != ?
           AND read = 0
         ORDER BY created_at ASC`
      )
      .all(agentId, agentId) as Message[];
  }

  readInbox(agentId: string): Message[] {
    // Atomic claim: UPDATE...RETURNING marks rows read AND returns them in
    // one statement, removing the SELECT-then-UPDATE snapshot-staleness
    // window. from_role is resolved via correlated subquery in RETURNING
    // (SQLite 3.35+ supports expressions in RETURNING). RETURNING does not
    // guarantee order, so we sort in JS afterwards.
    const rows = this.db
      .prepare(
        `UPDATE messages SET read = 1
         WHERE (to_agent = ? OR to_agent IS NULL)
           AND from_agent != ?
           AND read = 0
         RETURNING id,
                   from_agent,
                   to_agent,
                   content,
                   priority,
                   created_at,
                   parent_id,
                   expects_reply,
                   (SELECT role FROM agents WHERE id = messages.from_agent) AS from_role`
      )
      .all(agentId, agentId) as Message[];

    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return rows;
  }

  postBulletin(fromId: string, content: string): void {
    this.db
      .prepare(`INSERT INTO bulletin (from_agent, content) VALUES (?, ?)`)
      .run(fromId, content);
  }

  getBulletin(limit: number = 10): BulletinEntry[] {
    return this.db
      .prepare(
        `SELECT b.id, b.from_agent, b.content, b.created_at,
                a.role as from_role
         FROM bulletin b
         LEFT JOIN agents a ON b.from_agent = a.id
         ORDER BY b.created_at DESC
         LIMIT ?`
      )
      .all(limit) as BulletinEntry[];
  }

  setAutonomousReply(agentId: string, enabled: boolean): boolean {
    const r = this.db
      .prepare(`UPDATE agents SET autonomous_reply = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, agentId);
    return r.changes > 0;
  }

  // Stamp the agent's Claude Code session identity, captured from a hook
  // payload. Idempotent: only writes when a value actually changes, so the
  // common case (same session firing the hook repeatedly) is a cheap no-op.
  setAgentSession(
    agentId: string,
    sessionId: string | null,
    transcriptPath: string | null
  ): boolean {
    const row = this.db
      .prepare(`SELECT session_id, transcript_path FROM agents WHERE id = ?`)
      .get(agentId) as { session_id: string | null; transcript_path: string | null } | undefined;
    if (!row) return false;
    if (row.session_id === (sessionId ?? null) && row.transcript_path === (transcriptPath ?? null)) {
      return false; // unchanged — skip the write
    }
    const r = this.db
      .prepare(`UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?`)
      .run(sessionId ?? null, transcriptPath ?? null, agentId);
    return r.changes > 0;
  }

  pruneDeadAgents(): void {
    const agents = this.db
      .prepare(`SELECT id, pid FROM agents`)
      .all() as { id: string; pid: number }[];

    const deadIds = agents
      .filter((a) => !isProcessAlive(a.pid))
      .map((a) => a.id);

    if (deadIds.length === 0) return;

    // messages.from_agent and bulletin.from_agent FK -> agents(id) without
    // ON DELETE CASCADE. better-sqlite3 v12 enables foreign_keys by default,
    // so we must clear dependent rows before the agent rows, atomically.
    const placeholders = deadIds.map(() => "?").join(",");
    const deleteMessages = this.db.prepare(
      `DELETE FROM messages WHERE from_agent IN (${placeholders})`
    );
    const deleteBulletin = this.db.prepare(
      `DELETE FROM bulletin WHERE from_agent IN (${placeholders})`
    );
    const deleteAgents = this.db.prepare(
      `DELETE FROM agents WHERE id IN (${placeholders})`
    );

    const prune = this.db.transaction(() => {
      deleteMessages.run(...deadIds);
      deleteBulletin.run(...deadIds);
      deleteAgents.run(...deadIds);
    });
    prune();
  }

  close(): void {
    this.db.close();
  }
}
