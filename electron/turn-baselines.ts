import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, AgentSession, DiffSnapshot, SessionStatus } from "../shared/agent-contract.js";
import {
  supportsTurnDiff,
  TURN_DIFF_INDEX_LIMIT_BYTES,
  TURN_DIFF_UNTRACKED_LIMIT,
  type TurnDiffReason,
  type TurnDiffState,
} from "../shared/turn-diff.js";
import { changedFilesFromDiff } from "./gjc-sdk-files.js";
import { BoundedProcessGate, errorText, redactDetail } from "./repo-service.js";

const execFile = promisify(execFileCallback);

/**
 * Where each session's latest turn began, as a Git tree.
 *
 * A turn starts when a session's status becomes `running` from anything but `running` or `waiting`:
 * that is the one signal every runtime gives (a GJC chat's run state, an omp chat's `agent_start` and
 * its `turnStartedAt`, a Claude Code terminal's `UserPromptSubmit` hook or its reported state), so it
 * is read from the events the app already broadcasts instead of from each runtime. Codex, which gives no
 * turn signal that can be trusted, and a shell, which has no turns, are left out.
 *
 * What is kept is a tree id and the time, in memory only. After a restart there is no baseline until the
 * next turn starts: a turn can run while the app is closed (a terminal agent keeps going), so a stored
 * baseline would quietly mean "since some earlier turn", and the tree is an unreferenced object that Git
 * may prune. A turn that was already running when the app started has no baseline either, because the
 * moment it began is unknown.
 *
 * Writing the tree never touches the folder's files or the real index: Git is given a copy of the index
 * to work in (so unchanged files are not read again), and that copy is removed when it is done, whatever
 * became of the command. It does add objects for changed files to the repository's object store, as any
 * `git add` does; Git collects them later.
 */

const GIT_TIMEOUT_MS = 60_000;
const DIFF_MAX_BYTES = 4 * 1024 * 1024;
const LIST_MAX_BYTES = 2 * 1024 * 1024;
const TEMP_PREFIX = "peacock-turn-";
/** A temporary index older than this belongs to a process that died before it could remove it. */
const STALE_AFTER_MS = 10 * 60_000;
/** Folders read at once; each is an index copy and a walk of a working tree. */
const SNAPSHOTS_AT_ONCE = 2;

export interface GitCallOptions {
  env?: Readonly<Record<string, string>>;
  maxBuffer?: number;
}

/** Runs git in a folder and returns its output; a failing git rejects. */
export type TurnGit = (cwd: string, args: readonly string[], options?: GitCallOptions) => Promise<string>;

