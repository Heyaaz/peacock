import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, ManagedWorktree } from "../shared/agent-contract.js";
import type { ConfirmContent } from "./confirm-overlay.js";
import { setHostLanguage } from "./host-text.js";
import { SessionWorktreeRemoval, usesWorktree, worktreeRemovalConfirmation } from "./session-worktree-removal.js";
import { createSessionWorktree, planWorktreeRemoval, runGit, type GitRunner } from "./worktree-service.js";

const sandboxes: string[] = [];

afterEach(() => {
  setHostLanguage("ko");
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repository(): { parent: string; repo: string } {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-session-removal-")));
  sandboxes.push(parent);
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "init");
  return { parent, repo };
}

const row = (id: string, workspace: string, extra: Partial<AgentSession> = {}): AgentSession => ({
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
});

const event = { sender: { id: 5 } } as unknown as IpcMainInvokeEvent;
const exists = (repo: string, branch: string) => git(repo, "branch", "--list", branch).trim() !== "";

/** A session in a worktree this app made, and the removal that sees it and whatever else is listed. */
async function setup(options: { others?: (worktree: ManagedWorktree, repo: string) => AgentSession[]; answer?: boolean; branch?: string; existing?: boolean } = {}) {
  const { parent, repo } = repository();
  if (options.existing) git(repo, "branch", options.branch!);
  const made = await createSessionWorktree({ workspace: repo, ...(options.branch ? { branch: options.branch } : {}) });
  const worktree = made.worktree;
  const sessions: AgentSession[] = [row("mine", worktree.path, { worktree }), ...(options.others?.(worktree, repo) ?? [])];
  const confirm = vi.fn(async (_event: IpcMainInvokeEvent, _content: ConfirmContent) => options.answer ?? true);
  const listSessions = vi.fn(async () => sessions);
  const removal = new SessionWorktreeRemoval({ listSessions, confirm });
  return { parent, repo, worktree, sessions, confirm, listSessions, removal };
}

describe("usesWorktree", () => {
  const worktree = { sourceWorkspace: "/w/repo", path: "/w/repo.gajae-worktrees/a", branch: "b", managed: true as const };

  it("is a session in the worktree's folder, inside it, or recorded in it", () => {
    expect(usesWorktree({ workspace: "/w/repo.gajae-worktrees/a" }, worktree.path)).toBe(true);
    expect(usesWorktree({ workspace: "/w/repo.gajae-worktrees/a/src/deep" }, worktree.path)).toBe(true);
    expect(usesWorktree({ workspace: "/elsewhere", worktree }, worktree.path)).toBe(true);
  });

  it("is not a session beside it, in a folder that only starts the same, or in the repository", () => {
    expect(usesWorktree({ workspace: "/w/repo.gajae-worktrees/ab" }, worktree.path)).toBe(false);
    expect(usesWorktree({ workspace: "/w/repo.gajae-worktrees" }, worktree.path)).toBe(false);
    expect(usesWorktree({ workspace: "/w/repo" }, worktree.path)).toBe(false);
    expect(usesWorktree({ workspace: "/w/repo", worktree: { ...worktree, path: "/w/repo.gajae-worktrees/other" } }, worktree.path)).toBe(false);
  });
});

describe("worktreeRemovalConfirmation", () => {
  const base = { worktreePath: "/w/repo.gajae-worktrees/a", sourceWorkspace: "/w/repo", uncommittedFiles: 0, detachedCommits: 0 };

  it("names every loss, and has a keep answer that is not a cancellation", () => {
    const content = worktreeRemovalConfirmation({
      ...base,
      uncommittedFiles: 3,
      detachedCommits: 2,
      branch: { name: "peacock/a", unpushedCommits: 4 },
    });
    expect(content).toMatchObject({ message: "이 세션의 worktree도 지울까요?", confirmLabel: "worktree도 지우기", cancelLabel: "남겨 두기", danger: true });
    expect(content.detail).toContain("worktree 삭제: /w/repo.gajae-worktrees/a (커밋하지 않은 변경 3개가 사라집니다)");
    expect(content.detail).toContain("브랜치에 속하지 않은 커밋 2개가 사라집니다");
    expect(content.detail).toContain("브랜치 삭제: peacock/a (push하지 않은 커밋 4개가 사라집니다)");
    expect(content.detail).toContain("남겨 두기를 고르면");
  });

  it("says nothing is lost when nothing is, and which branch stays", () => {
    const detail = worktreeRemovalConfirmation({ ...base, branch: { name: "peacock/a", unpushedCommits: 0 } }).detail!;
    expect(detail).toContain("worktree 삭제: /w/repo.gajae-worktrees/a\n");
    expect(detail).not.toContain("사라집니다");
    expect(detail).toContain("브랜치 삭제: peacock/a\n");
    const kept = worktreeRemovalConfirmation({ ...base, keptBranch: "mine" }).detail!;
    expect(kept).toContain("브랜치 mine은(는) 그대로 둡니다");
    expect(kept).not.toContain("브랜치 삭제");
  });

  it("says that only Git's record is cleaned up when the folder is gone", () => {
    expect(worktreeRemovalConfirmation({ ...base, worktreeMissing: true }).detail).toContain("이미 없어 Git의 기록만 정리합니다");
  });

  it("is in English when the host is", () => {
    setHostLanguage("en");
    const content = worktreeRemovalConfirmation({ ...base, uncommittedFiles: 1, branch: { name: "peacock/a", unpushedCommits: 2 } });
    expect(content.detail).toContain("Remove worktree: /w/repo.gajae-worktrees/a (1 uncommitted changes will be lost)");
    expect(content.detail).toContain("Delete branch: peacock/a (2 unpushed commits will be lost)");
    expect(content.detail).not.toMatch(/[가-힣]/u);
  });
});

describe("asking about a session's worktree", () => {
  it("asks once for the delete the window confirms ahead, and the delete uses that answer", async () => {
    const { removal, confirm, worktree, repo } = await setup();
    await removal.remember(event, "mine");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]).toMatchObject({ confirmLabel: "worktree도 지우기" });
    const decision = await removal.decide(event, "mine");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ sessionId: "mine", worktree, plan: { worktreePath: worktree.path, sourceWorkspace: repo } });
  });

  it("asks at the delete when the window did not ask ahead", async () => {
    const { removal, confirm } = await setup();
    expect(await removal.decide(event, "mine")).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after the user chose to keep the worktree", async () => {
    const { removal, confirm } = await setup({ answer: false });
    await removal.remember(event, "mine");
    expect(await removal.decide(event, "mine")).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("uses an answer once, for the window that gave it, and not after it has waited too long", async () => {
    const { parent, repo } = repository();
    void parent;
    const made = await createSessionWorktree({ workspace: repo });
    let now = 1_000;
    const confirm = vi.fn(async () => true);
    const removal = new SessionWorktreeRemoval({
      listSessions: async () => [row("mine", made.worktree.path, { worktree: made.worktree })],
      confirm,
      now: () => now,
    });
    await removal.remember(event, "mine");
    expect(await removal.decide({ sender: { id: 6 } } as unknown as IpcMainInvokeEvent, "mine")).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(2);
    await removal.decide(event, "mine");
    await removal.decide(event, "mine");
    expect(confirm).toHaveBeenCalledTimes(3);
    await removal.remember(event, "mine");
    now += 3 * 60_000;
    await removal.decide(event, "mine");
    expect(confirm).toHaveBeenCalledTimes(5);
  });

  it("asks nothing of a session that has no worktree of this app's", async () => {
    const { repo } = repository();
    const confirm = vi.fn(async () => true);
    const removal = new SessionWorktreeRemoval({
      listSessions: async () => [row("plain", repo), row("main-record", repo, { worktree: { sourceWorkspace: repo, path: repo, branch: "main", managed: true, createdBranch: true } })],
      confirm,
    });
    expect(await removal.decide(event, "plain")).toBeUndefined();
    expect(await removal.decide(event, "main-record")).toBeUndefined();
    expect(await removal.decide(event, "unknown")).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it.each([
    ["a fork in the same worktree", (worktree: ManagedWorktree) => [row("fork", worktree.path, { worktree, parentId: "mine" })]],
    ["a session of another runtime in the same folder", (worktree: ManagedWorktree) => [row("terminal-1", worktree.path, { runtime: "herdr", agentKind: "claude" })]],
    ["a chat in a folder of the worktree", (worktree: ManagedWorktree) => [row("omp-1", path.join(worktree.path, "src"), { runtime: "omp-rpc", agentKind: "omp" })]],
    ["a session recorded in it that works elsewhere", (worktree: ManagedWorktree) => [row("moved", "/tmp", { worktree })]],
  ])("offers nothing while %s is still listed", async (_label, others) => {
    const { removal, confirm, worktree } = await setup({ others });
    expect(await removal.decide(event, "mine")).toBeUndefined();
    await removal.remember(event, "mine");
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("is not kept by a session in another worktree or in the repository", async () => {
    const { removal, confirm } = await setup({ others: (_worktree, repo) => [row("elsewhere", repo), row("other", `${repo}.gajae-worktrees/other`)] });
    expect(await removal.decide(event, "mine")).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("never rejects: a session list or a dialog that fails only means no question", async () => {
    const { worktree } = await setup();
    const failingList = new SessionWorktreeRemoval({
      listSessions: async () => {
        throw new Error("GJC is not running");
      },
      confirm: async () => true,
    });
    await expect(failingList.remember(event, "mine")).resolves.toBeUndefined();
    await expect(failingList.decide(event, "mine")).resolves.toBeUndefined();
    const failingDialog = new SessionWorktreeRemoval({
      listSessions: async () => [row("mine", worktree.path, { worktree })],
      confirm: async () => {
        throw new Error("window closed");
      },
    });
    await expect(failingDialog.decide(event, "mine")).resolves.toBeUndefined();
    expect(existsSync(worktree.path)).toBe(true);
  });
});

describe("removing what the user agreed to", () => {
  it("removes the worktree and the branch this app made, once the session is gone", async () => {
    const { removal, sessions, worktree, repo } = await setup();
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "removed" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(exists(repo, worktree.branch)).toBe(false);
    expect(exists(repo, "main")).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("gajae-worktrees");
    expect(readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it("removes what the user was told would be lost, edits and unpushed commits included", async () => {
    const { removal, sessions, worktree, repo } = await setup();
    writeFileSync(path.join(worktree.path, "work.txt"), "w");
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "unpushed");
    const decision = (await removal.decide(event, "mine"))!;
    expect(decision.plan).toMatchObject({ uncommittedFiles: 1, branch: { unpushedCommits: 1 } });
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "removed" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(exists(repo, worktree.branch)).toBe(false);
  });

  it("keeps a branch the user made, and removes only the worktree", async () => {
    const { removal, sessions, worktree, repo } = await setup({ branch: "mine", existing: true });
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "my work");
    const decision = (await removal.decide(event, "mine"))!;
    expect(decision.plan.keptBranch).toBe("mine");
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "removed" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(exists(repo, "mine")).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", "mine").trim()).toBe("my work");
  });

  it.each([
    ["an edit", (worktree: ManagedWorktree) => writeFileSync(path.join(worktree.path, "late.txt"), "late")],
    ["a commit", (worktree: ManagedWorktree) => git(worktree.path, "commit", "-q", "--allow-empty", "-m", "late")],
  ])("keeps the worktree when %s came after the user agreed", async (_label, change) => {
    const { removal, sessions, worktree, repo } = await setup();
    const decision = (await removal.decide(event, "mine"))!;
    change(worktree);
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "kept", reason: "changed" });
    expect(existsSync(worktree.path)).toBe(true);
    expect(exists(repo, worktree.branch)).toBe(true);
  });

  it("deletes only the branch this app made when the user moved the worktree onto a branch of their own", async () => {
    const { removal, sessions, worktree, repo } = await setup();
    git(worktree.path, "switch", "-q", "-c", "my-feature");
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", "feature work");
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "removed" });
    expect(existsSync(worktree.path)).toBe(false);
    expect(exists(repo, worktree.branch)).toBe(false);
    expect(exists(repo, "my-feature")).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", "my-feature").trim()).toBe("feature work");
  });

  it("keeps the worktree when another session started using it since", async () => {
    const { removal, sessions, worktree, repo } = await setup();
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    sessions.push(row("late-fork", worktree.path, { worktree }));
    expect(await removal.run(decision)).toEqual({ status: "kept", reason: "shared" });
    expect(existsSync(worktree.path)).toBe(true);
    expect(exists(repo, worktree.branch)).toBe(true);
  });

  it("keeps the worktree when it can no longer be checked", async () => {
    const { removal, listSessions, sessions, worktree } = await setup();
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    listSessions.mockRejectedValueOnce(new Error("GJC went away"));
    expect(await removal.run(decision)).toEqual({ status: "kept", reason: "failed", detail: "GJC went away" });
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("keeps the worktree when git refuses, and says why", async () => {
    const { parent, repo } = repository();
    void parent;
    const made = await createSessionWorktree({ workspace: repo });
    const sessions = [row("mine", made.worktree.path, { worktree: made.worktree })];
    const refusing: GitRunner = async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: cannot remove");
      return runGit(cwd, args);
    };
    const removal = new SessionWorktreeRemoval({ listSessions: async () => sessions, confirm: async () => true, git: refusing });
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    expect(await removal.run(decision)).toEqual({ status: "kept", reason: "failed", detail: "fatal: cannot remove" });
    expect(existsSync(made.worktree.path)).toBe(true);
    expect(exists(repo, made.worktree.branch)).toBe(true);
  });

  it("says when the worktree is gone but a branch could not be deleted", async () => {
    const { parent, repo } = repository();
    void parent;
    const made = await createSessionWorktree({ workspace: repo });
    const sessions = [row("mine", made.worktree.path, { worktree: made.worktree })];
    const git2: GitRunner = async (cwd, args) => {
      if (args[0] === "branch") throw new Error("error: cannot delete branch");
      return runGit(cwd, args);
    };
    const removal = new SessionWorktreeRemoval({ listSessions: async () => sessions, confirm: async () => true, git: git2 });
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    expect(await removal.run(decision)).toEqual({
      status: "removed",
      branchKept: made.worktree.branch,
      detail: "error: cannot delete branch",
    });
    expect(existsSync(made.worktree.path)).toBe(false);
  });

  it("never removes a worktree of the user's, or the repository's own, even on an approval it holds", async () => {
    const { parent, repo } = repository();
    const theirs = path.join(parent, "theirs");
    git(repo, "worktree", "add", "-q", "-b", "theirs", theirs);
    writeFileSync(path.join(theirs, "mine.txt"), "important");
    const forged = { sourceWorkspace: repo, path: theirs, branch: "theirs", managed: true as const, createdBranch: true };
    const removal = new SessionWorktreeRemoval({ listSessions: async () => [], confirm: async () => true });
    const outcome = await removal.run({
      sessionId: "forged",
      worktree: forged,
      plan: { worktreePath: theirs, sourceWorkspace: repo, uncommittedFiles: 1, detachedCommits: 0, branch: { name: "theirs", unpushedCommits: 0 } },
    });
    expect(outcome).toEqual({ status: "kept", reason: "changed" });
    const own = await removal.run({
      sessionId: "forged",
      worktree: { ...forged, path: repo, branch: "main" },
      plan: { worktreePath: repo, sourceWorkspace: repo, uncommittedFiles: 0, detachedCommits: 0, branch: { name: "main", unpushedCommits: 0 } },
    });
    expect(own).toEqual({ status: "kept", reason: "changed" });
    expect(readFileSync(path.join(theirs, "mine.txt"), "utf8")).toBe("important");
    expect(exists(repo, "theirs")).toBe(true);
    expect(exists(repo, "main")).toBe(true);
    expect(readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("tracked\n");
  });

  it("matches the plan the same way the question was made, so an untouched worktree is always removable", async () => {
    const { removal, sessions, worktree } = await setup();
    const decision = (await removal.decide(event, "mine"))!;
    sessions.shift();
    expect(JSON.stringify(await planWorktreeRemoval(runGit, worktree))).toBe(JSON.stringify(decision.plan));
  });
});
