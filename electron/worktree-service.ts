import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ManagedWorktree, WorktreePull, WorktreeSetupReport } from "../shared/agent-contract.js";
import { normalizeCopyPath, type ProjectSettings } from "../shared/project-settings.js";
import { parseWorktreeList } from "./repo-service.js";
import { runtimeEnvironment } from "./runtime-path.js";

/**
 * The Git work behind a session's own worktree, in one place: making one (the branch
 * and remote cases), filling it from the project's settings (copied files, the setup
 * script) and reading and removing what is left of one.
 *
 * Nothing here knows about sessions. The GJC controller and a parallel run call it with
 * the folder and the branch they mean, so what they delete is exactly what they made.
 */

const execFile = promisify(execFileCallback);

/** Runs git in `cwd` and returns its stdout; a failing git rejects. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export const runGit: GitRunner = async (cwd, args) =>
  (await execFile("git", ["-C", cwd, ...args])).stdout;

// ---- reading the repository

/** Branch to worktree path, from `git worktree list --porcelain`. */
export function worktreesByBranch(porcelain: string): Map<string, string> {
  const byBranch = new Map<string, string>();
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path)
      byBranch.set(line.slice("branch refs/heads/".length), path);
    else if (!line) path = undefined;
  }
  return byBranch;
}

export async function listWorktreePaths(git: GitRunner, root: string): Promise<Map<string, string>> {
  return worktreesByBranch(await git(root, ["worktree", "list", "--porcelain"]));
}

/** The top of the working tree a folder is in. Rejects, with git's own message, outside one. */
export async function repositoryRoot(git: GitRunner, workspace: string): Promise<string> {
  return (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
}

export function localBranchExists(git: GitRunner, root: string, branch: string): Promise<boolean> {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/** How many remotes have a branch of this name. */
export async function remotesWithBranch(git: GitRunner, root: string, branch: string): Promise<number> {
  const [remotes, refs] = await Promise.all([
    git(root, ["remote"]),
    git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]),
  ]);
  const present = new Set(refs.split("\n").map((line) => line.trim()));
  return remotes
    .split("\n")
    .map((line) => line.trim())
    .filter((remote) => remote && present.has(`refs/remotes/${remote}/${branch}`)).length;
}

/** Modified and untracked paths a worktree holds. */
export async function uncommittedFiles(git: GitRunner, worktreePath: string): Promise<number> {
  const status = await git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  return status.split("\n").filter(Boolean).length;
}

/** Commits reachable only from this branch: on no remote and no other local branch. */
export async function unpushedCommits(git: GitRunner, root: string, branch: string): Promise<number> {
  const count = await git(root, [
    "rev-list",
    "--count",
    `refs/heads/${branch}`,
    "--not",
    `--exclude=${branch}`,
    "--branches",
    "--remotes",
  ]);
  return Number.parseInt(count.trim(), 10) || 0;
}

// ---- making a worktree

/** Where this app puts the worktrees of the repository whose working tree is `sourceWorkspace`. */
export function worktreeHome(sourceWorkspace: string): string {
  return path.join(path.dirname(sourceWorkspace), `${path.basename(sourceWorkspace)}.gajae-worktrees`);
}

/** `git worktree add`: a new branch from HEAD, or the existing branch checked out. */
export async function addWorktree(
  git: GitRunner,
  root: string,
  worktreePath: string,
  branch: string,
  options: { existingBranch: boolean },
): Promise<void> {
  await git(root, [
    "worktree",
    "add",
    ...(options.existingBranch ? [worktreePath, branch] : ["-b", branch, worktreePath]),
  ]);
}

export interface WorktreeRequest {
  /** A folder inside the repository the worktree is made from. */
  workspace: string;
  /** The branch to check out; a new `<branchPrefix>/<suffix>` branch when unset. */
  branch?: string;
  /** The folder of the default branch name; `gajae` when unset. */
  branchPrefix?: string;
  /** The branch must already exist, locally or on exactly one remote, rather than start from HEAD. */
  branchExisting?: boolean;
  /** A pull request from a fork: a missing branch is fetched from its head instead of created. */
  pull?: WorktreePull;
  /** Names the default branch and the folder. Asked for once the folder is known to be a repository. */
  suffix: () => string;
}

