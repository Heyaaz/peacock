/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, TranscriptItem } from "../backend/types";
import type { AgentBackend } from "../backend/agent-backend";
import { setLanguageMode } from "../i18n";
import type { NewSessionInput } from "./dialogs";
import { useCreateSession } from "./use-create-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const created = (extra: Partial<AgentSession> = {}): AgentSession => ({
  id: "real",
  title: "New session",
  subtitle: "repo",
  workspace: "/work/repo.gajae-worktrees/a",
  runtime: "gjc",
  status: "idle",
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#ff8a34",
  ownership: "gajae",
  attachment: "attached",
  ...extra,
});

/** The window's state as the hook's setters leave it. */
function harness(result: AgentSession | Error | Promise<AgentSession>) {
  const state = { sessions: [] as AgentSession[], selected: null as string | null, transcripts: {} as Record<string, TranscriptItem[]>, requests: [] as unknown[] };
  const setAppError = vi.fn();
  const pending: MutableRefObject<Map<string, Promise<AgentSession>>> = { current: new Map() };
  const createSession = vi.fn(async (_request: unknown) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const backend = { createSession } as unknown as AgentBackend;
  const onTerminalCreated = vi.fn();
  const rememberChoice = vi.fn();
  let create!: (input: NewSessionInput) => void | Promise<void>;
  function Harness({ onReady }: { onReady: (create: (input: NewSessionInput) => void | Promise<void>) => void }) {
    const createSessionFn = useCreateSession(
      backend,
      pending,
      setAppError,
      (next) => {
        state.requests.push(typeof next === "function" ? next(null) : next);
      },
      (next) => {
        state.sessions = typeof next === "function" ? next(state.sessions) : next;
      },
      (next) => {
        state.selected = typeof next === "function" ? next(state.selected) : next;
      },
      (next) => {
        state.transcripts = typeof next === "function" ? next(state.transcripts) : next;
      },
      onTerminalCreated,
      rememberChoice,
    );
    useEffect(() => {
      onReady(createSessionFn);
    });
    return null;
  }
  const mount = async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Harness, {
          onReady: (ready) => {
            create = ready;
          },
        }),
      );
    });
  };
  const start = async (input: NewSessionInput) => {
    await mount();
    let returned: void | Promise<void> = undefined;
    await act(async () => {
      returned = create(input);
      await Promise.allSettled([returned, ...pending.current.values()]);
    });
    return returned;
  };
  return { state, setAppError, createSession, onTerminalCreated, rememberChoice, pending, start };
}

