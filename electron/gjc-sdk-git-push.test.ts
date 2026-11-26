import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, ManagedWorktree } from "../shared/agent-contract.js";
import {
  managedWorktreePath,
  planPush,
  pushChanges,
  pushDestination,
  pushesToUpstream,
  type GitScope,
} from "./gjc-sdk-git.js";
import { createSessionWorktree } from "./worktree-service.js";

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

/** A repository whose `origin` is a bare repository next to it, so a push really happens. */
function repositoryWithRemote(options: { recordHead?: boolean } = {}): { repo: string; remote: string } {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-push-")));
  sandboxes.push(parent);
  const remote = path.join(parent, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "-q", "--bare", "-b", "main");
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  if (options.recordHead !== false) git(repo, "remote", "set-head", "origin", "main");
  return { repo, remote };
}

function scopeOf(worktree: ManagedWorktree, id = "s1"): GitScope {
  const session = {
    id,
    workspace: worktree.path,
    worktree,
  } as unknown as AgentSession;
  return { workspace: worktree.path, sessions: new Map([[id, session]]), sessionCwds: new Map([[id, worktree.path]]) };
}

function commitIn(directory: string, name: string): void {
  writeFileSync(path.join(directory, name), `${name}\n`);
  git(directory, "add", name);
  git(directory, "commit", "-q", "-m", `add ${name}`);
}

const branchesOn = (remote: string) => git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n");

describe("pushing a session's branch", () => {
  it("makes the first push of a new branch and sets its upstream", async () => {
    const { repo, remote } = repositoryWithRemote();
    const { worktree } = await createSessionWorktree({ workspace: repo });
    commitIn(worktree.path, "work.txt");
    const status = await pushChanges(scopeOf(worktree), "s1");
    expect(branchesOn(remote)).toContain(worktree.branch);
    expect(status.upstream).toBe(`origin/${worktree.branch}`);
    expect(status.ahead).toBe(0);
  });

  it("pushes plainly once the branch has its own upstream", async () => {
    const { repo, remote } = repositoryWithRemote();
    const { worktree } = await createSessionWorktree({ workspace: repo });
    commitIn(worktree.path, "one.txt");
    await pushChanges(scopeOf(worktree), "s1");
    commitIn(worktree.path, "two.txt");
    expect((await planPush(worktree.path)).args).toEqual(["push"]);
    const status = await pushChanges(scopeOf(worktree), "s1");
    expect(status.ahead).toBe(0);
    expect(git(remote, "log", "--format=%s", worktree.branch).trim().split("\n")[0]).toBe("add two.txt");
  });

  it("gives a branch that tracks origin/main its own first push instead of failing", async () => {
    const { repo, remote } = repositoryWithRemote();
    const worktreePath = path.join(path.dirname(repo), "tracking");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktreePath, "origin/main");
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/main");
    commitIn(worktreePath, "feature.txt");
    const worktree: ManagedWorktree = { sourceWorkspace: repo, path: worktreePath, branch: "feature", managed: true };
    const status = await pushChanges(scopeOf(worktree), "s1");
    expect(branchesOn(remote)).toContain("feature");
    expect(git(remote, "log", "--format=%s", "main").trim().split("\n")).toEqual(["init"]);
    expect(status.upstream).toBe("origin/feature");
  });

  it.each([[true], [false]])("never pushes the default branch (origin/HEAD recorded: %s)", async (recordHead) => {
    const { repo, remote } = repositoryWithRemote({ recordHead });
    // a worktree on a second branch is made while the main working tree is on main, so check main out there
    git(repo, "checkout", "-q", "-b", "elsewhere");
    const worktreePath = path.join(path.dirname(repo), "on-main");
    git(repo, "worktree", "add", "-q", worktreePath, "main");
    commitIn(worktreePath, "straight-to-main.txt");
    const worktree: ManagedWorktree = { sourceWorkspace: repo, path: worktreePath, branch: "main", managed: true };
    await expect(pushChanges(scopeOf(worktree), "s1")).rejects.toThrow("Refusing to push the default branch (main)");
    expect(git(remote, "log", "--format=%s", "main").trim().split("\n")).toEqual(["init"]);
  });

  it("takes the recorded default branch over the conventional names", async () => {
    const { repo, remote } = repositoryWithRemote();
    // the remote says its default is trunk: main is then an ordinary branch, and trunk is the protected one
    git(repo, "push", "-q", "origin", "main:trunk");
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "trunk");
    const { worktree } = await createSessionWorktree({ workspace: repo, branch: "main-fix" });
    commitIn(worktree.path, "fix.txt");
    expect((await planPush(worktree.path)).firstPush).toBe(true);
    git(repo, "checkout", "-q", "-b", "elsewhere");
    const onTrunk = path.join(path.dirname(repo), "on-trunk");
    git(repo, "worktree", "add", "-q", "-b", "trunk", onTrunk, "origin/trunk");
    await expect(planPush(onTrunk)).rejects.toThrow("default branch (trunk)");
    expect(branchesOn(remote)).not.toContain("main-fix");
  });

  it("refuses a detached HEAD", async () => {
    const { repo } = repositoryWithRemote();
    const { worktree } = await createSessionWorktree({ workspace: repo });
    git(worktree.path, "checkout", "-q", "--detach");
    await expect(planPush(worktree.path)).rejects.toThrow("detached HEAD");
  });

  it("still pushes only from a managed worktree the session is working in", async () => {
    const { repo } = repositoryWithRemote();
    const scope = scopeOf({ sourceWorkspace: repo, path: repo, branch: "main", managed: false } as unknown as ManagedWorktree);
    await expect(pushChanges(scope, "s1")).rejects.toThrow("managed Peacock worktree");
  });
});

describe("which push a branch gets", () => {
  it("is a plain push only for an upstream with the branch's own name", () => {
    expect(pushesToUpstream("work", "origin/work")).toBe(true);
    expect(pushesToUpstream("feature/x", "origin/feature/x")).toBe(true);
    expect(pushesToUpstream("feature", "origin/main")).toBe(false);
    expect(pushesToUpstream("work", undefined)).toBe(false);
    expect(pushesToUpstream("", "origin/work")).toBe(false);
  });

  it("names where the push goes", () => {
    expect(pushDestination({ branch: "work", upstream: "origin/work" })).toEqual({ destination: "origin/work", firstPush: false });
    expect(pushDestination({ branch: "work" })).toEqual({ destination: "origin/work", firstPush: true });
    expect(pushDestination({ branch: "work", upstream: "origin/main" })).toEqual({ destination: "origin/work", firstPush: true });
  });

  it("recognises the worktree a session works in, and nothing else", () => {
    const worktree = { sourceWorkspace: "/r", path: "/r.gajae-worktrees/a", branch: "b", managed: true } as ManagedWorktree;
    expect(managedWorktreePath({ workspace: "/r.gajae-worktrees/a", worktree })).toBe("/r.gajae-worktrees/a");
    expect(managedWorktreePath({ workspace: "/r", worktree })).toBeUndefined();
    expect(managedWorktreePath({ workspace: "/r.gajae-worktrees/a" })).toBeUndefined();
    expect(managedWorktreePath(undefined)).toBeUndefined();
  });
});
