/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (server/session-history.ts ompSessionFolders/piSessionFolder, server/omp.ts): where omp keeps a
 * working folder's transcripts, and the terminal breadcrumb that names the one a process writes.
 * See THIRD_PARTY_NOTICES.md.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * omp's agent directory as Gajae starts it. Profiles (`OMP_PROFILE`, `PI_PROFILE`) and
 * `PI_CODING_AGENT_DIR` never reach a terminal Gajae starts (the core's env allow-list), and Gajae
 * passes no `--profile` or `--session-dir`, so its omp keeps the default store.
 */
export function ompAgentDirectory(home: string): string {
  return path.join(home, ".omp", "agent");
}

const canonical = (folder: string): string => {
  try {
    return realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
};

/**
 * omp's folder names for a cwd (@oh-my-pi/pi-coding-agent 17.4.1 src/session/session-paths.ts): a
 * folder below home is `-<relative>`, below the temp dir `-tmp-<relative>`, anywhere else pi's
 * legacy name (`--<path>--`), which older sessions keep. omp compares canonical paths.
 */
export function ompSessionFolders(cwd: string, home: string, tmp = os.tmpdir()): string[] {
  const under = (prefix: string, base: string, target: string): string | null => {
    const rel = path.posix.relative(base, target);
    if (rel !== "" && (rel.startsWith("..") || path.posix.isAbsolute(rel))) return null;
    const encoded = rel.replace(/[/\\:]/gu, "-");
    return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
  };
  const targets = [...new Set([path.resolve(cwd), canonical(cwd)])];
  const homes = [...new Set([path.resolve(home), canonical(home)])];
  const temps = [...new Set([path.resolve(tmp), canonical(tmp)])];
  const keys = targets.flatMap((target) => [
    ...homes.map((base) => under("-", base, target)),
    ...temps.map((base) => under("-tmp", base, target)),
    `--${target.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`,
  ]);
  return [...new Set(keys.filter((key): key is string => key !== null))];
}

/** An omp transcript's `session` header (it may follow a `title` line). */
export async function ompSessionHeader(file: string): Promise<{ id: string; cwd?: string; timestamp?: string } | undefined> {
  let text: string;
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  for (const line of text.split("\n").slice(0, 8)) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown };
      if (entry.type !== "session" || typeof entry.id !== "string") continue;
      return {
        id: entry.id,
        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      };
    } catch {
      // a torn or non-JSON line
    }
  }
  return undefined;
}

/** The terminal a process runs on (`ttys012`), from ps. */
export function ttyOfProcess(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      resolve(undefined);
      return;
    }
    execFile("/bin/ps", ["-o", "tty=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      const tty = error ? "" : String(stdout).trim();
      resolve(/^tty[\w.]{1,32}$/u.test(tty) ? tty : undefined);
    });
  });
}

/**
 * The transcript an omp process writes, as its terminal breadcrumb names it
 * (`<agent>/terminal-sessions/<tty>`: its cwd, the session file, then the cwd's stat). The file
 * belongs to whichever omp last ran on that terminal, so only one written since `since` (the
 * terminal's start) and naming `cwd` counts; omp rewrites it when it moves to another session.
 */
export async function ompBreadcrumb(
  pid: number,
  options: { home: string; cwd: string; since: number; tty?: (pid: number) => Promise<string | undefined> },
): Promise<string | undefined> {
  const tty = await (options.tty ?? ttyOfProcess)(pid);
  if (!tty) return undefined;
  const agent = ompAgentDirectory(options.home);
  const file = path.join(agent, "terminal-sessions", tty);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024 || info.mtimeMs < options.since - 1000) return undefined;
    const [cwd = "", transcript = ""] = (await readFile(file, "utf8")).split("\n");
    if (canonical(cwd.trim()) !== canonical(options.cwd)) return undefined;
    const session = transcript.trim();
    const store = path.join(agent, "sessions") + path.sep;
    return path.isAbsolute(session) && session.endsWith(".jsonl") && path.resolve(session).startsWith(store) ? path.resolve(session) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest omp transcript of `cwd` begun since `since` whose header names that cwd, leaving
 * out the ones other sessions already follow: the fallback when no breadcrumb names one.
 */
export async function newestOmpSession(
  cwd: string,
  options: { home: string; since: number; exclude?: ReadonlySet<string>; tmp?: string },
): Promise<{ path: string; id: string } | undefined> {
  const sessions = path.join(ompAgentDirectory(options.home), "sessions");
  const target = canonical(cwd);
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const folder of ompSessionFolders(cwd, options.home, options.tmp)) {
    const directory = path.join(sessions, folder);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name);
      if (options.exclude?.has(file)) continue;
      try {
        const info = await stat(file);
        const started = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
        if (info.isFile() && started >= options.since - 2000) candidates.push({ file, mtimeMs: info.mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const { file } of candidates) {
    const header = await ompSessionHeader(file);
    if (header && (!header.cwd || canonical(header.cwd) === target)) return { path: file, id: header.id };
  }
  return undefined;
}
