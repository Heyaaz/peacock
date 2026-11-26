import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentSession, SessionStatus } from "../shared/agent-contract.js";
import { supportsTurnDiff } from "../shared/turn-diff.js";
import { TurnBaselines, snapshotTree, type TurnGit } from "./turn-baselines.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sandbox(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-turn-")));
  sandboxes.push(directory);
  return directory;
}

/** A repository with two tracked files, and a temporary folder of its own for the throwaway index. */
function repository(): { repo: string; tempRoot: string } {
  const parent = sandbox();
  const repo = path.join(parent, "repo");
  const tempRoot = path.join(parent, "tmp");
  mkdirSync(repo);
  mkdirSync(tempRoot);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "sub", "b.txt"), "b\n");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, tempRoot };
}

function session(id: string, workspace: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: id,
    workspace,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#fff",
    ownership: "gajae",
    attachment: "attached",
    ...extra,
  };
}

const updated = (row: AgentSession, status: SessionStatus): AgentEvent => ({
  type: "session.updated",
  session: { ...row, status },
});

/** Reports the statuses one after the other, as the runtimes' events would. */
function play(baselines: TurnBaselines, row: AgentSession, statuses: SessionStatus[]): void {
  for (const status of statuses) baselines.observe(updated(row, status));
}

const write = (repo: string, file: string, content: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
};

async function filesOf(baselines: TurnBaselines, id: string): Promise<string[]> {
  return (await baselines.diff(id)).files.map((file) => file.path).sort();
}

/** The real git, counting what it was asked, optionally held at its `add`. */
function watched(hold?: { until: Promise<void>; once: boolean }) {
  const calls: string[][] = [];
  let held = false;
  const run: TurnGit = async (cwd, args, options) => {
    calls.push([...args]);
    if (hold && args[0] === "add" && !(hold.once && held)) {
      held = true;
      await hold.until;
    }
    const { execFile } = await import("node:child_process");
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { maxBuffer: options?.maxBuffer ?? 1024 * 1024, env: { ...process.env, ...(options?.env ?? {}) } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  };
  return { run, calls, snapshots: () => calls.filter((args) => args[0] === "write-tree").length };
}

describe("what a turn changed", () => {
  it("compares the folder as the turn started with the folder now, untracked files and deletions included", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(repo, "a.txt", "a changed\n");
    write(repo, "new.txt", "new\n");
    rmSync(path.join(repo, "sub", "b.txt"));
    const snapshot = await baselines.diff("s1");
    expect(snapshot).toMatchObject({ sessionId: "s1", workspace: repo, scope: "turn", turn: { state: "ready" } });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(["a.txt", "new.txt", "sub/b.txt"]);
    expect(snapshot.files.find((file) => file.path === "new.txt")!.patch).toContain("+++ b/new.txt");
    expect(snapshot.files.find((file) => file.path === "a.txt")!.patch).toContain("+a changed");
  });

  it("leaves out what an earlier turn changed, though it is still uncommitted", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(repo, "a.txt", "first turn\n");
    write(repo, "first.txt", "first\n");
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(repo, "second.txt", "second\n");
    expect(await filesOf(baselines, "s1")).toEqual(["second.txt"]);
    // the cumulative diff still has all of it: that is what the other choice shows
    expect(git(repo, "status", "--porcelain")).toContain("a.txt");
  });

  it("still shows a change the agent committed during the turn", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(repo, "a.txt", "committed in the turn\n");
    git(repo, "commit", "-q", "-am", "agent commit");
    expect(git(repo, "diff", "HEAD", "--name-only").trim()).toBe("");
    expect(await filesOf(baselines, "s1")).toEqual(["a.txt"]);
  });

  it("leaves ignored files out", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(repo, "ignored.log", "noise\n");
    write(repo, "kept.txt", "kept\n");
    expect(await filesOf(baselines, "s1")).toEqual(["kept.txt"]);
  });

  it("works in a linked worktree, where a session started in its own copy lives", async () => {
    const { repo, tempRoot } = repository();
    const worktree = path.join(path.dirname(repo), "worktree");
    git(repo, "worktree", "add", "-q", "-b", "peacock/x", worktree);
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", worktree);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    write(worktree, "a.txt", "in the worktree\n");
    write(worktree, "fresh.txt", "fresh\n");
    expect(await filesOf(baselines, "s1")).toEqual(["a.txt", "fresh.txt"]);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("never touches the working files or the real index", async () => {
    const { repo, tempRoot } = repository();
    write(repo, "a.txt", "staged edit\n");
    git(repo, "add", "a.txt");
    write(repo, "a.txt", "then edited again\n");
    write(repo, "untracked.txt", "u\n");
    // `git status` refreshes the index itself, so it runs once up front and again at the end, never in between
    const statusBefore = git(repo, "status", "--porcelain=v1", "-uall");
    const cachedBefore = git(repo, "diff", "--cached", "--name-only");
    const indexFile = path.join(repo, ".git", "index");
    const fingerprint = () => ({
      index: readFileSync(indexFile).toString("base64"),
      indexMtime: statSync(indexFile).mtimeMs,
      files: ["a.txt", "untracked.txt", "sub/b.txt"].map((file) => [readFileSync(path.join(repo, file), "utf8"), statSync(path.join(repo, file)).mtimeMs]),
      locks: readdirSync(path.join(repo, ".git")).filter((name) => name.endsWith(".lock")),
    });
    const before = fingerprint();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    await baselines.diff("s1");
    expect(fingerprint()).toEqual(before);
    // what Git says about the folder is what it said, and the untracked file is still only untracked
    expect(git(repo, "status", "--porcelain=v1", "-uall")).toBe(statusBefore);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe(cachedBefore);
    expect(statusBefore).toContain("?? untracked.txt");
  });

  it("answers a read made right after a turn starts with that turn's baseline", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    // no idle(): the read itself waits for the start to be written down
    expect(await baselines.diff("s1")).toMatchObject({ turn: { state: "ready" }, files: [] });
  });
});

