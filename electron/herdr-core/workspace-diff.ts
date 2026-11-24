import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffSnapshot } from "../../shared/agent-contract.js";
import { changedFilesFromDiff } from "../gjc-sdk-files.js";

const execFile = promisify(execFileCallback);
const DIFF_MAX_BYTES = 4 * 1024 * 1024;
/** Untracked files shown as added; a build folder nobody ignored should not flood the view. */
const UNTRACKED_LIMIT = 200;

/**
 * A terminal agent session's changes (P6: a parallel run compares its attempts' worktrees): what
 * `git diff HEAD` shows in the session's folder, and each untracked file as added. GJC answers
 * this itself (`diff.list_files`); a terminal agent has no such query, so Gajae reads the folder,
 * and never writes to it (no `git add -N`).
 */
export async function workspaceDiff(sessionId: string, workspace: string): Promise<DiffSnapshot> {
  const snapshot = (files: DiffSnapshot["files"], error?: string): DiffSnapshot => ({
    sessionId,
    workspace,
    files,
    refreshedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
  const inside = await execFile("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"]).then(
    (result) => result.stdout.trim() === "true",
    () => false,
  );
  if (!inside) return snapshot([], "이 작업 폴더는 Git 저장소가 아니어서 변경 내용을 볼 수 없습니다.");
  try {
    const tracked = await execFile("git", ["-C", workspace, "diff", "--no-ext-diff", "HEAD"], { maxBuffer: DIFF_MAX_BYTES });
    const files = changedFilesFromDiff(tracked.stdout);
    const untracked = (
      await execFile("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: DIFF_MAX_BYTES })
    ).stdout
      .split("\0")
      .filter(Boolean)
      .slice(0, UNTRACKED_LIMIT);
    for (const file of untracked) {
      // --no-index exits 1 when the files differ, which for a new file is always
      const added = await execFile(
        "git",
        ["-C", workspace, "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file],
        { maxBuffer: DIFF_MAX_BYTES },
      ).then(
        (result) => result.stdout,
        (error: { stdout?: string }) => error.stdout ?? "",
      );
      const parsed = changedFilesFromDiff(added).map((entry) => ({ ...entry, id: file, path: file.split(path.sep).join("/") }));
      files.push(...parsed);
    }
    return snapshot(files);
  } catch (error) {
    return snapshot([], error instanceof Error ? error.message : String(error));
  }
}
