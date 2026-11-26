import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentSession, GitStatusSnapshot, ManagedWorktree } from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import type { PullRequestQuery, PullRequestStatus, PullRequestTarget } from "../shared/pull-request.js";
import type { GithubPullSummary } from "../shared/repo-ipc.js";
import { AttachmentStore } from "./attachment-store.js";
import { managedWorktreePath } from "./gjc-sdk-git.js";
import { registerGjcIpcHandlers } from "./gjc-ipc-handlers.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { PullRequestService } from "./pull-request-service.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
  },
}));

afterEach(() => handled.clear());

const event = { sender: { id: 5 } } as unknown as IpcMainInvokeEvent;
const call = (channel: string, ...args: unknown[]) => handled.get(channel)!(event, ...args);

const worktree: ManagedWorktree = {
  sourceWorkspace: "/repo",
  path: "/repo.gajae-worktrees/a",
  branch: "peacock/a",
  managed: true,
};

function session(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: id,
    workspace: worktree.path,
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#fff",
    ownership: "gajae",
    attachment: "attached",
    worktree,
    ...extra,
  };
}

const target: PullRequestTarget = {
  repo: "acme/widgets",
  base: "main",
  branch: "peacock/a",
  head: "peacock/a",
  fork: false,
};

const pull: GithubPullSummary = {
  number: 12,
  title: "Add widget",
  state: "open",
  draft: false,
  url: "https://github.com/acme/widgets/pull/12",
  author: "me",
  headRefName: "peacock/a",
  baseRefName: "main",
  review: "none",
  ci: { state: "passing", total: 1, failing: 0, pending: 0, failedRuns: [] },
  updatedAt: "",
};

const status = (extra: Partial<PullRequestStatus> = {}): PullRequestQuery<PullRequestStatus> => ({
  state: "ok",
  value: { target, pull: null, pushed: true, draft: { title: "Add widget", body: "" }, ...extra },
});

function setup(options: { sessions?: AgentSession[]; found?: PullRequestQuery<PullRequestStatus>; decline?: boolean; withService?: boolean } = {}) {
  const findPull = vi.fn(async () => options.found ?? status());
  const createPull = vi.fn(async () => ({ state: "ok", value: pull }) as PullRequestQuery<GithubPullSummary>);
  const authorizeDestructive = vi.fn(async () => {
    if (options.decline) throw new Error("Operation cancelled");
  });
  const getGitStatus = vi.fn(async (): Promise<GitStatusSnapshot> => ({
    workspace: worktree.path,
    branch: "peacock/a",
    ahead: 1,
    behind: 0,
    files: [],
  }));
  const pushChanges = vi.fn(async () => ({}));
  const sessions = options.sessions ?? [session("s1")];
  const listSessions = vi.fn(async () => sessions);
  const controller = {
    // what every runtime's controller answers from the session it holds
    sessionWorktreePath: async (id: string) => managedWorktreePath(sessions.find((candidate) => candidate.id === id)),
    listSessions,
    getGitStatus,
    pushChanges,
  };
  registerGjcIpcHandlers(
    controller as never,
    new AttachmentStore(),
    {
      guarded: (handler: (...args: unknown[]) => unknown) => handler,
      owner: vi.fn(),
      authorizeDestructive,
    } as unknown as IpcSecurity,
    undefined,
    options.withService === false ? undefined : ({ findPull, createPull } as unknown as PullRequestService),
  );
  return { findPull, createPull, authorizeDestructive, getGitStatus, pushChanges, listSessions };
}

describe("pushing from the window", () => {
  it("says where a first push goes and that it connects the branch", async () => {
    const { authorizeDestructive, pushChanges } = setup();
    await call(GJC_IPC.pushChanges, "s1");
    expect(authorizeDestructive).toHaveBeenCalledExactlyOnceWith(event, {
      message: "커밋을 push할까요?",
      detail: "origin/peacock/a에 push하고 upstream으로 연결합니다",
      confirmLabel: "Push",
    });
    expect(pushChanges).toHaveBeenCalledWith("s1");
  });

  it("names the upstream when the branch already has its own", async () => {
    const { authorizeDestructive, getGitStatus } = setup();
    getGitStatus.mockResolvedValueOnce({
      workspace: worktree.path,
      branch: "peacock/a",
      upstream: "origin/peacock/a",
      ahead: 1,
      behind: 0,
      files: [],
    });
    await call(GJC_IPC.pushChanges, "s1");
    expect(authorizeDestructive).toHaveBeenCalledWith(event, expect.objectContaining({ detail: "origin/peacock/a" }));
  });

  it("pushes nothing when the person declines", async () => {
    const { pushChanges } = setup({ decline: true });
    await expect(call(GJC_IPC.pushChanges, "s1")).rejects.toThrow("Operation cancelled");
    expect(pushChanges).not.toHaveBeenCalled();
  });
});