describe("when a turn starts", () => {
  const cases: Array<[string, SessionStatus[], number]> = [
    ["idle then running", ["idle", "running"], 1],
    ["a session first seen already running (its start is unknown)", ["running"], 0],
    ["running, waiting for an approval, running again: one turn", ["idle", "running", "waiting", "running"], 1],
    ["starting then running", ["starting", "running"], 1],
    ["failed then running", ["failed", "running"], 1],
    ["running repeated: one turn", ["idle", "running", "running", "running"], 1],
    ["never running", ["idle", "waiting", "idle"], 0],
  ];

  it.each(cases)("%s", async (_name, statuses, snapshots) => {
    const { repo, tempRoot } = repository();
    const { run, snapshots: taken } = watched();
    const baselines = new TurnBaselines({ tempRoot, git: run });
    play(baselines, session("s1", repo), statuses);
    await baselines.idle();
    expect(taken()).toBe(snapshots);
  });

  it("takes a baseline for each turn when the one before it was written down already", async () => {
    const { repo, tempRoot } = repository();
    const { run, snapshots } = watched();
    const baselines = new TurnBaselines({ tempRoot, git: run });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(snapshots()).toBe(2);
  });

  it("begins from the status the session was listed with", async () => {
    const { repo, tempRoot } = repository();
    const { run, snapshots } = watched();
    const baselines = new TurnBaselines({ tempRoot, git: run });
    baselines.seed([session("s1", repo)]);
    baselines.observe(updated(session("s1", repo), "running"));
    await baselines.idle();
    expect(snapshots()).toBe(1);
    expect(baselines.state("s1")).toMatchObject({ state: "ready" });
  });

  it("does not let the list overwrite what an event already said", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    baselines.observe(updated(session("s1", repo), "running"));
    baselines.seed([session("s1", repo)]);
    play(baselines, session("s1", repo), ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toMatchObject({ state: "ready" });
  });

  it.each([
    ["Codex", { agentKind: "codex" as const, runtime: "herdr" as const, capabilities: { git: true } }],
    ["a shell", { agentKind: "shell" as const, runtime: "herdr" as const, capabilities: { git: true } }],
    ["a terminal that does not offer git", { agentKind: "claude" as const, runtime: "herdr" as const, capabilities: { git: false } }],
  ])("reads nothing for %s and says so", async (_name, extra) => {
    const { repo, tempRoot } = repository();
    const { run, calls } = watched();
    const baselines = new TurnBaselines({ tempRoot, git: run });
    play(baselines, session("s1", repo, extra), ["idle", "running", "idle", "running"]);
    await baselines.idle();
    expect(calls).toHaveLength(0);
    expect(baselines.state("s1")).toEqual({ state: "unavailable", reason: "unsupported" });
    expect(await baselines.diff("s1")).toMatchObject({ files: [], scope: "turn", turn: { state: "unavailable", reason: "unsupported" } });
  });

  it("reads for every agent whose turn start is reported: GJC, an omp chat, Claude Code and omp terminals", () => {
    const base = { workspace: "/w" };
    expect(supportsTurnDiff({ ...base, runtime: "gjc" })).toBe(true);
    expect(supportsTurnDiff({ ...base, runtime: "omp-rpc", agentKind: "omp", capabilities: { git: true } })).toBe(true);
    expect(supportsTurnDiff({ ...base, runtime: "herdr", agentKind: "claude", capabilities: { git: true } })).toBe(true);
    expect(supportsTurnDiff({ ...base, runtime: "herdr", agentKind: "omp", capabilities: { git: true } })).toBe(true);
    expect(supportsTurnDiff({ ...base, runtime: "herdr", agentKind: "codex", capabilities: { git: true } })).toBe(false);
    expect(supportsTurnDiff({ workspace: "", runtime: "gjc" })).toBe(false);
  });

  it("keeps only the latest of two starts that come close together", async () => {
    const { repo, tempRoot } = repository();
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run, snapshots } = watched({ until, once: true });
    let clock = 1000;
    const baselines = new TurnBaselines({ tempRoot, git: run, now: () => clock });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    // the first snapshot is held at its add; a whole second turn starts meanwhile
    await new Promise((resolve) => setTimeout(resolve, 100));
    write(repo, "between.txt", "between\n");
    clock = 5000;
    play(baselines, row, ["idle", "running"]);
    release();
    await baselines.idle();
    expect(baselines.state("s1")).toEqual({ state: "ready", startedAt: new Date(5000).toISOString() });
    // the first snapshot finished too, but its start was no longer the latest and it was not kept: the
    // second turn's baseline already holds what came between, so nothing of it shows as this turn's
    expect(snapshots()).toBe(2);
    expect(await filesOf(baselines, "s1")).toEqual([]);
  });

  it("forgets a deleted session", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    play(baselines, session("s1", repo), ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1").state).toBe("ready");
    baselines.observe({ type: "session.deleted", sessionId: "s1" });
    expect(baselines.state("s1")).toEqual({ state: "unavailable", reason: "no-turn" });
    expect(baselines.state("never-seen")).toEqual({ state: "unavailable", reason: "no-turn" });
  });
});