describe("useCreateSession", () => {
  it("keeps the session and says so when its new worktree was not set up as asked", async () => {
    const { setAppError, start } = harness(
      created({ worktreeSetup: { setup: { status: "failed", exitCode: 2, output: "boom" } } }),
    );
    await start({ title: "t", workspace: "/work/repo", isolation: "worktree" });
    const message = setAppError.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain("세션은 그대로 열었습니다");
    expect(message).toContain("종료 코드 2(으)로");
    expect(message).toContain("마지막 출력: boom");
  });

  it("says nothing about a worktree that was set up as asked", async () => {
    const { setAppError, start } = harness(created());
    await start({ title: "t", workspace: "/work/repo", isolation: "worktree" });
    expect(setAppError.mock.calls.map(([message]) => message)).toEqual([""]);
  });

  describe("a terminal agent or chat", () => {
    const terminal = (extra: Partial<NewSessionInput> = {}): NewSessionInput => ({
      title: "claude",
      workspace: "/work/repo",
      kind: "terminal",
      agentKind: "claude",
      surface: "terminal",
      ...extra,
    });
    const real = (extra: Partial<AgentSession> = {}) =>
      created({ id: "terminal-1", runtime: "herdr", agentKind: "claude", workspace: "/work/repo", ...extra });

    it("opens in the folder as it is straight away, as before", async () => {
      const { state, createSession, onTerminalCreated, rememberChoice, start } = harness(real());
      await start(terminal({ remember: true }));
      expect(createSession).toHaveBeenCalledWith({
        runtime: "herdr",
        title: "claude",
        workspace: "/work/repo",
        isolation: "workspace",
        agentKind: "claude",
        surface: "terminal",
      });
      expect(state.sessions.map((session) => session.id)).toEqual(["terminal-1"]);
      expect(state.selected).toBe("terminal-1");
      expect(onTerminalCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "terminal-1" }), { agentKind: "claude", surface: "terminal" });
      expect(rememberChoice).toHaveBeenCalledWith({ agentKind: "claude", surface: "terminal" });
    });

    it("hands the host the worktree and the branch it asked for", async () => {
      const { createSession, start } = harness(real());
      await start(terminal({ isolation: "worktree", worktreeBranch: "feat/own" }));
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: "herdr", isolation: "worktree", worktreeBranch: "feat/own", workspace: "/work/repo" }),
      );
      expect(createSession.mock.calls[0]![0]).not.toHaveProperty("agentKind", undefined);
    });

    it("sends an omp chat the same request on its own runtime", async () => {
      const { createSession, start } = harness(real({ runtime: "omp-rpc", agentKind: "omp" }));
      await start(terminal({ agentKind: "omp", surface: "chat", isolation: "worktree" }));
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ runtime: "omp-rpc", isolation: "worktree", agentKind: "omp", surface: "chat" }));
      expect(createSession.mock.calls[0]![0]).not.toHaveProperty("worktreeBranch");
    });

    it("shows a session that is starting while its worktree is made, then swaps in the real one", async () => {
      let finish!: (session: AgentSession) => void;
      const slow = new Promise<AgentSession>((resolve) => {
        finish = resolve;
      });
      const { state, pending, onTerminalCreated, rememberChoice, start } = harness(slow);
      const running = start(terminal({ isolation: "worktree", remember: true }));
      await vi.waitFor(() => expect(state.sessions).toHaveLength(1));
      const [draft] = state.sessions;
      expect(draft).toMatchObject({ status: "starting", title: "claude" });
      expect(draft!.id).toMatch(/^draft-/u);
      expect(draft!.subtitle).toContain("worktree 준비 중…");
      // the window is on it, and a terminal is not opened for an id that is not one
      expect(state.selected).toBe(draft!.id);
      expect(draft!.runtime).toBe("gjc");
      expect(draft).not.toHaveProperty("agentKind");
      expect(state.requests.at(-1)).toBeNull();
      expect(pending.current.has(draft!.id)).toBe(true);
      expect(onTerminalCreated).not.toHaveBeenCalled();

      finish(real({ worktree: { sourceWorkspace: "/work/repo", path: "/work/repo.gajae-worktrees/a", branch: "peacock/a", managed: true } }));
      await running;
      expect(state.sessions.map((session) => session.id)).toEqual(["terminal-1"]);
      expect(state.selected).toBe("terminal-1");
      expect(state.transcripts).not.toHaveProperty(draft!.id);
      expect(onTerminalCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "terminal-1" }), { agentKind: "claude", surface: "terminal" });
      expect(rememberChoice).toHaveBeenCalledWith({ agentKind: "claude", surface: "terminal" });
    });

    it("leaves the user where they went while the worktree was being made", async () => {
      let finish!: (session: AgentSession) => void;
      const slow = new Promise<AgentSession>((resolve) => {
        finish = resolve;
      });
      const h = harness(slow);
      const running = h.start(terminal({ isolation: "worktree" }));
      await vi.waitFor(() => expect(h.state.sessions).toHaveLength(1));
      h.state.selected = "elsewhere";
      finish(real());
      await running;
      expect(h.state.selected).toBe("elsewhere");
      expect(h.state.sessions.map((session) => session.id)).toEqual(["terminal-1"]);
    });

    it("marks the starting session failed and says why when the worktree cannot be made", async () => {
      const { state, setAppError, rememberChoice, start } = harness(new Error("fatal: not a git repository"));
      const returned = await start(terminal({ isolation: "worktree", remember: true }));
      expect(returned).toBeUndefined();
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0]).toMatchObject({ status: "failed" });
      expect(setAppError.mock.calls.at(-1)?.[0]).toContain("fatal: not a git repository");
      expect(rememberChoice).not.toHaveBeenCalled();
    });

    it("says when the new worktree was not set up as asked", async () => {
      const { setAppError, start } = harness(
        real({ worktreeSetup: { copyProblems: [{ path: ".env", reason: "symlink" }] } }),
      );
      await start(terminal({ isolation: "worktree" }));
      expect(setAppError.mock.calls.at(-1)?.[0]).toContain(".env (심볼릭 링크)");
    });

    it("still reports a failure of a session in the folder to the dialog, which stays open", async () => {
      const { state, setAppError, start } = harness(new Error("claude: 설치되어 있지 않습니다"));
      await expect(start(terminal())).rejects.toThrow("claude: 설치되어 있지 않습니다");
      expect(state.sessions).toEqual([]);
      expect(state.requests).toEqual([]);
      expect(setAppError.mock.calls.map(([message]) => message)).toEqual([""]);
    });
  });
});
