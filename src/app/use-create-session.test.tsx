/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../backend/types";
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

async function start(session: AgentSession) {
  const setAppError = vi.fn();
  const pending: MutableRefObject<Map<string, Promise<AgentSession>>> = { current: new Map() };
  const backend = { createSession: vi.fn(async () => session) } as unknown as AgentBackend;
  let create!: (input: NewSessionInput) => void | Promise<void>;
  function Harness({ onReady }: { onReady: (create: (input: NewSessionInput) => void | Promise<void>) => void }) {
    const createSession = useCreateSession(backend, pending, setAppError, vi.fn(), vi.fn(), vi.fn(), vi.fn());
    useEffect(() => {
      onReady(createSession);
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness, { onReady: (ready) => {
        create = ready;
      } }));
  });
  await act(async () => {
    create({ title: "t", workspace: "/work/repo", isolation: "worktree" });
    await Promise.all(pending.current.values());
  });
  return { setAppError, backend };
}

describe("useCreateSession", () => {
  it("keeps the session and says so when its new worktree was not set up as asked", async () => {
    const { setAppError } = await start(
      created({ worktreeSetup: { setup: { status: "failed", exitCode: 2, output: "boom" } } }),
    );
    const message = setAppError.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain("세션은 그대로 열었습니다");
    expect(message).toContain("종료 코드 2(으)로");
    expect(message).toContain("마지막 출력: boom");
  });

  it("says nothing about a worktree that was set up as asked", async () => {
    const { setAppError } = await start(created());
    expect(setAppError.mock.calls.map(([message]) => message)).toEqual([""]);
  });
});