const runGit: TurnGit = async (cwd, args, options) =>
  (
    await execFile("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: options?.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    })
  ).stdout;

export type TreeSnapshot =
  | { kind: "tree"; tree: string }
  | { kind: "unavailable"; reason: Extract<TurnDiffReason, "not-git" | "too-large">; detail?: string };

export interface TurnBaselinesOptions {
  git?: TurnGit;
  /** Where the throwaway index is made; the system's temporary folder by default. */
  tempRoot?: string;
  now?: () => number;
  indexLimitBytes?: number;
  untrackedLimit?: number;
}

interface Baseline {
  tree: string;
  startedAt: number;
  workspace: string;
}

interface Tracked {
  status: SessionStatus;
  workspace: string;
  supported: boolean;
  /** The newest turn start; a snapshot taken for an older one is dropped. */
  generation: number;
  baseline?: Baseline;
  failure?: { reason: TurnDiffReason; detail?: string };
  /** Snapshots of one session run one after another. */
  chain: Promise<void>;
}

/** A status that is a turn in progress, not the start of another. */
function inTurn(status: SessionStatus): boolean {
  return status === "running" || status === "waiting";
}

export class TurnBaselines {
  private readonly tracked = new Map<string, Tracked>();
  private readonly git: TurnGit;
  private readonly tempRoot: string;
  private readonly now: () => number;
  private readonly indexLimitBytes: number;
  private readonly untrackedLimit: number;
  private readonly gate = new BoundedProcessGate(SNAPSHOTS_AT_ONCE);

  constructor(options: TurnBaselinesOptions = {}) {
    this.git = options.git ?? runGit;
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.now = options.now ?? Date.now;
    this.indexLimitBytes = options.indexLimitBytes ?? TURN_DIFF_INDEX_LIMIT_BYTES;
    this.untrackedLimit = options.untrackedLimit ?? TURN_DIFF_UNTRACKED_LIMIT;
  }

  /**
   * The sessions the app lists at start, so a turn that begins later has a status to begin from.
   * What an event already said about a session is not overwritten.
   */
  seed(sessions: readonly AgentSession[]): void {
    for (const session of sessions) if (!this.tracked.has(session.id)) this.track(session, undefined);
  }

  /** The app's event stream: the only way a turn start is noticed. Never throws. */
  observe(event: AgentEvent): void {
    if (event.type === "session.deleted") {
      this.tracked.delete(event.sessionId);
      return;
    }
    if (event.type !== "session.created" && event.type !== "session.updated") return;
    const session = event.session;
    const previous = this.tracked.get(session.id);
    // read before `track` overwrites it
    const before = previous?.status;
    const tracked = this.track(session, previous);
    // a session seen for the first time already running began that turn before the app looked
    if (before !== undefined && tracked.supported && session.status === "running" && !inTurn(before)) this.begin(session.id, tracked);
  }

  /** Whether the session's latest turn can be read alone, and if not, why. */
  state(sessionId: string): TurnDiffState {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return { state: "unavailable", reason: "no-turn" };
    if (!tracked.supported) return { state: "unavailable", reason: "unsupported" };
    if (tracked.baseline) return { state: "ready", startedAt: new Date(tracked.baseline.startedAt).toISOString() };
    if (tracked.failure)
      return { state: "unavailable", reason: tracked.failure.reason, ...(tracked.failure.detail ? { detail: tracked.failure.detail } : {}) };
    return { state: "unavailable", reason: "no-turn" };
  }

  /**
   * What changed since the latest turn began: the baseline tree against the folder as it is now. A turn
   * that has just started is waited for, so a read right after it never sees the turn before.
   */
  async diff(sessionId: string): Promise<DiffSnapshot> {
    await this.tracked.get(sessionId)?.chain;
    const tracked = this.tracked.get(sessionId);
    const answer = (files: DiffSnapshot["files"], turn: TurnDiffState, error?: string): DiffSnapshot => ({
      sessionId,
      workspace: tracked?.baseline?.workspace ?? tracked?.workspace ?? "",
      files,
      refreshedAt: new Date(this.now()).toISOString(),
      scope: "turn",
      turn,
      ...(error ? { error } : {}),
    });
    const baseline = tracked?.baseline;
    const state = this.state(sessionId);
    if (!tracked || !baseline || state.state !== "ready") return answer([], state);
    try {
      // a tree Git pruned cannot be compared with; say so rather than failing the read
      const present = await this.git(baseline.workspace, ["cat-file", "-e", `${baseline.tree}^{tree}`]).then(
        () => true,
        () => false,
      );
      if (!present) {
        tracked.baseline = undefined;
        tracked.failure = { reason: "lost" };
        return answer([], this.state(sessionId));
      }
      const current = await this.snapshot(baseline.workspace);
      if (current.kind === "unavailable") {
        tracked.baseline = undefined;
        tracked.failure = { reason: current.reason, ...(current.detail ? { detail: current.detail } : {}) };
        return answer([], this.state(sessionId));
      }
      const files = changedFilesFromDiff(
        await this.git(
          baseline.workspace,
          ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", baseline.tree, current.tree, "--"],
          { maxBuffer: DIFF_MAX_BYTES },
        ),
      );
      return answer(files, state);
    } catch (error) {
      return answer([], state, redactDetail(errorText(error)) || "이번 턴의 변경을 읽지 못했습니다.");
    }
  }

  /** Resolves when every turn start seen so far has been written down. */
  async idle(): Promise<void> {
    await Promise.all([...this.tracked.values()].map((tracked) => tracked.chain));
  }

  /**
   * Removes temporary indexes a process left behind by dying mid-snapshot. Only folders with this
   * module's prefix and no recent change are touched.
   */
  async sweepStale(maxAgeMs = STALE_AFTER_MS): Promise<number> {
    const names = await readdir(this.tempRoot).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const folder = path.join(this.tempRoot, name);
      const info = await stat(folder).catch(() => undefined);
      if (!info?.isDirectory() || this.now() - info.mtimeMs < maxAgeMs) continue;
      await rm(folder, { recursive: true, force: true }).then(
        () => {
          removed += 1;
        },
        () => undefined,
      );
    }
    return removed;
  }

  private track(session: AgentSession, previous: Tracked | undefined): Tracked {
    const supported = supportsTurnDiff(session);
    const tracked: Tracked = previous ?? { status: session.status, workspace: session.workspace, supported, generation: 0, chain: Promise.resolve() };
    tracked.status = session.status;
    tracked.workspace = session.workspace;
    tracked.supported = supported;
    if (!supported) {
      // an agent that gives no turn signal has nothing worth keeping, and a later start must not resurrect it
      tracked.baseline = undefined;
      tracked.failure = undefined;
      tracked.generation += 1;
    }
    this.tracked.set(session.id, tracked);
    return tracked;
  }

  private begin(sessionId: string, tracked: Tracked): void {
    const generation = ++tracked.generation;
    const startedAt = this.now();
    const workspace = tracked.workspace;
    tracked.chain = tracked.chain.then(async () => {
      // a newer turn already asked: this one's start is not the latest
      if (tracked.generation !== generation) return;
      let outcome: TreeSnapshot | { kind: "failed"; detail: string };
      try {
        outcome = await this.snapshot(workspace);
      } catch (error) {
        outcome = { kind: "failed", detail: redactDetail(errorText(error)) };
      }
      if (tracked.generation !== generation || this.tracked.get(sessionId) !== tracked) return;
      if (outcome.kind === "tree") {
        tracked.baseline = { tree: outcome.tree, startedAt, workspace };
        tracked.failure = undefined;
        return;
      }
      // a baseline from an earlier turn would pass for this one's
      tracked.baseline = undefined;
      tracked.failure =
        outcome.kind === "failed"
          ? { reason: "failed", ...(outcome.detail ? { detail: outcome.detail } : {}) }
          : { reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
    });
  }

  private async snapshot(workspace: string): Promise<TreeSnapshot> {
    const release = await this.gate.acquire();
    try {
      return await snapshotTree(this.git, workspace, {
        tempRoot: this.tempRoot,
        indexLimitBytes: this.indexLimitBytes,
        untrackedLimit: this.untrackedLimit,
      });
    } finally {
      release();
    }
  }
}

/**
 * The folder's files as they are now, as a Git tree id: tracked changes, deletions and untracked files
 * that are not ignored, which is what `git add -A` would stage.
 *
 * The staging happens in a copy of the index in a folder made for it, so the real index, the working
 * files and the branch are not touched, and the copy keeps the stat data that lets Git skip files that
 * did not change. The folder is removed on every path out, a failure included. A repository past the size
 * limits is not read at all.
 */
export async function snapshotTree(
  git: TurnGit,
  workspace: string,
  limits: { tempRoot: string; indexLimitBytes: number; untrackedLimit: number },
): Promise<TreeSnapshot> {
  const inside = await git(workspace, ["rev-parse", "--is-inside-work-tree"]).then(
    (output) => output.trim() === "true",
    () => false,
  );
  if (!inside) return { kind: "unavailable", reason: "not-git" };
  const readOnly = { GIT_OPTIONAL_LOCKS: "0" };
  const indexPath = path.resolve(workspace, (await git(workspace, ["rev-parse", "--git-path", "index"])).trim());
  const indexSize = (await stat(indexPath).catch(() => undefined))?.size ?? 0;
  if (indexSize > limits.indexLimitBytes)
    return { kind: "unavailable", reason: "too-large", detail: `${Math.round(indexSize / (1024 * 1024))}MB` };
  if (await untrackedExceeds(git, workspace, limits.untrackedLimit, readOnly))
    return { kind: "unavailable", reason: "too-large", detail: `untracked > ${limits.untrackedLimit}` };
  const directory = await mkdtemp(path.join(limits.tempRoot, TEMP_PREFIX));
  try {
    const temporary = path.join(directory, "index");
    if (indexSize > 0) await copyFile(indexPath, temporary);
    const env = { ...readOnly, GIT_INDEX_FILE: temporary };
    await git(workspace, ["add", "-A"], { env });
    const tree = (await git(workspace, ["write-tree"], { env })).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new Error("git write-tree did not answer with a tree id");
    return { kind: "tree", tree };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether the folder holds more untracked files than the limit; the read stops at a bounded size, not at the end of the tree. */
async function untrackedExceeds(
  git: TurnGit,
  workspace: string,
  limit: number,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    const listed = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], { env, maxBuffer: LIST_MAX_BYTES });
    let count = 0;
    for (const character of listed) if (character === "\0") count += 1;
    return count > limit;
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
    throw error;
  }
}
