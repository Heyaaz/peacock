import path from "node:path";
import type { AgentSession, GitStatusSnapshot } from "../shared/agent-contract.js";
import { execFile, gitBranchFromHeader, safeGitPath } from "./gjc-sdk-foundation.js";

/** The controller state a Git panel call reads to find a session's repository. */
export interface GitScope {
  readonly workspace: string;
  readonly sessions: ReadonlyMap<string, AgentSession>;
  readonly sessionCwds: ReadonlyMap<string, string>;
}

export async function getGitStatus(
  scope: GitScope,
  sessionId: string,
): Promise<GitStatusSnapshot> {
  const workspace = scope.sessionCwds.get(sessionId) ?? scope.workspace;
  // A session can live in a directory that is not a repository at all. `git status`
  // exits non-zero there, and that rejection reached the IPC handler as an
  // unhandled error every time the panel polled. No repository is a state, not a
  // failure, so it is reported as one.
  let result: { stdout: string };
  try {
    result = await execFile(
      "git",
      ["-C", workspace, "status", "--porcelain=v1", "-z", "--branch"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    return { workspace, branch: "", ahead: 0, behind: 0, files: [] };
  }
  let branch = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusSnapshot["files"] = [];
  const entries = result.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.startsWith("## ")) {
      const header = entry.slice(3);
      const match =
        /^(.*?)\.\.\.([^ ]+)(?: \[ahead (\d+)(?:, behind (\d+))?\]| \[behind (\d+)\])?$/u.exec(
          header,
        );
      if (match) {
        branch = match[1] ?? "";
        upstream = match[2];
        ahead = Number(match[3] ?? 0);
        behind = Number(match[4] ?? match[5] ?? 0);
      } else branch = gitBranchFromHeader(header);
      continue;
    }
    if (entry.length < 4) continue;
    const indexStatus = entry[0] ?? ".";
    const workingTree = entry[1] ?? ".";
    const filePath = entry.slice(3);
    if (safeGitPath(filePath))
      files.push({ path: filePath, index: indexStatus, workingTree });
    if (indexStatus === "R" || indexStatus === "C") index += 1;
  }
  return {
    workspace,
    branch,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    files,
  };
}

/**
 * The folder of the worktree this app made for a session, when the session is
 * working in it. Anything that changes a repository for a session (commits,
 * pushes, pull requests) works only there, so this one rule decides it.
 */
export function managedWorktreePath(
  session: Pick<AgentSession, "workspace" | "worktree"> | undefined,
): string | undefined {
  const worktree = session?.worktree;
  if (
    !session ||
    !worktree?.managed ||
    path.resolve(session.workspace) !== path.resolve(worktree.path)
  )
    return undefined;
  return worktree.path;
}

/** The worktree a session works in, when this app made it for the session; no path ever comes from the window. */
export function sessionWorktreePath(scope: GitScope, sessionId: string): string | undefined {
  return managedWorktreePath(scope.sessions.get(sessionId));
}