describe("what turns the feature off", () => {
  it("is off for a repository past the index size, and reads nothing for it", async () => {
    const { repo, tempRoot } = repository();
    const { run, calls } = watched();
    const baselines = new TurnBaselines({ tempRoot, git: run, indexLimitBytes: 10 });
    play(baselines, session("s1", repo), ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toMatchObject({ state: "unavailable", reason: "too-large" });
    expect(calls.some((args) => args[0] === "add" || args[0] === "write-tree")).toBe(false);
    expect(readdirSync(tempRoot)).toEqual([]);
    expect(await baselines.diff("s1")).toMatchObject({ files: [], turn: { state: "unavailable", reason: "too-large" } });
  });

  it("is off for a folder with more untracked files than the limit, and on again once there are fewer", async () => {
    const { repo, tempRoot } = repository();
    for (const name of ["u1", "u2", "u3"]) write(repo, `${name}.txt`, name);
    const baselines = new TurnBaselines({ tempRoot, untrackedLimit: 2 });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toMatchObject({ state: "unavailable", reason: "too-large" });
    rmSync(path.join(repo, "u3.txt"));
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toMatchObject({ state: "ready" });
  });

  it("is off for a folder that is not a Git repository", async () => {
    const parent = sandbox();
    const tempRoot = path.join(parent, "tmp");
    mkdirSync(tempRoot);
    const baselines = new TurnBaselines({ tempRoot });
    play(baselines, session("s1", parent), ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toEqual({ state: "unavailable", reason: "not-git" });
  });

  it("does not keep an earlier turn's baseline when this turn's cannot be taken", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot, untrackedLimit: 1 });
    const row = session("s1", repo);
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1").state).toBe("ready");
    write(repo, "x.txt", "x");
    write(repo, "y.txt", "y");
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1")).toMatchObject({ state: "unavailable", reason: "too-large" });
  });

  it("reports a git that failed, with no token in what it says", async () => {
    const { repo, tempRoot } = repository();
    const token = "ghp_" + "a".repeat(36);
    const failing: TurnGit = async (cwd, args, options) => {
      if (args[0] === "write-tree") throw new Error(`fatal: could not write the tree ${token}`);
      return watched().run(cwd, args, options);
    };
    const baselines = new TurnBaselines({ tempRoot, git: failing });
    play(baselines, session("s1", repo), ["idle", "running"]);
    await baselines.idle();
    const state = baselines.state("s1");
    expect(state).toMatchObject({ state: "unavailable", reason: "failed" });
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state)).toContain("[redacted]");
  });

  it("says the baseline is lost when Git pruned the tree, and records the next turn again", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    const row = session("s1", repo);
    // an edit makes the baseline a tree no branch has, which Git is free to prune
    write(repo, "a.txt", "unrecorded edit\n");
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    git(repo, "prune", "--expire=now");
    expect(await baselines.diff("s1")).toMatchObject({ files: [], turn: { state: "unavailable", reason: "lost" } });
    expect(baselines.state("s1")).toMatchObject({ reason: "lost" });
    play(baselines, row, ["idle", "running"]);
    await baselines.idle();
    expect(baselines.state("s1").state).toBe("ready");
  });
});

