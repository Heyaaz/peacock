import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COPY_FILE_MAX_BYTES,
  copyProjectFiles,
  createWorktree,
  discardNewWorktree,
  discardUnusedWorktree,
  inspectWorktree,
  listWorktreePaths,
  prepareWorktree,
  removeWorktreeLeftovers,
  repositoryRoot,
  runGit,
  runSetupScript,
  worktreeSetupReport,
  worktreesByBranch,
} from "./worktree-service.js";

const sandboxes: string[] = [];

function sandbox(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-worktree-")));
  sandboxes.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A repository with one commit on main, inside its own folder so its worktrees stay in the sandbox. */
function repository(): { parent: string; repo: string } {
  const parent = sandbox();
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "init");
  return { parent, repo };
}

afterEach(() => {
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

let counter = 0;
const suffix = () => `s${(counter += 1)}`;

describe("worktreesByBranch", () => {
  it("maps each checked-out branch to its worktree and skips detached ones", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo.gajae-worktrees/a",
      "HEAD bbb",
      "branch refs/heads/feature/x",
      "",
      "worktree /elsewhere",
      "HEAD ccc",
      "detached",
      "",
    ].join("\n");
    expect([...worktreesByBranch(porcelain)]).toEqual([
      ["main", "/repo"],
      ["feature/x", "/repo.gajae-worktrees/a"],
    ]);
  });
});

