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
  }

  registerAgent(role: string, description: string | null, pid: number): string {
    this.pruneDeadAgents();

    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO agents (id, role, description, pid) VALUES (?, ?, ?, ?)`
      )
      .run(id, role, description, pid);

    return id;
  }

  heartbeat(agentId: string): void {
    this.db
      .prepare(`UPDATE agents SET last_seen = datetime('now') WHERE id = ?`)
      .run(agentId);
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
    priority: string = "normal"
  ): number {
    const targets = this.db
      .prepare(`SELECT id FROM agents WHERE role = ?`)
      .all(toRole) as { id: string }[];

    if (targets.length === 0) {
      throw new Error(
        `No agent found with role "${toRole}". Use get_agents to see available agents.`
      );
    }

    const insert = this.db.prepare(
      `INSERT INTO messages (from_agent, to_agent, content, priority) VALUES (?, ?, ?, ?)`
    );

    const sendAll = this.db.transaction(() => {
      for (const target of targets) {
        insert.run(fromId, target.id, content, priority);
      }
    });

    sendAll();
    return targets.length;
  }

  broadcastMessage(fromId: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, content, priority) VALUES (?, NULL, ?, 'normal')`
      )
      .run(fromId, content);
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
