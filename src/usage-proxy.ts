// Usage proxy — a transparent localhost passthrough to api.anthropic.com that
// scrapes the `anthropic-ratelimit-unified-*` response headers into a small
// local JSON file so the Command Center can render your Pro/Max session +
// weekly usage (the numbers you'd otherwise open Claude Desktop → Settings →
// Usage to see).
//
// SECURITY / DESIGN CONTRACT — this sits in your API auth path, so:
//   1. It NEVER reads, stores, or logs the request Authorization / x-api-key
//      headers. They are forwarded verbatim and otherwise untouched.
//   2. It only ever inspects RESPONSE headers, and only the rate-limit ones.
//   3. It is a transparent pipe: request and response bodies are streamed, not
//      buffered, and no timeouts are imposed (Claude responses stream for
//      minutes — a timeout would break your sessions).
//   4. It fails OPEN: an upstream error returns 502 to the client but never
//      crashes the proxy, and a write failure is swallowed (the widget going
//      stale must never affect your actual Claude Code traffic).
//   5. It binds to 127.0.0.1 only. Never exposed off-host.
//
// This is opt-in and personal: nothing starts it unless you run
// `claudelink usage --on`. A fresh install never routes any traffic here.

import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";

const UPSTREAM_HOST = "api.anthropic.com";

export const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
export const QUOTA_PATH = path.join(NEXUS_DIR, "quota.json");
export const PROXY_LOCK_PATH = path.join(NEXUS_DIR, "quota-proxy.lock");
export const DEFAULT_PROXY_PORT = 8788;

// The only response headers we ever look at.
function isRateLimitHeader(k: string): boolean {
  return /^anthropic-ratelimit-|^retry-after$/i.test(k);
}

function num(v: unknown): number | null {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  return String(Array.isArray(v) ? v[0] : v);
}

interface Window {
  utilization: number | null;
  resetEpoch: number | null;
  status: string | null;
}

// The Fable weekly pool rides on the `unified-7d_oi-*` headers, which are only
// returned on Fable responses (Haiku/Opus/Sonnet calls don't carry them). It
// therefore gets its OWN capturedAtMs so it can be carried forward across
// non-Fable requests and show an accurate "as of" independent of the session/
// weekly meters (which refresh on every call).
interface FableWindow extends Window {
  capturedAtMs: number;
}

export interface QuotaRecord {
  capturedAt: string; // ISO
  capturedAtMs: number;
  overallStatus: string | null; // allowed | allowed_warning | rejected
  binding: string | null; // representative-claim, e.g. "five_hour"
  session: Window | null;
  weekly: Window | null;
  fable: FableWindow | null; // separate Fable weekly pool (unified-7d_oi-*)
  raw: Record<string, string>; // all captured rate-limit headers, for debugging
}

// Build a QuotaRecord from the response headers. Returns null when the response
// carries no unified rate-limit signal (e.g. a non-/v1/messages call) so we
// never clobber a good record with an empty one.
export function buildQuotaRecord(
  headers: http.IncomingHttpHeaders,
  nowMs: number
): QuotaRecord | null {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (isRateLimitHeader(k)) {
      const s = str(v);
      if (s != null) raw[k.toLowerCase()] = s;
    }
  }

  const has5h =
    "anthropic-ratelimit-unified-5h-utilization" in raw ||
    "anthropic-ratelimit-unified-5h-status" in raw;
  const has7d =
    "anthropic-ratelimit-unified-7d-utilization" in raw ||
    "anthropic-ratelimit-unified-7d-status" in raw;
  const hasFable =
    "anthropic-ratelimit-unified-7d_oi-utilization" in raw ||
    "anthropic-ratelimit-unified-7d_oi-status" in raw;
  if (!has5h && !has7d && !hasFable) return null;

  return {
    capturedAt: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    overallStatus: raw["anthropic-ratelimit-unified-status"] ?? null,
    binding: raw["anthropic-ratelimit-unified-representative-claim"] ?? null,
    session: has5h
      ? {
          utilization: num(raw["anthropic-ratelimit-unified-5h-utilization"]),
          resetEpoch: num(raw["anthropic-ratelimit-unified-5h-reset"]),
          status: raw["anthropic-ratelimit-unified-5h-status"] ?? null,
        }
      : null,
    weekly: has7d
      ? {
          utilization: num(raw["anthropic-ratelimit-unified-7d-utilization"]),
          resetEpoch: num(raw["anthropic-ratelimit-unified-7d-reset"]),
          status: raw["anthropic-ratelimit-unified-7d-status"] ?? null,
        }
      : null,
    fable: hasFable
      ? {
          utilization: num(raw["anthropic-ratelimit-unified-7d_oi-utilization"]),
          resetEpoch: num(raw["anthropic-ratelimit-unified-7d_oi-reset"]),
          status: raw["anthropic-ratelimit-unified-7d_oi-status"] ?? null,
          capturedAtMs: nowMs,
        }
      : null,
    raw,
  };
}