describe("createWorktree", () => {
  it("makes a new branch from HEAD in <repo>.gajae-worktrees and names both by the suffix", async () => {
    const { parent, repo } = repository();
    const { worktree, branchExisted } = await createWorktree({ workspace: repo, suffix: () => "abc-1" });
    expect(branchExisted).toBe(false);
    expect(worktree).toEqual({
      sourceWorkspace: repo,
      path: path.join(parent, "repo.gajae-worktrees", "abc-1"),
      branch: "gajae/abc-1",
      managed: true,
    });
    expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("gajae/abc-1");
    expect(existsSync(path.join(worktree.path, "tracked.txt"))).toBe(true);
  });

  it("starts a named branch that does not exist from HEAD, and works from a subfolder", async () => {
    const { repo } = repository();
    mkdirSync(path.join(repo, "sub"));
    const { worktree, branchExisted } = await createWorktree({
      workspace: path.join(repo, "sub"),
      branch: " feature/new ",
      suffix,
    });
    expect(branchExisted).toBe(false);
    expect(worktree.sourceWorkspace).toBe(repo);
    expect(worktree.branch).toBe("feature/new");
    expect(git(repo, "rev-parse", "--verify", "refs/heads/feature/new").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("checks out a branch that exists instead of recreating it", async () => {
    const { repo } = repository();
    git(repo, "branch", "issue-7");
    writeFileSync(path.join(repo, "later.txt"), "later");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-q", "-m", "later");
    const { worktree, branchExisted } = await createWorktree({ workspace: repo, branch: "issue-7", suffix });
    expect(branchExisted).toBe(true);
    expect(existsSync(path.join(worktree.path, "later.txt"))).toBe(false);
  });

  it("checks out a branch that is only on one remote, so git tracks it", async () => {
    const { parent, repo } = repository();
    const remote = path.join(parent, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "branch", "pushed");
    git(repo, "push", "-q", "origin", "pushed");
    git(repo, "branch", "-D", "pushed");
    git(repo, "fetch", "-q", "origin");
    const { worktree, branchExisted } = await createWorktree({ workspace: repo, branch: "pushed", suffix });
    expect(branchExisted).toBe(false);
    expect(git(worktree.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").trim()).toBe("origin/pushed");
  });

  it("refuses a branch that must exist and does not, instead of starting it from HEAD", async () => {
    const { repo } = repository();
    await expect(
      createWorktree({ workspace: repo, branch: "nowhere", branchExisting: true, suffix }),
    ).rejects.toThrow("브랜치 nowhere");
    expect(git(repo, "branch", "--list", "nowhere")).toBe("");
  });

  it("fetches a fork pull's head into the branch it creates", async () => {
    const { parent, repo } = repository();
    const remote = path.join(parent, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "checkout", "-q", "-b", "fork-head");
    writeFileSync(path.join(repo, "fork.txt"), "fork");
    git(repo, "add", "fork.txt");
    git(repo, "commit", "-q", "-m", "fork");
    git(repo, "push", "-q", "origin", "fork-head:refs/pull/5/head");
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-D", "fork-head");
    const { worktree } = await createWorktree({ workspace: repo, branch: "pr-5", pull: { remote: "origin", number: 5 }, suffix });
    expect(existsSync(path.join(worktree.path, "fork.txt"))).toBe(true);
    await expect(
      createWorktree({ workspace: repo, branch: "pr-6", pull: { remote: "origin", number: 6 }, suffix }),
    ).rejects.toThrow("PR #6");
  });

  it("rejects outside a repository without asking for a suffix", async () => {
    const folder = sandbox();
    const asked = vi.fn(() => "x");
    await expect(createWorktree({ workspace: folder, suffix: asked })).rejects.toThrow();
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("discarding a worktree", () => {
  it("takes back an unused worktree with the branch it made", async () => {
    const { repo } = repository();
    const { worktree, branchExisted } = await createWorktree({ workspace: repo, suffix });
    await discardUnusedWorktree(runGit, worktree, branchExisted);
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("keeps a worktree that holds edits, and a branch that was there before", async () => {
    const { repo } = repository();
    const dirty = await createWorktree({ workspace: repo, suffix });
    writeFileSync(path.join(dirty.worktree.path, "work.txt"), "work");
    await discardUnusedWorktree(runGit, dirty.worktree, dirty.branchExisted);
    expect(existsSync(dirty.worktree.path)).toBe(true);

    git(repo, "branch", "mine");
    const existing = await createWorktree({ workspace: repo, branch: "mine", suffix });
    await discardUnusedWorktree(runGit, existing.worktree, existing.branchExisted);
    expect(existsSync(existing.worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", "mine")).toContain("mine");
  });

  it("never throws when there is nothing to take back", async () => {
    const { repo } = repository();
    await expect(
      discardUnusedWorktree(runGit, { sourceWorkspace: repo, path: path.join(repo, "gone"), branch: "x" }, false),
    ).resolves.toBeUndefined();
    await expect(discardNewWorktree(runGit, repo, path.join(repo, "gone"), "x")).resolves.toBeUndefined();
  });

  it("discards a new worktree with its branch even when it holds edits", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    writeFileSync(path.join(worktree.path, "work.txt"), "work");
    await discardNewWorktree(runGit, repo, worktree.path, worktree.branch);
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });
});

describe("inspecting and removing what is left", () => {
  it("reads the worktree, its uncommitted files and the commits only it has", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    expect(await inspectWorktree(runGit, repo, worktree.branch)).toEqual({
      branch: worktree.branch,
      worktreePath: worktree.path,
      uncommittedFiles: 0,
      branchExists: true,
      unpushedCommits: 0,
    });
    writeFileSync(path.join(worktree.path, "a.txt"), "a");
    writeFileSync(path.join(worktree.path, "b.txt"), "b");
    writeFileSync(path.join(worktree.path, "c.txt"), "c");
    git(worktree.path, "add", "c.txt");
    git(worktree.path, "commit", "-q", "-m", "c");
    expect(await inspectWorktree(runGit, repo, worktree.branch)).toMatchObject({
      uncommittedFiles: 2,
      unpushedCommits: 1,
    });
  });

  it("answers for a branch with no worktree, and for one that does not exist", async () => {
    const { repo } = repository();
    git(repo, "branch", "bare");
    expect(await inspectWorktree(runGit, repo, "bare")).toEqual({
      branch: "bare",
      uncommittedFiles: 0,
      branchExists: true,
      unpushedCommits: 0,
    });
    expect(await inspectWorktree(runGit, repo, "ghost")).toEqual({
      branch: "ghost",
      uncommittedFiles: 0,
      branchExists: false,
      unpushedCommits: 0,
    });
  });

  it("removes the worktree and its branch, discarding edits only when the plan counted them", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    writeFileSync(path.join(worktree.path, "a.txt"), "a");
    const leftovers = await inspectWorktree(runGit, repo, worktree.branch);
    await removeWorktreeLeftovers(runGit, repo, leftovers);
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("does not force a removal the plan did not count edits for", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    const leftovers = await inspectWorktree(runGit, repo, worktree.branch);
    // an edit that appeared after the plan was read: git itself refuses
    writeFileSync(path.join(worktree.path, "late.txt"), "late");
    await expect(removeWorktreeLeftovers(runGit, repo, leftovers)).rejects.toThrow();
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("only prunes Git's record when the folder is already gone", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    rmSync(worktree.path, { recursive: true });
    const leftovers = await inspectWorktree(runGit, repo, worktree.branch);
    expect(leftovers).toMatchObject({ worktreePath: worktree.path, worktreeMissing: true, uncommittedFiles: 0 });
    await removeWorktreeLeftovers(runGit, repo, leftovers);
    expect([...(await listWorktreePaths(runGit, repo)).keys()]).toEqual(["main"]);
    expect(git(repo, "branch", "--list", worktree.branch)).toBe("");
  });

  it("reads the root of the repository a folder is in", async () => {
    const { repo } = repository();
    mkdirSync(path.join(repo, "deep"));
    expect(await repositoryRoot(runGit, path.join(repo, "deep"))).toBe(repo);
    await expect(repositoryRoot(runGit, sandbox())).rejects.toThrow();
  });
});

describe("copyProjectFiles", () => {
  async function setup() {
    const { parent, repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    return { parent, repo, worktree };
  }

  it("copies files the repository does not carry, with their folders and permissions", async () => {
    const { repo, worktree } = await setup();
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n", { mode: 0o600 });
    chmodSync(path.join(repo, ".env"), 0o600);
    mkdirSync(path.join(repo, "config", "local"), { recursive: true });
    writeFileSync(path.join(repo, "config", "local", "app.json"), "{}");
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: [".env", "config/local/app.json"],
    });
    expect(report).toEqual({ copied: [".env", "config/local/app.json"], skipped: [] });
    expect(readFileSync(path.join(worktree.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(statSync(path.join(worktree.path, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(worktree.path, "config/local/app.json"), "utf8")).toBe("{}");
  });

  it("skips a missing file, one Git tracks, one that is already there, and does not overwrite", async () => {
    const { repo, worktree } = await setup();
    writeFileSync(path.join(repo, ".env"), "from-root");
    writeFileSync(path.join(worktree.path, ".env"), "own");
    writeFileSync(path.join(repo, "tracked.txt"), "edited in root");
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: [".env", "tracked.txt", "absent.txt"],
    });
    expect(report.copied).toEqual([]);
    expect(report.skipped).toEqual([
      { path: ".env", reason: "exists" },
      { path: "tracked.txt", reason: "tracked" },
      { path: "absent.txt", reason: "missing" },
    ]);
    expect(readFileSync(path.join(worktree.path, ".env"), "utf8")).toBe("own");
    expect(readFileSync(path.join(worktree.path, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it("refuses paths that leave the root, however they are written", async () => {
    const { parent, repo, worktree } = await setup();
    writeFileSync(path.join(parent, "outside.txt"), "outside");
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: ["../outside.txt", "/etc/hosts", "a/../../outside.txt", ".git/config", "dir/"],
    });
    expect(report.copied).toEqual([]);
    expect(report.skipped.map((entry) => entry.reason)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"]);
    expect(existsSync(path.join(worktree.path, "..", "outside.txt"))).toBe(false);
  });

  it("does not follow a symlink file, nor a folder that is a symlink out of the root", async () => {
    const { parent, repo, worktree } = await setup();
    const secrets = path.join(parent, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "key"), "key");
    symlinkSync(path.join(secrets, "key"), path.join(repo, "link-file"));
    symlinkSync(secrets, path.join(repo, "link-dir"));
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: ["link-file", "link-dir/key"],
    });
    expect(report.copied).toEqual([]);
    expect(report.skipped).toEqual([
      { path: "link-file", reason: "symlink" },
      { path: "link-dir/key", reason: "outside" },
    ]);
    expect(existsSync(path.join(worktree.path, "link-file"))).toBe(false);
    expect(existsSync(path.join(worktree.path, "link-dir"))).toBe(false);
  });

  it("does not write through a folder of the worktree that is a symlink out of it", async () => {
    const { parent, repo, worktree } = await setup();
    const target = path.join(parent, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, path.join(worktree.path, "linked"));
    mkdirSync(path.join(repo, "linked"));
    writeFileSync(path.join(repo, "linked", "x.env"), "x");
    const report = await copyProjectFiles({ sourceRoot: repo, worktreePath: worktree.path, files: ["linked/x.env"] });
    expect(report.skipped).toEqual([{ path: "linked/x.env", reason: "outside" }]);
    expect(existsSync(path.join(target, "x.env"))).toBe(false);
  });

  it("skips a folder and a file that is too large", async () => {
    const { repo, worktree } = await setup();
    mkdirSync(path.join(repo, "folder"));
    writeFileSync(path.join(repo, "folder", "f"), "f");
    writeFileSync(path.join(repo, "big.bin"), "");
    truncateSync(path.join(repo, "big.bin"), COPY_FILE_MAX_BYTES + 1);
    const report = await copyProjectFiles({ sourceRoot: repo, worktreePath: worktree.path, files: ["folder", "big.bin"] });
    expect(report.skipped).toEqual([
      { path: "folder", reason: "not-a-file" },
      { path: "big.bin", reason: "too-large" },
    ]);
  });

  it("copies a file once however often it is listed, and treats a path with glob characters literally", async () => {
    const { repo, worktree } = await setup();
    writeFileSync(path.join(repo, "a[1].env"), "a1");
    writeFileSync(path.join(repo, "a1.env"), "plain");
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: ["a[1].env", "./a[1].env"],
    });
    expect(report.copied).toEqual(["a[1].env"]);
    expect(existsSync(path.join(worktree.path, "a1.env"))).toBe(false);
  });

  it("copies nothing when Git cannot say what it tracks", async () => {
    const { repo, worktree } = await setup();
    writeFileSync(path.join(repo, ".env"), "x");
    const failing = async () => {
      throw new Error("git is gone");
    };
    const report = await copyProjectFiles({
      sourceRoot: repo,
      worktreePath: worktree.path,
      files: [".env"],
      git: failing,
    });
    expect(report).toEqual({ copied: [], skipped: [{ path: ".env", reason: "failed" }] });
    expect(existsSync(path.join(worktree.path, ".env"))).toBe(false);
  });

  it("does nothing for an empty list", async () => {
    const { repo, worktree } = await setup();
    const git = vi.fn(async () => "");
    expect(await copyProjectFiles({ sourceRoot: repo, worktreePath: worktree.path, files: [], git })).toEqual({
      copied: [],
      skipped: [],
    });
    expect(git).not.toHaveBeenCalled();
  });
});

describe("runSetupScript", () => {
  it("runs in the worktree with the paths it needs, and keeps what it printed", async () => {
    const cwd = sandbox();
    const result = await runSetupScript({
      script: 'echo "cwd=$(pwd -P)"; echo "root=$PEACOCK_ROOT_PATH"; echo "err" >&2',
      cwd,
      env: { PEACOCK_ROOT_PATH: "/the/root" },
    });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`cwd=${cwd}`);
    expect(result.output).toContain("root=/the/root");
    expect(result.output).toContain("err");
  });

  it("reports a failing script with its exit code and the end of its output", async () => {
    const result = await runSetupScript({ script: "echo first; echo second; exit 3", cwd: sandbox() });
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    expect(result.output).toContain("second");
  });

  it("keeps only the end of a long output", async () => {
    const result = await runSetupScript({
      script: 'i=0; while [ $i -lt 2000 ]; do echo "line-$i-xxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done',
      cwd: sandbox(),
      outputLimit: 1024,
    });
    expect(result.status).toBe("ok");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
    expect(result.output).toContain("line-1999-");
    expect(result.output).not.toContain("line-0-");
  });

  it("stops a script that runs too long, with everything it started", async () => {
    const cwd = sandbox();
    const pidFile = path.join(cwd, "pid");
    const result = await runSetupScript({
      script: `sleep 30 & echo $! > "${pidFile}"; wait`,
      cwd,
      timeoutMs: 300,
    });
    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("reports a script that cannot be started", async () => {
    const result = await runSetupScript({ script: "true", cwd: path.join(sandbox(), "missing") });
    expect(result.status).toBe("error");
  });
});

describe("prepareWorktree", () => {
  it("copies the files first so the script can use them", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    writeFileSync(path.join(repo, ".env"), "TOKEN=abc");
    const preparation = await prepareWorktree({
      settings: { setupScript: 'cp .env copied.env && echo "$PEACOCK_WORKTREE_BRANCH" > branch.txt', copyFiles: [".env"] },
      sourceRoot: repo,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    expect(preparation.copy?.copied).toEqual([".env"]);
    expect(preparation.setup?.status).toBe("ok");
    expect(readFileSync(path.join(worktree.path, "copied.env"), "utf8")).toBe("TOKEN=abc");
    expect(readFileSync(path.join(worktree.path, "branch.txt"), "utf8").trim()).toBe(worktree.branch);
    expect(worktreeSetupReport(preparation)).toBeUndefined();
  });

  it("does nothing for settings with neither", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    const preparation = await prepareWorktree({
      settings: { setupScript: "  ", copyFiles: [] },
      sourceRoot: repo,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    expect(preparation).toEqual({ problems: { copy: [] } });
  });

  it("does not count a file the project lacks, or one Git has, as a problem", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    const preparation = await prepareWorktree({
      settings: { setupScript: "", copyFiles: ["missing.env", "tracked.txt"] },
      sourceRoot: repo,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    expect(preparation.copy?.skipped).toHaveLength(2);
    expect(worktreeSetupReport(preparation)).toBeUndefined();
  });

  it("reports an unusable copy and a script that failed, and still runs the script", async () => {
    const { repo } = repository();
    const { worktree } = await createWorktree({ workspace: repo, suffix });
    symlinkSync("/etc/hosts", path.join(repo, "hosts-link"));
    const preparation = await prepareWorktree({
      settings: { setupScript: "echo ran > ran.txt; echo broke >&2; exit 2", copyFiles: ["hosts-link"] },
      sourceRoot: repo,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    expect(existsSync(path.join(worktree.path, "ran.txt"))).toBe(true);
    expect(worktreeSetupReport(preparation)).toEqual({
      copyProblems: [{ path: "hosts-link", reason: "symlink" }],
      setup: { status: "failed", exitCode: 2, output: expect.stringContaining("broke") },
    });
  });

  it("bounds the output a report carries", () => {
    const report = worktreeSetupReport({
      problems: { copy: [], setup: { status: "failed", exitCode: 1, output: `${"x".repeat(5000)}END`, durationMs: 1 } },
    });
    expect(report?.setup?.output.length).toBeLessThanOrEqual(2000);
    expect(report?.setup?.output.endsWith("END")).toBe(true);
  });
});
