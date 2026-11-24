import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Where Claude Code keeps a project's transcripts: the working folder's real path with every
 * character that is not a letter or digit turned into `-` (P0.5 spike: `/private/tmp/x` →
 * `-private-tmp-x`, the real path, not `/tmp/x`).
 */
export function claudeProjectDirectory(cwd: string, home: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // a folder that is gone keeps its name
  }
  return path.join(home, ".claude", "projects", real.replace(/[^A-Za-z0-9]/gu, "-"));
}

export function claudeTranscriptPath(cwd: string, sessionId: string, home: string): string {
  return path.join(claudeProjectDirectory(cwd, home), `${sessionId}.jsonl`);
}

/**
 * The session a running Claude Code is in, from the file it keeps per process
 * (`~/.claude/sessions/<pid>.json`, updated on `/clear` and `/resume`): the fallback for hooks
 * that went unheard while Gajae was closed.
 */
export async function claudeSessionOfPid(
  pid: number,
  home: string,
): Promise<{ sessionId: string; cwd?: string } | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const value = JSON.parse(await readFile(path.join(home, ".claude", "sessions", `${pid}.json`), "utf8")) as {
      pid?: unknown;
      sessionId?: unknown;
      cwd?: unknown;
    };
    if (value.pid !== pid || typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.sessionId))
      return undefined;
    return { sessionId: value.sessionId, ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}) };
  } catch {
    return undefined;
  }
}