export interface CreatedWorktree {
  worktree: ManagedWorktree;
  /** The branch was already there, so it is checked out and must never be deleted as this worktree's own. */
  branchExisted: boolean;
}

/**
 * Makes a worktree next to the repository (`<repo>.gajae-worktrees/<suffix>`).
 *
 * An existing branch is checked out rather than recreated: `-b` refuses it, and a
 * failure cleanup must never delete a branch it did not make. A named branch someone
 * pushed from another machine is on a remote only; starting it with `-b` would make a
 * second, unrelated branch of that name, so it is checked out, which makes git track the
 * one remote that has it.
 */
export async function createWorktree(
  request: WorktreeRequest,
  git: GitRunner = runGit,
): Promise<CreatedWorktree> {
  const root = await repositoryRoot(git, request.workspace);
  if (!root) throw new Error("Workspace is not a git repository");
  const suffix = request.suffix();
  const branch = request.branch?.trim() || `${request.branchPrefix ?? "gajae"}/${suffix}`;
  const worktreePath = path.join(worktreeHome(root), suffix);
  const branchExisted = await localBranchExists(git, root, branch);
  const onOneRemote =
    !branchExisted &&
    request.branch !== undefined &&
    !request.pull &&
    (await remotesWithBranch(git, root, branch)) === 1;
  if (!branchExisted && request.pull) {
    const { remote, number } = request.pull;
    await git(root, ["fetch", "--no-tags", remote, `pull/${number}/head:refs/heads/${branch}`]).catch(
      (error: unknown) => {
        throw new Error(`PR #${number}의 head를 ${remote}에서 받아 오지 못했습니다.`, { cause: error });
      },
    );
  }
  try {
    await addWorktree(git, root, worktreePath, branch, {
      existingBranch: branchExisted || onOneRemote || request.branchExisting === true || request.pull !== undefined,
    });
  } catch (error) {
    // Without a local branch, git checks out the one remote branch of that
    // name. A branch that exists nowhere must not become a new one from HEAD.
    if (request.branchExisting && !branchExisted)
      throw new Error(
        `브랜치 ${branch}을(를) 로컬이나 원격에서 찾지 못했습니다. git fetch로 받아 온 뒤 다시 시도하세요.`,
        { cause: error },
      );
    throw error;
  }
  return {
    worktree: { sourceWorkspace: root, path: worktreePath, branch, managed: true, createdBranch: !branchExisted },
    branchExisted,
  };
}

/**
 * Takes back a worktree whose session never started, when that cannot lose anything:
 * a worktree with edits is kept for manual recovery, and so is a branch that was there
 * before. Never throws.
 */
export async function discardUnusedWorktree(
  git: GitRunner,
  worktree: Pick<ManagedWorktree, "sourceWorkspace" | "path" | "branch">,
  branchExisted: boolean,
): Promise<void> {
  try {
    const status = (await git(worktree.path, ["status", "--porcelain"])).trim();
    if (status) return;
    await git(worktree.sourceWorkspace, ["worktree", "remove", worktree.path]);
    if (!branchExisted) await git(worktree.sourceWorkspace, ["branch", "-D", worktree.branch]);
  } catch {
    /* Preserve a dirty or otherwise uncertain worktree for manual recovery. */
  }
}

/**
 * Removes a worktree this code just made, whatever it holds, and its branch unless the branch
 * was there before (`keepBranch`). Never throws.
 */
