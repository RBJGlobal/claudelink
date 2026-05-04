import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execFileSync } from "child_process";

const NEXUS_DIR = path.join(os.homedir(), ".claudelink");
const LOCK_PATH = path.join(NEXUS_DIR, "ui.lock");
const DEFAULT_PORT = 7878;

interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function pingHeartbeat(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/heartbeat", timeout: timeoutMs },
      (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function openInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // browser failure is non-fatal — UI still reachable at the URL
  }
}

/**
 * Spawn the UI server as a detached process if one isn't already running,
 * and open the browser. Safe to call repeatedly.
 *
 * Returns the URL of the running UI, or null if it couldn't be started.
 */
export async function launchUIIfNeeded(opts: { openBrowser?: boolean } = {}): Promise<string | null> {
  if (process.env.CLAUDELINK_UI === "off") return null;

  if (!fs.existsSync(NEXUS_DIR)) {
    try { fs.mkdirSync(NEXUS_DIR, { recursive: true }); } catch {}
  }

  const existing = readLock();
  if (existing && isProcessAlive(existing.pid)) {
    const alive = await pingHeartbeat(existing.port);
    if (alive) {
      return `http://127.0.0.1:${existing.port}`;
    }
  }
  // Lock is stale or the previous UI died. Remove it so we can start fresh.
  try { fs.unlinkSync(LOCK_PATH); } catch {}

  const uiBin = path.join(__dirname, "ui-bin.js");
  if (!fs.existsSync(uiBin)) return null;

  const child = spawn(process.execPath, [uiBin, String(DEFAULT_PORT)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait briefly for the child to bind + write the lock.
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 80));
    const lock = readLock();
    if (lock && isProcessAlive(lock.pid)) {
      const ok = await pingHeartbeat(lock.port);
      if (ok) {
        const url = `http://127.0.0.1:${lock.port}`;
        if (opts.openBrowser !== false) openInBrowser(url);
        return url;
      }
    }
  }
  return null;
}

export function stopUI(): boolean {
  const lock = readLock();
  if (!lock) return false;
  if (!isProcessAlive(lock.pid)) {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    return false;
  }
  try {
    process.kill(lock.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function getUIStatus(): { running: boolean; pid?: number; port?: number; url?: string } {
  const lock = readLock();
  if (!lock) return { running: false };
  if (!isProcessAlive(lock.pid)) return { running: false };
  return {
    running: true,
    pid: lock.pid,
    port: lock.port,
    url: `http://127.0.0.1:${lock.port}`,
  };
}
