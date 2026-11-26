/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffSnapshot, GitStatusSnapshot } from "../../shared/agent-contract";
import type { PullRequestQuery, PullRequestStatus } from "../../shared/pull-request";
import type { GithubPullSummary } from "../../shared/repo-ipc";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { ciLabel, pullRequestFailureText } from "./github-labels";
import { DiffPanel } from "./inspector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string): AgentSession {
  return {
    id,
    title: id,
    subtitle: "gajae-bot",
    workspace: `/tmp/${id}`,
    runtime: "gjc",
    status: "idle",
    updatedAt: "10:00",
    updatedAtMs: 1,
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    worktree: { sourceWorkspace: "/tmp/src", path: `/tmp/${id}`, branch: `work/${id}`, managed: true },
  };
}

function git(extra: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return { workspace: "/tmp/a", branch: "work/a", ahead: 0, behind: 0, files: [], ...extra };
}

const target = { repo: "acme/widgets", base: "main", branch: "work/a", head: "work/a", fork: false };

const pull = (extra: Partial<GithubPullSummary> = {}): GithubPullSummary => ({
  number: 12,
  title: "Add widget",
  state: "open",
  draft: false,
  url: "https://github.com/acme/widgets/pull/12",
  author: "me",
  headRefName: "work/a",
  baseRefName: "main",
  review: "none",
  ci: { state: "pending", total: 2, failing: 0, pending: 1, failedRuns: [] },
  updatedAt: "",
  ...extra,
});

const found = (extra: Partial<PullRequestStatus> = {}): PullRequestQuery<PullRequestStatus> => ({
  state: "ok",
  value: { target, pull: null, pushed: true, draft: { title: "Add widget", body: "Why it is needed." }, ...extra },
});

