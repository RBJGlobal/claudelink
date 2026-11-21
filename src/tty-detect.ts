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
