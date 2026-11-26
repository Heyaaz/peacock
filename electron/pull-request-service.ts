import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkedPullRequestInput,
  PULL_REQUEST_BODY_LIMIT,
  PULL_REQUEST_TITLE_LIMIT,
} from "../shared/pull-request.js";
import type {
  PullRequestDraft,
  PullRequestInput,
  PullRequestQuery,
  PullRequestStatus,
  PullRequestTarget,
} from "../shared/pull-request.js";
import type { GithubPullSummary } from "../shared/repo-ipc.js";
import {
  asList,
  asRecord,
  classifyGithubFailure,
  defaultCommandRunner,
  errorText,
  githubQuery,
  parsePull,
  PULL_FIELDS,
  readGhJson,
  readRemote,
  redactDetail,
} from "./repo-service.js";
import type { CommandOptions, CommandRunner, CommandResult } from "./repo-service.js";

/**
 * Looking up and opening the pull request of a session's branch.
 *
 * This is the one place the app writes to GitHub, and it is a service of its own so
 * that `RepoService` stays what its contract says: reads only. It reuses that module's
 * remote reading, failure classification and redaction, and adds what a write needs.
 * `gh` is never allowed to stop and ask (there is nobody at a terminal), the body goes
 * in a file so no text of the person's can become an argument, and creating gets a
 * longer limit than the reads around it.
 *
 * Nothing here confirms anything: the caller asks the person first, with the target
 * from `findPull`, and `createPull` refuses if the target changed in between.
 */

/** Reads keep the runner's own limit; opening a pull request waits on GitHub's write path. */
export const PULL_REQUEST_CREATE_TIMEOUT_MS = 90_000;

/**
 * What `gh` and Git are told so that neither prompts. `GH_HOST` pins github.com, the only host
 * a remote is recognised for, so a stray setting cannot send the call to another server.
 */
const NON_INTERACTIVE: Readonly<Record<string, string>> = Object.freeze({
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  GH_HOST: "github.com",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
});

const LISTED_PULLS = 20;
const PULL_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)[ \t]*$/mu;

export interface PullRequestServiceOptions {
  /** Git binary; defaults to the one on PATH. */
  gitExecutable?: string;
  /** GitHub CLI binary; defaults to the one on PATH. */
  ghExecutable?: string;
  /** The command runner; the shipped one spawns real processes. */
  run?: CommandRunner;
  /** Limit of `gh pr create`. */
  createTimeoutMs?: number;
  /** Where the body file is written; the system's temporary folder by default. */
  tempRoot?: string;
}

type Probe =
  | { kind: "default-branch" }
  | { kind: "found"; target: PullRequestTarget; pull: GithubPullSummary | null };

/** What GitHub allows in an owner or repository name; anything else is never handed to `gh` as an argument. */
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function repositoryName(owner: string, name: string): string {
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name))
    throw new Error("원격 저장소의 이름을 GitHub 저장소 이름으로 읽을 수 없습니다.");
  return `${owner}/${name}`;
}