describe("the throwaway index", () => {
  it("is removed after a snapshot, whether it worked or not", async () => {
    const { repo, tempRoot } = repository();
    const limits = { tempRoot, indexLimitBytes: 1024 * 1024, untrackedLimit: 100 };
    const real = watched().run;
    expect(await snapshotTree(real, repo, limits)).toMatchObject({ kind: "tree" });
    expect(readdirSync(tempRoot)).toEqual([]);
    for (const failAt of ["add", "write-tree"]) {
      const failing: TurnGit = async (cwd, args, options) => {
        if (args[0] === failAt) throw new Error(`${failAt} failed`);
        return real(cwd, args, options);
      };
      await expect(snapshotTree(failing, repo, limits)).rejects.toThrow(`${failAt} failed`);
      expect(readdirSync(tempRoot)).toEqual([]);
    }
  });

  it("is removed after a git that answers with something that is not a tree", async () => {
    const { repo, tempRoot } = repository();
    const real = watched().run;
    const odd: TurnGit = async (cwd, args, options) => (args[0] === "write-tree" ? "not a tree\n" : real(cwd, args, options));
    await expect(snapshotTree(odd, repo, { tempRoot, indexLimitBytes: 1 << 20, untrackedLimit: 10 })).rejects.toThrow("tree id");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("is never left behind by snapshots that run together", async () => {
    const { repo, tempRoot } = repository();
    const baselines = new TurnBaselines({ tempRoot });
    for (const id of ["s1", "s2", "s3", "s4"]) play(baselines, session(id, repo), ["idle", "running"]);
    await baselines.idle();
    expect(readdirSync(tempRoot)).toEqual([]);
    for (const id of ["s1", "s2", "s3", "s4"]) expect(baselines.state(id).state).toBe("ready");
  });

  it("is swept when a process died before it could remove it, and only when it is old and ours", async () => {
    const { tempRoot } = repository();
    const old = path.join(tempRoot, "peacock-turn-old");
    const fresh = path.join(tempRoot, "peacock-turn-fresh");
    const foreign = path.join(tempRoot, "someone-elses");
    for (const folder of [old, fresh, foreign]) {
      mkdirSync(folder);
      writeFileSync(path.join(folder, "index"), "x");
    }
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(old, hourAgo, hourAgo);
    utimesSync(foreign, hourAgo, hourAgo);
    const baselines = new TurnBaselines({ tempRoot });
    expect(await baselines.sweepStale()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});
