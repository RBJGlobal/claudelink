// Finds the terminal a claudelink-server belongs to by walking up its
// ancestors. Claude Code is the direct parent and owns the tty. Codex CLI
// (0.17x) starts MCP servers from an app-server helper that has no tty; the
// `codex` process that owns the terminal is one level further up.

import { execFileSync } from "child_process";

export interface ProcInfo {
  ppid: number;
  tty: string | null; // "/dev/ttysNNN" or null when the process has none
}

export type ProcLookup = (pid: number) => ProcInfo | null;

export const MAX_TTY_HOPS = 4;

// Pure. Starts at `startPid` (the server's parent) and returns the first tty
// found within MAX_TTY_HOPS ancestors, or null.
export function findTty(startPid: number, lookup: ProcLookup, maxHops = MAX_TTY_HOPS): string | null {
  let pid = startPid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const info = lookup(pid);
    if (!info) return null;
    if (info.tty) return info.tty;
    pid = info.ppid;
  }
  return null;
}

export function psLookup(pid: number): ProcInfo | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,tty="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = out.match(/^(\d+)\s+(\S+)$/);
    if (!m) return null;
    const t = m[2];
    const tty = !t || t === "??" || t === "?" ? null : t.startsWith("/dev/") ? t : `/dev/${t}`;
    return { ppid: Number(m[1]), tty };
  } catch {
    return null;
  }
}

// ── Codex CLI fallback ──────────────────────────────────────────────────────
// Codex keeps its app-server helper alive after the session quits; a resumed
// session reuses it, and by then the helper's parent is launchd, so the walk
// above finds no tty. The server and the `codex` session do share a working
// directory, so the pane is found by that instead.

export interface CliSession {
  tty: string;
  cwd: string | null;
}

// Pure. True when the server was started by the Codex CLI helper. The desktop
// app ships its own copy inside an .app bundle; it has no pane and is left out.
export function isCodexCliHelper(parentCommand: string | null): boolean {
  if (!parentCommand) return false;
  return /(^|\/)codex\s+.*\bapp-server\b/.test(parentCommand) && !/\.app\//.test(parentCommand);
}

// Pure. The tty of the one Codex session running in `serverCwd`. Zero or
// several matches give null: a nudge typed into the wrong pane is worse than
// no nudge.
export function pickSessionTty(serverCwd: string, sessions: CliSession[]): string | null {
  const ttys = new Set(sessions.filter((s) => s.cwd === serverCwd).map((s) => s.tty));
  return ttys.size === 1 ? [...ttys][0] : null;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function cwdOf(pid: number): string | null {
  const m = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).match(/^n(.+)$/m);
  return m ? m[1] : null;
}

function codexSessions(): CliSession[] {
  const out: CliSession[] = [];
  for (const line of run("ps", ["-eo", "pid=,tty=,command="]).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || m[2] === "??" || m[2] === "?") continue;
    if (!/^(\S*\/)?codex(\s|$)/.test(m[3]) || /\bapp-server\b/.test(m[3])) continue;
    out.push({ tty: m[2].startsWith("/dev/") ? m[2] : `/dev/${m[2]}`, cwd: cwdOf(Number(m[1])) });
  }
  return out;
}

// The terminal of the session that started this server, or null.
export function detectSessionTty(ppid: number, cwd: string): string | null {
  const direct = findTty(ppid, psLookup);
  if (direct) return direct;
  if (!isCodexCliHelper(run("ps", ["-p", String(ppid), "-o", "command="]).trim() || null)) return null;
  return pickSessionTty(cwd, codexSessions());
}