function field(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function sameTarget(left: PullRequestTarget, right: PullRequestTarget): boolean {
  return (
    left.repo === right.repo &&
    left.base === right.base &&
    left.branch === right.branch &&
    left.head === right.head &&
    left.fork === right.fork
  );
}

/** A summary built from what `gh pr create` printed, for when reading the new pull request back fails. */
function createdSummary(url: string, number: number, title: string, target: PullRequestTarget): GithubPullSummary {
  return {
    number,
    title,
    state: "open",
    draft: false,
    url,
    author: "",
    headRefName: target.branch,
    baseRefName: target.base,
    review: "none",
    ci: { state: "none", total: 0, failing: 0, pending: 0, failedRuns: [] },
    updatedAt: "",
  };
}

export class PullRequestService {
  private readonly gitExecutable: string;
  private readonly ghExecutable: string;
  private readonly run: CommandRunner;
  private readonly createTimeoutMs: number;
  private readonly tempRoot: string;

  constructor(options: PullRequestServiceOptions = {}) {
    this.gitExecutable = options.gitExecutable ?? "git";
    this.ghExecutable = options.ghExecutable ?? "gh";
    this.run = options.run ?? defaultCommandRunner(this.ghExecutable);
    this.createTimeoutMs = options.createTimeoutMs ?? PULL_REQUEST_CREATE_TIMEOUT_MS;
    this.tempRoot = options.tempRoot ?? os.tmpdir();
  }

  /**
   * Where the worktree's branch would open a pull request, whether one is open already,
   * whether the branch is pushed, and what a new one could start with. Reads only.
   */
  async findPull(worktree: string): Promise<PullRequestQuery<PullRequestStatus>> {
    let branch: string;
    let remoteName: string;
    try {
      branch = await this.currentBranch(worktree);
      remoteName = branch ? await this.remoteNameOf(worktree, branch) : "origin";
    } catch (error) {
      return { state: "error", detail: redactDetail(errorText(error)) || "Git 정보를 읽지 못했습니다." };
    }
    if (!branch) return { state: "no-branch" };
    const probed = await githubQuery<Probe>(
      () => readRemote((args, cwd) => this.git(args, cwd), worktree, remoteName),
      async (owner, name) => {
        const target = await this.locate(worktree, branch, owner, name);
        if (!target) return { kind: "default-branch" };
        return { kind: "found", target, pull: await this.openPull(worktree, target, owner) };
      },
    );
    if (probed.state !== "ok") return probed;
    if (probed.value.kind === "default-branch") return { state: "default-branch", branch };
    const [pushed, draft] = await Promise.all([
      this.isPushed(worktree, remoteName, branch),
      this.latestCommit(worktree),
    ]);
    return {
      state: "ok",
      value: { target: probed.value.target, pull: probed.value.pull, pushed, draft },
    };
  }

  /**
   * Opens the pull request, or hands back the one that is already open. `confirmed` is the
   * target the person was shown; a branch that has moved elsewhere since is not opened.
   */
  async createPull(
    worktree: string,
    input: PullRequestInput,
    confirmed?: PullRequestTarget,
  ): Promise<PullRequestQuery<GithubPullSummary>> {
    const { title, body } = checkedPullRequestInput(input);
    const found = await this.findPull(worktree);
    if (found.state !== "ok") return found;
    const { target, pull, pushed } = found.value;
    if (confirmed && !sameTarget(confirmed, target))
      return {
        state: "error",
        detail: "확인한 뒤 대상이 바뀌었습니다. 다시 확인해 주세요.",
      };
    if (pull) return { state: "ok", value: pull };
    if (!pushed) return { state: "not-pushed", branch: target.branch };
    const directory = await mkdtemp(path.join(this.tempRoot, "peacock-pr-"));
    try {
      const bodyFile = path.join(directory, "body.md");
      await writeFile(bodyFile, body, { mode: 0o600 });
      let created: CommandResult;
      try {
        created = await this.run(
          this.ghExecutable,
          [
            "pr",
            "create",
            "--repo",
            target.repo,
            "--head",
            target.head,
            "--base",
            target.base,
            "--title",
            title,
            "--body-file",
            bodyFile,
          ],
          { ...this.options(worktree), timeoutMs: this.createTimeoutMs },
        );
      } catch (error) {
        return await this.afterFailedCreate(worktree, target, error);
      }
      const match = PULL_URL.exec(created.stdout);
      if (!match)
        return {
          state: "error",
          detail:
            redactDetail(`gh가 PR 주소를 알려 주지 않았습니다: ${created.stdout}`) ||
            "gh가 PR 주소를 알려 주지 않았습니다.",
        };
      const url = match[0].trim();
      return { state: "ok", value: await this.readCreated(worktree, url, Number(match[1]), title, target) };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private options(worktree: string): CommandOptions {
    return { cwd: worktree, env: NON_INTERACTIVE };
  }

  private git(args: readonly string[], cwd: string): Promise<CommandResult> {
    return this.run(this.gitExecutable, ["-C", cwd, ...args], { env: NON_INTERACTIVE });
  }

  /** The checked-out branch; empty on a detached HEAD, which is not a failure to read it. */
  private async currentBranch(worktree: string): Promise<string> {
    return (await this.git(["branch", "--show-current"], worktree)).stdout.trim();
  }

  /** The remote the branch is pushed to: the one it tracks, else `origin`, which is where its first push goes. */
  private async remoteNameOf(worktree: string, branch: string): Promise<string> {
    try {
      const configured = (await this.git(["config", "--get", `branch.${branch}.remote`], worktree)).stdout.trim();
      return configured && configured !== "." ? configured : "origin";
    } catch {
      return "origin";
    }
  }

  /**
   * The repository and branch a pull request from this branch would go to. A branch pushed to a
   * fork goes to the fork's parent, which is where the person means it; a branch on the repository's
   * own default branch goes nowhere, and that is `undefined`.
   */
  private async locate(
    worktree: string,
    branch: string,
    owner: string,
    name: string,
  ): Promise<PullRequestTarget | undefined> {
    const pushedTo = repositoryName(owner, name);
    const info = asRecord(
      await this.ghJson(["repo", "view", pushedTo, "--json", "isFork,parent,defaultBranchRef"], worktree),
    );
    const ownDefault = field(asRecord(info.defaultBranchRef), "name");
    const parent = asRecord(info.parent);
    const parentOwner = field(asRecord(parent.owner), "login");
    const parentName = field(parent, "name");
    const fork = info.isFork === true && parentOwner !== "" && parentName !== "";
    let repo = pushedTo;
    let base = ownDefault;
    if (fork) {
      repo = repositoryName(parentOwner, parentName);
      const upstream = asRecord(await this.ghJson(["repo", "view", repo, "--json", "defaultBranchRef"], worktree));
      base = field(asRecord(upstream.defaultBranchRef), "name");
    }
    if (!base) throw new Error("저장소의 기본 브랜치를 알 수 없습니다.");
    if (branch === base || branch === ownDefault) return undefined;
    return { repo, base, branch, head: fork ? `${owner}:${branch}` : branch, fork };
  }

  /**
   * The open pull request from this branch. `gh pr list --head` matches on the branch name alone, so
   * a pull request from someone else's fork that happens to share it is told apart by its head owner.
   */
  private async openPull(
    worktree: string,
    target: PullRequestTarget,
    headOwner: string,
  ): Promise<GithubPullSummary | null> {
    const listed = await this.ghJson(
      [
        "pr",
        "list",
        "--repo",
        target.repo,
        "--head",
        target.branch,
        "--state",
        "open",
        "--limit",
        String(LISTED_PULLS),
        "--json",
        `${PULL_FIELDS},isCrossRepository,headRepositoryOwner`,
      ],
      worktree,
    );
    for (const entry of asList(listed)) {
      const source = asRecord(entry);
      const crossRepository = source.isCrossRepository === true;
      const owner = field(asRecord(source.headRepositoryOwner), "login");
      const ours = target.fork
        ? crossRepository && owner.toLowerCase() === headOwner.toLowerCase()
        : !crossRepository;
      if (ours) return parsePull(source);
    }
    return null;
  }

  private ghJson(args: readonly string[], worktree: string): Promise<unknown> {
    return readGhJson(this.run, this.ghExecutable, args, this.options(worktree));
  }

  /** Every commit of the branch is on its remote branch, as this clone last saw it. */
  private async isPushed(worktree: string, remote: string, branch: string): Promise<boolean> {
    const ref = `refs/remotes/${remote}/${branch}`;
    try {
      await this.git(["rev-parse", "--verify", "--quiet", ref], worktree);
      const ahead = await this.git(["rev-list", "--count", `${ref}..HEAD`], worktree);
      return Number.parseInt(ahead.stdout.trim(), 10) === 0;
    } catch {
      return false;
    }
  }

  /** The latest commit's subject and message body, which is what the person wrote last. */
  private async latestCommit(worktree: string): Promise<PullRequestDraft> {
    try {
      const { stdout } = await this.git(["log", "-1", "--format=%s%x1f%b"], worktree);
      const [subject = "", ...rest] = stdout.split("\u001f");
      return {
        title: subject.trim().slice(0, PULL_REQUEST_TITLE_LIMIT),
        body: rest.join("\u001f").trim().slice(0, PULL_REQUEST_BODY_LIMIT),
      };
    } catch {
      return { title: "", body: "" };
    }
  }

  /** `gh` refuses a second pull request for the same branch; that one is the answer, not an error. */
  private async afterFailedCreate(
    worktree: string,
    target: PullRequestTarget,
    error: unknown,
  ): Promise<PullRequestQuery<GithubPullSummary>> {
    if (/already exists/iu.test(errorText(error))) {
      try {
        const headOwner = target.fork ? (target.head.split(":")[0] ?? "") : "";
        const existing = await this.openPull(worktree, target, headOwner);
        if (existing) return { state: "ok", value: existing };
      } catch {
        // fall through to the failure that was reported
      }
    }
    return classifyGithubFailure(error);
  }

  private async readCreated(
    worktree: string,
    url: string,
    number: number,
    title: string,
    target: PullRequestTarget,
  ): Promise<GithubPullSummary> {
    try {
      return parsePull(await this.ghJson(["pr", "view", url, "--json", PULL_FIELDS], worktree));
    } catch {
      // The pull request exists; only its CI could not be read just now.
      return createdSummary(url, number, title, target);
    }
  }
}
