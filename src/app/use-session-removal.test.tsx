/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRemovalResult } from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { useSessionRemoval } from "./use-session-removal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const session = (id: string): AgentSession => ({
  id,
  title: id,
  subtitle: id,
  workspace: "/work/repo.gajae-worktrees/a",
  runtime: "gjc",
  status: "idle",
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#fff",
  ownership: "gajae",
  attachment: "attached",
});

async function start(options: { confirmed?: boolean; result?: SessionRemovalResult | void; failure?: Error }) {
  const sessions = [session("s1"), session("s2")];
  const state = { sessions: [...sessions], selected: "s1" as string | null };
  const setAppError = vi.fn();
  const forgetSession = vi.fn((id: string) => {
    state.sessions = state.sessions.filter((entry) => entry.id !== id);
  });
  const backend = {
    confirmSessionRemoval: vi.fn(async () => options.confirmed ?? true),
    deleteSession: vi.fn(async () => {
      if (options.failure) throw options.failure;
      return options.result;
    }),
    hideSession: vi.fn(async () => undefined),
  } as unknown as AgentBackend;
  let remove!: (session: AgentSession) => void;
  function Harness({ onReady }: { onReady: (remove: (session: AgentSession) => void) => void }) {
    const removing: RefObject<Set<string>> = { current: new Set() };
    const { onDeleteSession } = useSessionRemoval(
      backend,
      removing,
      sessions,
      state.selected,
      forgetSession,
      async (id) => id,
      (next) => {
        state.sessions = typeof next === "function" ? next(state.sessions) : next;
      },
      (next) => {
        state.selected = typeof next === "function" ? next(state.selected) : next;
      },
      setAppError,
    );
    useEffect(() => {
      onReady(onDeleteSession);
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Harness, {
        onReady: (ready) => {
          remove = ready;
        },
      }),
    );
  });
  await act(async () => {
    remove(sessions[0]!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { state, setAppError, backend, forgetSession };
}

describe("deleting a session from the window", () => {
  it("says nothing when the session and its worktree both went", async () => {
    const { setAppError, backend, state } = await start({ result: { worktree: { status: "removed" } } });
    expect(backend.deleteSession).toHaveBeenCalledWith("s1");
    expect(state.sessions.map((entry) => entry.id)).toEqual(["s2"]);
    expect(setAppError).not.toHaveBeenCalled();
  });

  it("says nothing for a delete that answers nothing", async () => {
    const { setAppError } = await start({ result: undefined });
    expect(setAppError).not.toHaveBeenCalled();
  });

  it("says that the worktree is still there, while the session stays gone", async () => {
    const { setAppError, state } = await start({ result: { worktree: { status: "kept", reason: "changed" } } });
    expect(setAppError).toHaveBeenCalledTimes(1);
    expect(setAppError.mock.calls[0]![0]).toContain("확인한 뒤 worktree의 내용이 바뀌어");
    expect(state.sessions.map((entry) => entry.id)).toEqual(["s2"]);
  });

  it("says which branch is left when only the branch could not be deleted", async () => {
    const { setAppError } = await start({ result: { worktree: { status: "removed", branchKept: "peacock/a" } } });
    expect(setAppError.mock.calls[0]![0]).toContain("브랜치 peacock/a");
  });

  it("deletes nothing when the user declines, and puts the row back when the delete fails", async () => {
    const declined = await start({ confirmed: false });
    expect(declined.backend.deleteSession).not.toHaveBeenCalled();
    expect(declined.state.sessions.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    const failed = await start({ failure: new Error("세션 삭제를 확정하지 못했습니다.") });
    expect(failed.state.sessions.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(failed.setAppError).toHaveBeenCalledWith("세션 삭제를 확정하지 못했습니다.");
  });
});