export async function discardNewWorktree(
  git: GitRunner,
  root: string,
  worktreePath: string,
  branch: string,
  options: { keepBranch?: boolean } = {},
): Promise<void> {
  await git(root, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  if (!options.keepBranch) await git(root, ["branch", "-D", branch]).catch(() => undefined);
}

// ---- reading and removing what is left

/** What removing a worktree and its branch would take, read from Git rather than from any record. */
export interface WorktreeLeftovers {
  branch: string;
  /** The worktree that has the branch checked out, when one does. */
  worktreePath?: string;
  /** Git still lists the worktree but its folder is gone: only Git's record is pruned. */
  worktreeMissing?: boolean;
  /** Modified and untracked paths that removing the worktree would discard. */
  uncommittedFiles: number;
  branchExists: boolean;
  /** Commits on the branch that are on no remote and on no other local branch. */
  unpushedCommits: number;
}

/** `worktrees` is `listWorktreePaths`' answer, when the caller reads several branches at once. */
export async function inspectWorktree(
  git: GitRunner,
  root: string,
  branch: string,
  worktrees?: ReadonlyMap<string, string>,
): Promise<WorktreeLeftovers> {
  const worktreePath = (worktrees ?? (await listWorktreePaths(git, root))).get(branch);
  const worktreeMissing = worktreePath !== undefined && !existsSync(worktreePath);
  const branchExists = await localBranchExists(git, root, branch);
  return {
    branch,
    ...(worktreePath ? { worktreePath } : {}),
    ...(worktreeMissing ? { worktreeMissing: true } : {}),
    uncommittedFiles: worktreePath && !worktreeMissing ? await uncommittedFiles(git, worktreePath) : 0,
    branchExists,
    unpushedCommits: branchExists ? await unpushedCommits(git, root, branch) : 0,
  };
}

/** Removes exactly what `inspectWorktree` found: the caller has already had it confirmed. */
export async function removeWorktreeLeftovers(
  git: GitRunner,
  root: string,
  leftovers: WorktreeLeftovers,
): Promise<void> {
  if (leftovers.worktreePath && leftovers.worktreeMissing) await git(root, ["worktree", "prune"]);
  else if (leftovers.worktreePath)
    await git(root, [
      "worktree",
      "remove",
      ...(leftovers.uncommittedFiles > 0 ? ["--force"] : []),
      leftovers.worktreePath,
    ]);
  if (leftovers.branchExists) await git(root, ["branch", "-D", leftovers.branch]);
}

// ---- filling a new worktree from the project's settings

/** The largest file a new worktree is given a copy of. */
export const COPY_FILE_MAX_BYTES = 10 * 1024 * 1024;

export type CopySkipReason =
  | "invalid"
  | "missing"
  | "not-a-file"
  | "symlink"
  | "outside"
  | "too-large"
  | "tracked"
  | "exists"
  | "failed";

/** Reasons that only mean the file was not needed: nothing is wrong, so nothing is reported. */
const BENIGN_SKIPS: ReadonlySet<CopySkipReason> = new Set(["missing", "tracked", "exists"]);

export interface CopyReport {
  copied: string[];
  skipped: { path: string; reason: CopySkipReason }[];
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function nearestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function trackedAmong(git: GitRunner, cwd: string, files: readonly string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const listed = await git(cwd, ["--literal-pathspecs", "ls-files", "-z", "--", ...files]);
  return new Set(listed.split("\0").filter(Boolean));
}

/**
 * Copies files the repository does not carry (`.env`, local config) from the project's
 * main working tree into a new worktree.
 *
 * Only root-relative paths are accepted, and every real path involved must stay inside
 * its own tree: a symlink, or a folder that is one, never leads a read or a write
 * outside. A file Git tracks, one the worktree already has, and one the project does not
 * have are skipped rather than overwritten or treated as failures. Never throws; each
 * file's outcome is in the report.
 */
export async function copyProjectFiles(input: {
  sourceRoot: string;
  worktreePath: string;
  files: readonly string[];
  git?: GitRunner;
}): Promise<CopyReport> {
  const git = input.git ?? runGit;
  const report: CopyReport = { copied: [], skipped: [] };
  const wanted: string[] = [];
  for (const file of input.files) {
    const normalized = normalizeCopyPath(file);
    if (!normalized) report.skipped.push({ path: String(file), reason: "invalid" });
    else if (!wanted.includes(normalized)) wanted.push(normalized);
  }
  if (wanted.length === 0) return report;
  let sourceReal: string;
  let targetReal: string;
  let tracked: Set<string>;
  try {
    [sourceReal, targetReal] = await Promise.all([realpath(input.sourceRoot), realpath(input.worktreePath)]);
    const [inSource, inTarget] = await Promise.all([
      trackedAmong(git, input.sourceRoot, wanted),
      trackedAmong(git, input.worktreePath, wanted),
    ]);
    tracked = new Set([...inSource, ...inTarget]);
  } catch {
    // Without knowing what Git tracks, nothing is safe to copy over.
    for (const file of wanted) report.skipped.push({ path: file, reason: "failed" });
    return report;
  }
  const skip = (file: string, reason: CopySkipReason): void => {
    report.skipped.push({ path: file, reason });
  };
  for (const file of wanted) {
    const source = path.join(input.sourceRoot, file);
    const destination = path.join(input.worktreePath, file);
    try {
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (!info) skip(file, "missing");
      else if (info.isSymbolicLink()) skip(file, "symlink");
      else if (!info.isFile()) skip(file, "not-a-file");
      else if (info.size > COPY_FILE_MAX_BYTES) skip(file, "too-large");
      else if (!isInside(sourceReal, await realpath(source))) skip(file, "outside");
      else if (tracked.has(file)) skip(file, "tracked");
      else if (await lstat(destination).then(() => true, () => false)) skip(file, "exists");
      else {
        const folder = path.dirname(destination);
        const ancestor = await realpath(await nearestExisting(folder));
        if (ancestor !== targetReal && !isInside(targetReal, ancestor)) skip(file, "outside");
        else {
          await mkdir(folder, { recursive: true });
          const created = await realpath(folder);
          if (created !== targetReal && !isInside(targetReal, created)) skip(file, "outside");
          else {
            // COPYFILE_EXCL: a file that appeared since the check above is not overwritten
            await copyFile(source, destination, constants.COPYFILE_EXCL);
            report.copied.push(file);
          }
        }
      }
    } catch (error) {
      skip(file, (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed");
    }
  }
  return report;
}

// ---- the setup script

/** How long a setup script may run before it is stopped. */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** The most of a setup script's output that is kept: its end, where a failure says why. */
export const SETUP_OUTPUT_LIMIT = 32 * 1024;

export interface SetupResult {
  /** `error`: the script could not be started at all. */
  status: "ok" | "failed" | "timeout" | "error";
  exitCode?: number;
  /** The end of what the script printed (stdout and stderr together). */
  output: string;
  durationMs: number;
}

/**
 * Runs the project's setup script in a new worktree with `/bin/sh -c`.
 *
 * The script is what the user wrote in Settings and is never read from the repository.
 * It gets the paths it needs in the environment, runs in its own process group so a
 * timeout stops everything it started, and never blocks forever. Never rejects.
 */
export function runSetupScript(input: {
  script: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputLimit?: number;
}): Promise<SetupResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? SETUP_TIMEOUT_MS;
  const limit = input.outputLimit ?? SETUP_OUTPUT_LIMIT;
  return new Promise((resolve) => {
    let output = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<SetupResult, "output" | "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ ...result, output: output.toString("utf8"), durationMs: Date.now() - started });
    };
    let timer: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", input.script], {
        cwd: input.cwd,
        env: runtimeEnvironment(input.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      finish({ status: "error" });
      return;
    }
    const collect = (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk]);
      if (output.length > limit) output = output.subarray(output.length - limit);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const stopGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group is already gone
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      stopGroup("SIGTERM");
      killer = setTimeout(() => {
        stopGroup("SIGKILL");
        // a process that ignores both signals must not hold the session up either
        finish({ status: "timeout" });
      }, 2000);
    }, timeoutMs);
    child.on("error", () => finish({ status: "error" }));
    child.on("close", (code) => {
      if (timedOut) finish({ status: "timeout" });
      else if (code === 0) finish({ status: "ok", exitCode: 0 });
      else finish({ status: "failed", ...(code === null ? {} : { exitCode: code }) });
    });
  });
}

