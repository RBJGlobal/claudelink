// HTTP smoke against the Command Center's API. Verifies the shape of the
// endpoints we depend on without booting the full UI services (scheduler /
// recovery watcher / context watcher / notifier are skipped via
// CLAUDELINK_UI_NO_SERVICES=1).
//
// Isolation:
// - CLAUDELINK_DB_PATH points at a temp DB (set before NexusDB construction)
// - CLAUDELINK_UI_NO_SERVICES=1 keeps the test from spawning real watchers
// - The server binds to port 0 (OS-assigned) to avoid colliding with the
//   live Command Center on :7878.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claudelink-http-"));
process.env.CLAUDELINK_DB_PATH = path.join(TMP_DIR, "nexus.db");
process.env.CLAUDELINK_UI_NO_SERVICES = "1";

// Plant a few agents so endpoints have something to return.
import { NexusDB } from "../src/db.js";
const db = new NexusDB();
db.registerAgent("smoke-agent", "smoke test", process.pid, {
  tty: null,
  terminalApp: null,
  paneId: null,
  autonomousReply: true,
});

import { startUIServer } from "../src/ui-server.js";

let server: http.Server;
let port: number;

test.before(async () => {
  server = startUIServer(0); // port 0 = OS-assigned
  // Wait for listen.
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(p: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${p}`, (res) => {
        let chunks = "";
        res.setEncoding("utf-8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          let body: any = chunks;
          try {
            body = JSON.parse(chunks);
          } catch {
            /* HTML, etc. */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on("error", reject);
  });
}

async function postJSON(p: string, payload: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf-8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          let body: any = chunks;
          try {
            body = JSON.parse(chunks);
          } catch {
            /* */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---- Heartbeat ----

test("GET /api/heartbeat returns ok + pid", async () => {
  const r = await get("/api/heartbeat");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.pid, "number");
});

// ---- HTML ----

test("GET / returns HTML with the Command Center title", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, "string", "HTML response");
  assert.ok(
    (r.body as string).includes("ClaudeLink"),
    "page identifies as ClaudeLink"
  );
});

test("GET /favicon.svg returns SVG", async () => {
  const r = await get("/favicon.svg");
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, "string");
  assert.ok((r.body as string).includes("<svg"), "looks like SVG");
});

// ---- State ----

test("GET /api/state returns expected top-level shape", async () => {
  const r = await get("/api/state");
  assert.equal(r.status, 200);
  // Documented in CLAUDE.md: { servers, agents, health, recent_messages }
  assert.ok("servers" in r.body, "has servers");
  assert.ok("agents" in r.body, "has agents");
  assert.ok("health" in r.body, "has health");
  assert.ok("recent_messages" in r.body, "has recent_messages");
});

test("GET /api/state agents include the smoke-agent we planted", async () => {
  const r = await get("/api/state");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.agents));
  const me = r.body.agents.find((a: any) => a.role === "smoke-agent");
  assert.ok(me, "smoke-agent must appear in /api/state");
});

// ---- Context-watcher settings GET / POST ----

test("GET /api/context-watcher returns the settings shape", async () => {
  const r = await get("/api/context-watcher");
  assert.equal(r.status, 200);
  assert.ok("enabled" in r.body);
  assert.ok("mode" in r.body);
  assert.ok("injectAllowlist" in r.body);
  assert.ok(Array.isArray(r.body.injectAllowlist));
});

test("POST /api/context-watcher with a valid partial returns merged settings", async () => {
  // Test isolation: settings.test.ts already pointed at a tmp file via env;
  // we reuse that mechanism here.
  process.env.CLAUDELINK_CONTEXT_WATCHER_SETTINGS = path.join(
    TMP_DIR,
    "ctxw.json"
  );
  const r = await postJSON("/api/context-watcher", {
    injectAllowlist: ["smoke-role"],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.injectAllowlist, ["smoke-role"]);
  // Round-trip via GET.
  const r2 = await get("/api/context-watcher");
  assert.deepEqual(r2.body.injectAllowlist, ["smoke-role"]);
});

test("POST /api/context-watcher with garbage body returns 400", async () => {
  // Send a Content-Type: application/json with an invalid JSON body.
  const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/context-watcher",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "5",
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf-8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          let body: any = chunks;
          try {
            body = JSON.parse(chunks);
          } catch {
            /* */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    req.write("not-j"); // 5 bytes of nonsense
    req.end();
  });
  assert.equal(r.status, 400);
});

// ---- Recovery watcher settings GET ----

test("GET /api/recovery-watcher returns the settings shape", async () => {
  const r = await get("/api/recovery-watcher");
  assert.equal(r.status, 200);
  assert.ok("enabled" in r.body);
  assert.ok("recoveryMessage" in r.body);
});

// ---- Scheduler settings GET ----

test("GET /api/scheduler returns the settings shape", async () => {
  const r = await get("/api/scheduler");
  assert.equal(r.status, 200);
  assert.ok("enabled" in r.body);
  assert.ok("intervalMin" in r.body);
});

// ---- Usage endpoint (read-only) ----

test("GET /api/usage returns a per-window usage shape", async () => {
  const r = await get("/api/usage?days=1");
  assert.equal(r.status, 200);
  // Don't deep-assert; just ensure the request succeeds and returns an
  // object/array. The real meter scans transcripts that may not exist in
  // a temp env.
  assert.ok(r.body !== null);
});

test("GET /api/agent-timeline returns a list", async () => {
  const r = await get("/api/agent-timeline");
  assert.equal(r.status, 200);
  // Same: just round-trip. Body shape varies by transcript availability.
  assert.ok(r.body !== null);
});

// ---- 404 ----

test("GET /api/nonexistent returns 404", async () => {
  const r = await get("/api/nonexistent");
  assert.equal(r.status, 404);
});