describe("looking up a pull request from the window", () => {
  it("finds the session's own worktree and asks about that, never a path from the window", async () => {
    const { findPull, listSessions } = setup();
    expect(await call(GJC_IPC.findPullRequest, "s1")).toEqual(status());
    expect(findPull).toHaveBeenCalledExactlyOnceWith(worktree.path);
    // the session list is a full discovery; a lookup that repeats must not pay for one
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("refuses a session that is not working in a worktree this app made", async () => {
    const { findPull } = setup({
      sessions: [session("plain", { worktree: undefined }), session("moved", { workspace: "/somewhere/else" })],
    });
    await expect(call(GJC_IPC.findPullRequest, "plain")).rejects.toThrow("managed Peacock worktree");
    await expect(call(GJC_IPC.findPullRequest, "moved")).rejects.toThrow("managed Peacock worktree");
    await expect(call(GJC_IPC.findPullRequest, "unknown")).rejects.toThrow("managed Peacock worktree");
    expect(findPull).not.toHaveBeenCalled();
  });

  it("is unavailable when the host has no pull request service", async () => {
    setup({ withService: false });
    await expect(call(GJC_IPC.findPullRequest, "s1")).rejects.toThrow("not available");
    await expect(call(GJC_IPC.createPullRequest, "s1", { title: "t", body: "" })).rejects.toThrow("not available");
  });
});

describe("opening a pull request from the window", () => {
  const input = { title: "Add widget", body: "Because." };

  it("asks first, naming the repository, the branches and the title, then creates what was shown", async () => {
    const { authorizeDestructive, createPull, findPull } = setup();
    expect(await call(GJC_IPC.createPullRequest, "s1", input)).toEqual({ state: "ok", value: pull });
    expect(authorizeDestructive).toHaveBeenCalledExactlyOnceWith(event, {
      message: "Pull request를 만들까요?",
      detail: "acme/widgets\nmain \u2190 peacock/a\n\nAdd widget",
      confirmLabel: "PR 만들기",
    });
    expect(findPull).toHaveBeenCalledWith(worktree.path);
    expect(createPull).toHaveBeenCalledExactlyOnceWith(worktree.path, input, target);
  });

  it("says when the pull request goes to the fork's parent", async () => {
    const forked = { ...target, fork: true, head: "me:peacock/a" };
    const { authorizeDestructive } = setup({ found: status({ target: forked }) });
    await call(GJC_IPC.createPullRequest, "s1", input);
    expect(authorizeDestructive).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ detail: "acme/widgets\nmain \u2190 me:peacock/a\n포크의 상위 저장소에 올립니다\n\nAdd widget" }),
    );
  });

  it("creates nothing when the person declines", async () => {
    const { createPull } = setup({ decline: true });
    await expect(call(GJC_IPC.createPullRequest, "s1", input)).rejects.toThrow("Operation cancelled");
    expect(createPull).not.toHaveBeenCalled();
  });

  it("hands back a pull request that is open already without asking or creating", async () => {
    const { authorizeDestructive, createPull } = setup({ found: status({ pull }) });
    expect(await call(GJC_IPC.createPullRequest, "s1", input)).toEqual({ state: "ok", value: pull });
    expect(authorizeDestructive).not.toHaveBeenCalled();
    expect(createPull).not.toHaveBeenCalled();
  });

  it("does not ask about a branch that is not pushed, or a lookup that failed", async () => {
    const unpushed = setup({ found: status({ pushed: false }) });
    expect(await call(GJC_IPC.createPullRequest, "s1", input)).toEqual({ state: "not-pushed", branch: "peacock/a" });
    expect(unpushed.authorizeDestructive).not.toHaveBeenCalled();
    handled.clear();
    const failed = setup({ found: { state: "unauthenticated", detail: "gh auth login" } });
    expect(await call(GJC_IPC.createPullRequest, "s1", input)).toEqual({ state: "unauthenticated", detail: "gh auth login" });
    expect(failed.authorizeDestructive).not.toHaveBeenCalled();
    expect(failed.createPull).not.toHaveBeenCalled();
  });

  it.each([
    [{ title: "", body: "" }],
    [{ title: "t", body: 1 }],
    [{ title: "t", body: "", draft: true }],
    ["title"],
    [null],
    [{ title: "x".repeat(300), body: "" }],
  ])("rejects a malformed payload before looking anything up (%#)", async (payload) => {
    const { authorizeDestructive, findPull, createPull } = setup();
    await expect(call(GJC_IPC.createPullRequest, "s1", payload)).rejects.toThrow();
    expect(findPull).not.toHaveBeenCalled();
    expect(authorizeDestructive).not.toHaveBeenCalled();
    expect(createPull).not.toHaveBeenCalled();
  });

  it("rejects a session id that is not one", async () => {
    setup();
    await expect(call(GJC_IPC.createPullRequest, "../etc", input)).rejects.toThrow("Session ID is invalid");
  });
});