/** What the setup of one new worktree did, for the window to report. */
export interface WorktreePreparation {
  copy?: CopyReport;
  setup?: SetupResult;
  /** Unexpected outcomes only: a file that could not be copied, a script that did not finish cleanly. */
  problems: { copy: { path: string; reason: CopySkipReason }[]; setup?: SetupResult };
}

/**
 * A new worktree's follow-up from its project's settings: the files first, so the setup
 * script can use them, then the script. Neither makes the worktree unusable, so
 * nothing here throws; what did not go as asked is in `problems`.
 */
export async function prepareWorktree(input: {
  settings: Pick<ProjectSettings, "setupScript" | "copyFiles">;
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  git?: GitRunner;
  timeoutMs?: number;
}): Promise<WorktreePreparation> {
  const preparation: WorktreePreparation = { problems: { copy: [] } };
  if (input.settings.copyFiles.length > 0) {
    const copy = await copyProjectFiles({
      sourceRoot: input.sourceRoot,
      worktreePath: input.worktreePath,
      files: input.settings.copyFiles,
      ...(input.git ? { git: input.git } : {}),
    });
    preparation.copy = copy;
    preparation.problems.copy = copy.skipped.filter((entry) => !BENIGN_SKIPS.has(entry.reason));
  }
  if (input.settings.setupScript.trim()) {
    const setup = await runSetupScript({
      script: input.settings.setupScript,
      cwd: input.worktreePath,
      env: {
        PEACOCK_ROOT_PATH: input.sourceRoot,
        PEACOCK_WORKTREE_PATH: input.worktreePath,
        PEACOCK_WORKTREE_BRANCH: input.branch,
      },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    preparation.setup = setup;
    if (setup.status !== "ok") preparation.problems.setup = setup;
  }
  return preparation;
}

const REPORT_OUTPUT_LIMIT = 2000;

/** What a preparation has to tell the user, or undefined when it went as asked. */
export function worktreeSetupReport(preparation: WorktreePreparation): WorktreeSetupReport | undefined {
  const { copy, setup } = preparation.problems;
  if (copy.length === 0 && (!setup || setup.status === "ok")) return undefined;
  return {
    ...(copy.length > 0 ? { copyProblems: copy.map((entry) => ({ path: entry.path, reason: entry.reason })) } : {}),
    ...(setup && setup.status !== "ok"
      ? {
          setup: {
            status: setup.status,
            ...(setup.exitCode === undefined ? {} : { exitCode: setup.exitCode }),
            output: setup.output.slice(-REPORT_OUTPUT_LIMIT).trim(),
          },
        }
      : {}),
  };
}

// ---- taking back a session's worktree

/**
 * Whether a worktree record names a folder this app could have made: a single folder directly
 * under the repository's `.gajae-worktrees`, and not the repository's own working tree. A
 * record that says otherwise is not a worktree this app removes, whatever else it claims.
 */
export function isPeacockWorktree(worktree: Pick<ManagedWorktree, "sourceWorkspace" | "path">): boolean {
  const target = path.resolve(worktree.path);
  const source = path.resolve(worktree.sourceWorkspace);
  return target !== source && path.dirname(target) === worktreeHome(source) && path.basename(target) !== "";
}

/**
 * What removing one session's worktree would take, read from Git now. Every field is a loss
 * or an action the user is told about before anything is removed, and the same read is made
 * again right before the removal: it is only carried out when nothing in it has changed.
 */
export interface WorktreeRemovalPlan {
  worktreePath: string;
  sourceWorkspace: string;
  /** Git still lists the worktree but its folder is gone: only Git's record is pruned. */
  worktreeMissing?: boolean;
  /** Modified and untracked paths the removal discards. */
  uncommittedFiles: number;
  /** Commits only a detached HEAD in the worktree holds: on no branch and on no remote. */
  detachedCommits: number;
  /** The branch this app made for the worktree, to be deleted with it. */
  branch?: { name: string; unpushedCommits: number };
  /** The session's branch that stays: not made by this app, or checked out somewhere else. */
  keptBranch?: string;
}

async function commitsOnlyHere(git: GitRunner, worktreePath: string): Promise<number> {
  const count = await git(worktreePath, ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"]);
  return Number.parseInt(count.trim(), 10) || 0;
}

/**
 * The removal of a session's worktree, if there is one this app may remove: undefined for
 * a record that does not name a worktree of this app's making, for the repository's own
 * working tree, for a worktree Git does not list as a linked one, for a locked one and
 * for one Git cannot be read about. The branch is part of the plan only when this app made
 * it for the worktree (`createdBranch`) and nothing else has it checked out.
 */
export async function planWorktreeRemoval(
  git: GitRunner,
  worktree: ManagedWorktree,
): Promise<WorktreeRemovalPlan | undefined> {
  if (!isPeacockWorktree(worktree)) return undefined;
  try {
    const listed = parseWorktreeList(await git(worktree.sourceWorkspace, ["worktree", "list", "--porcelain"]));
    const target = path.resolve(worktree.path);
    const entry = listed.find((candidate) => path.resolve(candidate.path) === target);
    if (!entry || entry.main || entry.locked) return undefined;
    const missing = entry.prunable || !existsSync(entry.path);
    const uncommitted = missing ? 0 : await uncommittedFiles(git, entry.path);
    const detached = !missing && !entry.branch ? await commitsOnlyHere(git, entry.path) : 0;
    const exists = await localBranchExists(git, worktree.sourceWorkspace, worktree.branch);
    const checkedOutElsewhere = listed.some((candidate) => candidate !== entry && candidate.branch === worktree.branch);
    const owned = exists && worktree.createdBranch === true && !checkedOutElsewhere;
    return {
      worktreePath: entry.path,
      sourceWorkspace: worktree.sourceWorkspace,
      ...(missing ? { worktreeMissing: true } : {}),
      uncommittedFiles: uncommitted,
      detachedCommits: detached,
      ...(owned
        ? { branch: { name: worktree.branch, unpushedCommits: await unpushedCommits(git, worktree.sourceWorkspace, worktree.branch) } }
        : exists
          ? { keptBranch: worktree.branch }
          : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Removes what `planWorktreeRemoval` read, in this order: the worktree (forced only when
 * the plan counted uncommitted files, so one that changed since is refused by Git), Git's
 * record of it, and then the branch this app made. A worktree that could not be removed
 * rejects and leaves the branch alone; a branch that could not be deleted is reported.
 */
export async function removeSessionWorktree(
  git: GitRunner,
  plan: WorktreeRemovalPlan,
): Promise<{ branchKept?: string; branchError?: string }> {
  if (!plan.worktreeMissing)
    await git(plan.sourceWorkspace, [
      "worktree",
      "remove",
      ...(plan.uncommittedFiles > 0 ? ["--force"] : []),
      plan.worktreePath,
    ]);
  await git(plan.sourceWorkspace, ["worktree", "prune"]).catch(() => undefined);
  if (!plan.branch) return {};
  try {
    await git(plan.sourceWorkspace, ["branch", "-D", plan.branch.name]);
    return {};
  } catch (error) {
    return { branchKept: plan.branch.name, branchError: error instanceof Error ? error.message : String(error) };
  }
}

// ---- a worktree for a terminal or chat session

/** Fills a new worktree from its project's settings; the caller (main) binds the settings store. */
export type PrepareWorktree = (worktree: ManagedWorktree) => Promise<WorktreePreparation>;

/** The folder a terminal or chat session's new branch lives under, apart from GJC's `gajae`. */
export const SESSION_BRANCH_PREFIX = "peacock";

export interface SessionWorktree {
  worktree: ManagedWorktree;
  branchExisted: boolean;
  /** What its setup reported, when something did not go as asked. */
  setup?: WorktreeSetupReport;
}

/**
 * A worktree for a new Claude Code, Codex, omp or shell session: made like GJC's, then filled
 * from the project's settings. The setup cannot fail the session, so a rejection of `prepare`
 * only means nothing was copied or run. Everything that can be refused about the session
 * itself is to be checked before this, so what this makes is rarely taken back.
 */
export async function createSessionWorktree(input: {
  workspace: string;
  branch?: string;
  prepare?: PrepareWorktree;
  git?: GitRunner;
}): Promise<SessionWorktree> {
  const created = await createWorktree(
    {
      workspace: input.workspace,
      ...(input.branch ? { branch: input.branch } : {}),
      branchPrefix: SESSION_BRANCH_PREFIX,
      suffix: () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    },
    input.git,
  );
  const preparation = await Promise.resolve()
    .then(() => input.prepare?.(created.worktree))
    .catch(() => undefined);
  const setup = preparation ? worktreeSetupReport(preparation) : undefined;
  return { ...created, ...(setup ? { setup } : {}) };
}

/** Takes back a session's new worktree when the session never started: nothing ran in it. Never throws. */
export function discardSessionWorktree(created: SessionWorktree, git: GitRunner = runGit): Promise<void> {
  return discardNewWorktree(git, created.worktree.sourceWorkspace, created.worktree.path, created.worktree.branch, {
    keepBranch: created.branchExisted,
  });
}