const emptyDiff: DiffSnapshot = { sessionId: "a", workspace: "/tmp/a", files: [], refreshedAt: "now" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("the pull request step of the diff panel", () => {
  const getGitStatus = vi.fn<(id: string) => Promise<GitStatusSnapshot>>();
  const pushChanges = vi.fn<(id: string) => Promise<GitStatusSnapshot>>();
  const findPullRequest = vi.fn<(id: string) => Promise<PullRequestQuery<PullRequestStatus>>>();
  const createPullRequest = vi.fn<
    (id: string, input: { title: string; body: string }) => Promise<PullRequestQuery<GithubPullSummary>>
  >();
  const backend = {
    getGitStatus,
    stageFiles: vi.fn(),
    unstageFiles: vi.fn(),
    commitChanges: vi.fn(),
    pushChanges,
    findPullRequest,
    createPullRequest,
  } as unknown as AgentBackend;
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    for (const mock of [getGitStatus, pushChanges, findPullRequest, createPullRequest]) mock.mockReset();
  });

  function element(target: AgentSession, options: { refreshKey?: number; backend?: AgentBackend } = {}) {
    return createElement(DiffPanel, {
      session: target,
      backend: options.backend ?? backend,
      diff: emptyDiff,
      loading: false,
      onRefresh: () => undefined,
      onClose: () => undefined,
      ...(options.refreshKey === undefined ? {} : { refreshKey: options.refreshKey }),
    });
  }

  async function mount(target: AgentSession, options: { refreshKey?: number; backend?: AgentBackend } = {}) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await show(target, options);
  }

  async function show(target: AgentSession, options: { refreshKey?: number; backend?: AgentBackend } = {}) {
    await act(async () => {
      root.render(element(target, options));
    });
    await settle();
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const section = () => host.querySelector(".pull-request");
  const buttons = (label: string) =>
    [...host.querySelectorAll("button")].filter((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement[];
  const button = (label: string) => buttons(label)[0];

  async function type(selector: string, value: string): Promise<void> {
    const field = host.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit(): Promise<void> {
    await act(async () => {
      host
        .querySelector(".pull-request__form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
  }

  describe("pushing a branch", () => {
    it("offers a first push to a branch with no upstream, and pushes it", async () => {
      getGitStatus.mockResolvedValue(git());
      pushChanges.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      await mount(session("a"));
      expect(button("Push").disabled).toBe(false);
      expect(host.textContent).toContain("Push하면 Pull request를 만들 수 있습니다.");
      expect(findPullRequest).not.toHaveBeenCalled();
      await act(async () => {
        button("Push").click();
      });
      await settle();
      expect(pushChanges).toHaveBeenCalledWith("a");
      // pushed: the pull request is looked up now
      expect(findPullRequest).toHaveBeenCalledWith("a");
      expect(button("PR 만들기")).toBeDefined();
    });

    it("keeps Push off for a branch level with its upstream, and on once it is ahead", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      await mount(session("a"));
      expect(button("Push").disabled).toBe(true);
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a", ahead: 2 }));
      await show(session("a"), { refreshKey: 1 });
      expect(button("Push").disabled).toBe(false);
    });

    it("keeps Push off outside a repository", async () => {
      getGitStatus.mockResolvedValue(git({ branch: "" }));
      await mount(session("a"));
      expect(button("Push").disabled).toBe(true);
      expect(section()).toBeNull();
    });
  });

  describe("opening a pull request", () => {
    it("starts from the latest commit, then shows the link and CI of what was created", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      createPullRequest.mockResolvedValue({ state: "ok", value: pull() });
      await mount(session("a"));
      expect(section()!.textContent).toContain("acme/widgets");
      expect(section()!.textContent).toContain("main");
      expect(host.querySelector(".pull-request__form")).toBeNull();

      await act(async () => {
        button("PR 만들기").click();
      });
      const title = host.querySelector(".pull-request__form input") as HTMLInputElement;
      const body = host.querySelector(".pull-request__form textarea") as HTMLTextAreaElement;
      expect(title.value).toBe("Add widget");
      expect(body.value).toBe("Why it is needed.");

      await type(".pull-request__form input", "Add the widget");
      await type(".pull-request__form textarea", "Because we need it.");
      await submit();
      expect(createPullRequest).toHaveBeenCalledExactlyOnceWith("a", {
        title: "Add the widget",
        body: "Because we need it.",
      });
      const link = section()!.querySelector("a") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/12");
      expect(link.textContent).toBe("#12 Add widget");
      expect(link.rel).toContain("noopener");
      expect(section()!.textContent).toContain(ciLabel(pull().ci));
      expect(host.querySelector(".pull-request__form")).toBeNull();
      expect(buttons("PR 만들기")).toHaveLength(0);
    });

    it("shows only the link and its CI when a pull request is already open", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found({ pull: pull({ draft: true }) }));
      await mount(session("a"));
      expect(section()!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/12");
      expect(section()!.textContent).toContain(ciLabel(pull().ci));
      expect(section()!.textContent).toContain("Draft");
      expect(buttons("PR 만들기")).toHaveLength(0);
      expect(host.querySelector(".pull-request__form")).toBeNull();
    });

    it("reads the pull request's CI again on request", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValueOnce(found({ pull: pull() }));
      await mount(session("a"));
      const passing = pull({ ci: { state: "passing", total: 2, failing: 0, pending: 0, failedRuns: [] } });
      findPullRequest.mockResolvedValueOnce(found({ pull: passing }));
      await act(async () => {
        button("PR 상태 새로 고침").click();
      });
      await settle();
      expect(findPullRequest).toHaveBeenCalledTimes(2);
      expect(section()!.textContent).toContain(ciLabel(passing.ci));
    });

    it("does not offer to create while commits are not pushed", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a", ahead: 1 }));
      findPullRequest.mockResolvedValue(found());
      await mount(session("a"));
      expect(button("PR 만들기").disabled).toBe(true);
      expect(section()!.textContent).toContain("Push하지 않은 커밋이 있습니다. 먼저 Push하세요.");
    });

    it("says why when the branch cannot have a pull request, and reads again on request", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValueOnce({ state: "unauthenticated", detail: "token expired" });
      await mount(session("a"));
      expect(section()!.textContent).toContain("gh auth login");
      expect(section()!.textContent).toContain("token expired");
      findPullRequest.mockResolvedValueOnce(found());
      await act(async () => {
        button("다시 확인").click();
      });
      await settle();
      expect(findPullRequest).toHaveBeenCalledTimes(2);
      expect(button("PR 만들기")).toBeDefined();
    });

    it("offers no retry for a branch that can never have one", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/main", branch: "main" }));
      findPullRequest.mockResolvedValue({ state: "default-branch", branch: "main" });
      await mount(session("a"));
      expect(section()!.textContent).toContain("기본 브랜치(main)");
      expect(buttons("다시 확인")).toHaveLength(0);
    });

    it("reports a lookup the bridge rejected", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockRejectedValue(new Error("Pull requests require a managed Peacock worktree"));
      await mount(session("a"));
      expect(section()!.querySelector(".diff-error")!.textContent).toContain("managed Peacock worktree");
    });

    it("reports a refusal from GitHub in the form and keeps what was typed", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      createPullRequest.mockResolvedValue({ state: "error", detail: "Resource not accessible" });
      await mount(session("a"));
      await act(async () => {
        button("PR 만들기").click();
      });
      await type(".pull-request__form input", "Mine");
      await submit();
      expect(host.querySelector(".pull-request__form [role='alert']")!.textContent).toContain("Resource not accessible");
      expect((host.querySelector(".pull-request__form input") as HTMLInputElement).value).toBe("Mine");
      expect(section()!.querySelector("a")).toBeNull();
    });

    it("stays quiet when the person declines the host's question, and keeps the form", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      createPullRequest.mockRejectedValue(new Error("Error invoking remote method: Error: Operation cancelled"));
      await mount(session("a"));
      await act(async () => {
        button("PR 만들기").click();
      });
      await submit();
      expect(host.querySelector(".pull-request__form")).not.toBeNull();
      expect(host.querySelector(".pull-request__form [role='alert']")).toBeNull();
    });

    it("refuses an empty title, and never sends twice while creating", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found({ draft: { title: "", body: "" } }));
      const creation = deferred<PullRequestQuery<GithubPullSummary>>();
      createPullRequest.mockReturnValue(creation.promise);
      await mount(session("a"));
      await act(async () => {
        button("PR 만들기").click();
      });
      const create = host.querySelector(".pull-request__form button[type='submit']") as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      await type(".pull-request__form input", "Title");
      expect((host.querySelector(".pull-request__form button[type='submit']") as HTMLButtonElement).disabled).toBe(false);
      await submit();
      await submit();
      expect(createPullRequest).toHaveBeenCalledTimes(1);
      expect(host.querySelector(".pull-request__form button[type='submit']")!.textContent).toBe("만드는 중…");
      creation.resolve({ state: "ok", value: pull() });
      await settle();
      expect(section()!.querySelector("a")).not.toBeNull();
    });

    it("keeps what was typed when a turn ends and the pull request is read again", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found());
      await mount(session("a"), { refreshKey: 0 });
      await act(async () => {
        button("PR 만들기").click();
      });
      await type(".pull-request__form input", "Typed title");
      findPullRequest.mockResolvedValue(found({ draft: { title: "A newer commit", body: "" } }));
      await show(session("a"), { refreshKey: 1 });
      expect(findPullRequest).toHaveBeenCalledTimes(2);
      expect((host.querySelector(".pull-request__form input") as HTMLInputElement).value).toBe("Typed title");
    });

    it("drops a late answer for the session that was left", async () => {
      const first = deferred<PullRequestQuery<PullRequestStatus>>();
      getGitStatus.mockImplementation(async (id) => git({ upstream: `origin/work/${id}`, branch: `work/${id}` }));
      findPullRequest.mockImplementation((id) =>
        id === "a" ? first.promise : Promise.resolve(found({ target: { ...target, branch: "work/b", head: "work/b" } })),
      );
      await mount(session("a"));
      await show(session("b"));
      first.resolve(found({ pull: pull({ title: "Only in a" }) }));
      await settle();
      expect(host.textContent).not.toContain("Only in a");
      expect(button("PR 만들기")).toBeDefined();
    });

    it("shows an address that is not https as text, never as a link", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found({ pull: pull({ url: "javascript:alert(1)" }) }));
      await mount(session("a"));
      expect(section()!.querySelector("a")).toBeNull();
      expect(section()!.textContent).toContain("#12 Add widget");
    });

    it("mentions the fork's parent when that is where the pull request goes", async () => {
      getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
      findPullRequest.mockResolvedValue(found({ target: { ...target, fork: true, head: "me:work/a" } }));
      await mount(session("a"));
      expect(section()!.textContent).toContain("포크의 상위 저장소");
    });
  });

  it("shows no pull request step on a backend that cannot open one", async () => {
    getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
    const without = { getGitStatus, stageFiles: vi.fn(), unstageFiles: vi.fn(), commitChanges: vi.fn(), pushChanges } as unknown as AgentBackend;
    await mount(session("a"), { backend: without });
    expect(section()).toBeNull();
    expect(button("Push")).toBeDefined();
  });

  it("shows no pull request step for a session that is not in a worktree this app made", async () => {
    getGitStatus.mockResolvedValue(git({ upstream: "origin/work/a" }));
    await mount({ ...session("a"), worktree: undefined });
    expect(section()).toBeNull();
    expect(findPullRequest).not.toHaveBeenCalled();
  });
});

describe("the words for a pull request that cannot be opened", () => {
  it("names the branch for the default branch and tells the way forward for a push that is missing", () => {
    expect(pullRequestFailureText({ state: "default-branch", branch: "main" })).toContain("main");
    expect(pullRequestFailureText({ state: "not-pushed", branch: "x" })).toContain("Push");
    expect(pullRequestFailureText({ state: "no-branch" })).toContain("detached HEAD");
  });

  it("reuses the repository screen's sentence for a GitHub failure and adds its reason", () => {
    expect(pullRequestFailureText({ state: "no-cli", detail: "gh missing" })).toMatch(/gh.*gh missing/u);
    expect(pullRequestFailureText({ state: "no-remote" })).toContain("원격");
  });
});