// The Fable pool only rides on Fable responses, so a following Haiku/Opus call
// would otherwise blow it away. Carry the last-known Fable reading (with its
// own timestamp intact) forward onto the fresh record when the new response
// didn't include one.
export function mergeFableForward(prev: QuotaRecord | null, next: QuotaRecord): QuotaRecord {
  if (!next.fable && prev?.fable) return { ...next, fable: prev.fable };
  return next;
}

function readQuota(): QuotaRecord | null {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeQuotaAtomic(rec: QuotaRecord): void {
  try {
    if (!fs.existsSync(NEXUS_DIR)) fs.mkdirSync(NEXUS_DIR, { recursive: true });
    const merged = mergeFableForward(readQuota(), rec);
    const tmp = QUOTA_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, QUOTA_PATH);
  } catch {
    /* fail-open: a stale widget must never disturb real traffic */
  }
}

export interface ProxyHandle {
  server: http.Server;
  port: number;
  close: () => void;
}

export function startUsageProxy(opts?: {
  port?: number;
  onCapture?: (rec: QuotaRecord) => void;
  log?: (msg: string) => void;
}): Promise<ProxyHandle> {
  const port = opts?.port ?? DEFAULT_PROXY_PORT;
  const log = opts?.log ?? (() => {});

  const server = http.createServer((req, res) => {
    // Forward request headers verbatim (auth included) — never inspected/logged.
    const fwdHeaders = { ...req.headers, host: UPSTREAM_HOST };
    const upstreamReq = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: fwdHeaders,
      },
      (upRes) => {
        const rec = buildQuotaRecord(upRes.headers, Date.now());
        if (rec) {
          writeQuotaAtomic(rec);
          opts?.onCapture?.(rec);
          const bindLabel = rec.binding ? ` (binding: ${rec.binding})` : "";
          log(`captured quota on ${req.url} → status ${upRes.statusCode}${bindLabel}`);
        }
        // Transparent passthrough of status + all response headers + body.
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );

    upstreamReq.on("error", (e) => {
      log(`upstream error on ${req.url}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("claudelink usage-proxy: upstream error");
    });

    // Don't leak sockets if the client (Claude Code) hangs up mid-request.
    const abort = () => upstreamReq.destroy();
    req.on("aborted", abort);
    req.on("error", abort);

    req.pipe(upstreamReq);
  });

  // A listen error (e.g. port in use) should reject, not crash the process.
  return new Promise<ProxyHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      log(`listening on 127.0.0.1:${port} → https://${UPSTREAM_HOST}`);
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });
  });
}

// Runnable entry: `node dist/usage-proxy.js [port]`. Used by the detached spawn
// from `claudelink usage --on`. Writes a lockfile so --off/--status can find it.
if (require.main === module) {
  const port = Number(process.argv[2]) || DEFAULT_PROXY_PORT;
  const stamp = () => new Date().toISOString();
  const log = (msg: string) => process.stderr.write(`[${stamp()}] usage-proxy: ${msg}\n`);

  startUsageProxy({ port, log }).then(
    () => {
      try {
        if (!fs.existsSync(NEXUS_DIR)) fs.mkdirSync(NEXUS_DIR, { recursive: true });
        fs.writeFileSync(
          PROXY_LOCK_PATH,
          JSON.stringify({ pid: process.pid, port, startedAt: stamp() }, null, 2) + "\n"
        );
      } catch {
        /* non-fatal */
      }
      const cleanup = () => {
        try {
          fs.unlinkSync(PROXY_LOCK_PATH);
        } catch {}
        process.exit(0);
      };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
    },
    (e: any) => {
      log(`failed to start: ${e?.message ?? String(e)}`);
      process.exit(1);
    }
  );
}