async function managedRoot(scope: GitScope, sessionId: string): Promise<string> {
  const worktreePath = managedWorktreePath(scope.sessions.get(sessionId));
  if (!worktreePath)
    throw new Error("Git mutation requires a managed Peacock worktree");
  const root = (
    await execFile("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if (path.resolve(root) !== path.resolve(worktreePath))
    throw new Error("Managed worktree path verification failed");
  return worktreePath;
}

async function mutateGit(
  scope: GitScope,
  sessionId: string,
  args: string[],
): Promise<GitStatusSnapshot> {
  const root = await managedRoot(scope, sessionId);
  await execFile("git", ["-C", root, ...args]);
  return getGitStatus(scope, sessionId);
}
export async function stageFiles(
  scope: GitScope,
  sessionId: string,
  paths: string[],
): Promise<GitStatusSnapshot> {
  const status = await getGitStatus(scope, sessionId);
  const allowed = new Set(status.files.map((file) => file.path));
  if (
    paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
  )
    throw new Error(
      "Path is not an eligible repository-relative changed file",
    );
  return mutateGit(scope, sessionId, ["add", "--", ...paths]);
}
export async function unstageFiles(
  scope: GitScope,
  sessionId: string,
  paths: string[],
): Promise<GitStatusSnapshot> {
  const status = await getGitStatus(scope, sessionId);
  const allowed = new Set(status.files.map((file) => file.path));
  if (
    paths.some((filePath) => !allowed.has(filePath) || !safeGitPath(filePath))
  )
    throw new Error(
      "Path is not an eligible repository-relative changed file",
    );
  return mutateGit(scope, sessionId, ["restore", "--staged", "--", ...paths]);
}
export async function commitChanges(
  scope: GitScope,
  sessionId: string,
  message: string,
): Promise<GitStatusSnapshot> {
  const text = message.trim();
  if (!text || text.length > 512)
    throw new Error("Commit message is required and bounded");
  return mutateGit(scope, sessionId, ["commit", "-m", text]);
}
/** A push that has not finished in this long is stuck on the network, not working. */
const PUSH_TIMEOUT_MS = 120_000;
/** Branches that are taken for the default one when the clone does not record which it is. */
const CONVENTIONAL_DEFAULT_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Whether a plain `git push` would update the branch's own upstream.
 *
 * A worktree branch made from `origin/main` tracks `origin/main`, and pushing it
 * under `push.default=simple` fails; such a branch needs its own first push.
 */
export function pushesToUpstream(branch: string, upstream: string | undefined): boolean {
  if (!branch || !upstream) return false;
  return upstream.slice(upstream.indexOf("/") + 1) === branch;
}

/** Where a push of this branch goes, for the question the person is asked first. */
export function pushDestination(git: { branch: string; upstream?: string }): {
  destination: string;
  firstPush: boolean;
} {
  if (git.upstream && pushesToUpstream(git.branch, git.upstream))
    return { destination: git.upstream, firstPush: false };
  return { destination: `origin/${git.branch}`, firstPush: true };
}

export interface PushPlan {
  branch: string;
  firstPush: boolean;
  /** The arguments of `git push`, after the command's own name. */
  args: string[];
}

/** The branch the clone knows `origin` to treat as its default, if it records one. */
async function recordedDefaultBranch(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", [
      "-C",
      root,
      "symbolic-ref",
      "--short",
      "-q",
      "refs/remotes/origin/HEAD",
    ]);
    const ref = stdout.trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a push of the worktree's branch would do, or why it must not happen.
 *
 * The repository's default branch is never pushed from here: it is where finished
 * work lands through a pull request, not where a session's work goes. A branch
 * with its own upstream is pushed as it is; any other gets its first push, which
 * names the remote and sets the upstream so the next push is a plain one.
 */
export async function planPush(root: string): Promise<PushPlan> {
  const branch = (
    await execFile("git", ["-C", root, "branch", "--show-current"])
  ).stdout.trim();
  if (!branch) throw new Error("Cannot push a detached HEAD; check out a branch first");
  const defaultBranch = await recordedDefaultBranch(root);
  if (
    defaultBranch !== undefined
      ? branch === defaultBranch
      : CONVENTIONAL_DEFAULT_BRANCHES.includes(branch)
  )
    throw new Error(
      `Refusing to push the default branch (${branch}); push a work branch and open a pull request`,
    );
  let upstream: string | undefined;
  try {
    upstream =
      (
        await execFile("git", [
          "-C",
          root,
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{u}",
        ])
      ).stdout.trim() || undefined;
  } catch {
    upstream = undefined;
  }
  return pushesToUpstream(branch, upstream)
    ? { branch, firstPush: false, args: ["push"] }
    : { branch, firstPush: true, args: ["push", "-u", "origin", "HEAD"] };
}

export async function pushChanges(
  scope: GitScope,
  sessionId: string,
): Promise<GitStatusSnapshot> {
  const root = await managedRoot(scope, sessionId);
  const plan = await planPush(root);
  await execFile("git", ["-C", root, ...plan.args], {
    timeout: PUSH_TIMEOUT_MS,
    // There is no terminal to answer a credential prompt; fail instead of waiting for one.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return getGitStatus(scope, sessionId);
}
