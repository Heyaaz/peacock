/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatusSnapshot } from "../../shared/agent-contract";
import type { AgentSession } from "../backend/types";
import { setLanguageMode } from "../i18n";
import { TerminalSessionPane } from "./terminal-session-pane";

vi.mock("./terminal-view", () => ({
  TerminalView: ({ session, cwd }: { session: string; cwd: string }) =>
    createElement("div", { className: "terminal-pane", "data-session": session, "data-cwd": cwd }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setLanguageMode("ko");
});

const row = (extra: Partial<AgentSession> = {}): AgentSession => ({
  id: "terminal-1",
  title: "리뷰",
  subtitle: "Claude Code · repo",
  workspace: "/work/repo",
  runtime: "herdr",
  agentKind: "claude",
  status: "idle",
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#56d4dd",
  ownership: "gajae",
  attachment: "attached",
  ...extra,
});

const git = (branch: string): GitStatusSnapshot => ({ workspace: "/work/repo", branch, ahead: 0, behind: 0, files: [] });

async function render(props: Partial<Parameters<typeof TerminalSessionPane>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(TerminalSessionPane, { session: row(), ...props }));
  });
  return container;
}

const toggle = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[title="변경 파일 보기"]');

describe("TerminalSessionPane", () => {
  it("is a title, a folder and the terminal, with no changed-files button, for a session that offers none", async () => {
    const container = await render({ session: row({ agentKind: "shell", subtitle: "repo" }) });
    expect(container.querySelector('[data-surface="terminal"]')).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("리뷰");
    expect(container.querySelector(".terminal-pane")?.getAttribute("data-session")).toBe("terminal-1");
    expect(toggle(container)).toBeNull();
    expect(container.querySelector(".chat-header__actions")).toBeNull();
  });

  it("offers the changed files in the header for a session that has them", async () => {
    const onToggleDiff = vi.fn();
    const container = await render({ changedFiles: true, onToggleDiff });
    const button = toggle(container)!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button.click());
    expect(onToggleDiff).toHaveBeenCalledTimes(1);
  });

  it("opens the panel beside the terminal, in the same body, while the button is on", async () => {
    const panel = createElement("aside", { className: "diff-panel" }, "panel");
    const closed = await render({ changedFiles: true, onToggleDiff: () => undefined, panel });
    expect(closed.querySelector(".diff-panel")).toBeNull();
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    const open = await render({ changedFiles: true, diffOpen: true, onToggleDiff: () => undefined, panel });
    expect(toggle(open)!.getAttribute("aria-pressed")).toBe("true");
    const body = open.querySelector(".workspace-body")!;
    expect([...body.children].map((child) => child.className)).toEqual(["terminal-pane", "diff-panel"]);
  });

  it("shows no panel for a session that offers none, even when one is open for the window", async () => {
    const container = await render({ changedFiles: false, diffOpen: true, panel: createElement("aside", { className: "diff-panel" }) });
    expect(container.querySelector(".diff-panel")).toBeNull();
  });

  it("names the folder's branch in the header, or the worktree's until it is read", async () => {
    const read = await render({ git: git("main"), changedFiles: true });
    expect(read.textContent).toContain("main");
    expect(read.querySelector(".chat-branch[title*='Git']")?.textContent).toBe("main");
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    const worktree = { sourceWorkspace: "/work/repo", path: "/work/repo.gajae-worktrees/a", branch: "peacock/a", managed: true as const };
    const waiting = await render({ session: row({ worktree }), git: null, changedFiles: true });
    expect(waiting.querySelector(".chat-branch[title*='Git']")?.textContent).toBe("peacock/a");
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    const none = await render({ git: git("") });
    expect(none.querySelector(".chat-branch[title*='Git']")).toBeNull();
  });

  it("is in English when English is selected", async () => {
    setLanguageMode("en");
    const container = await render({ changedFiles: true, onToggleDiff: () => undefined, git: git("main") });
    expect(container.querySelector('button[title="View changed files"]')).not.toBeNull();
    expect(container.querySelector(".chat-branch[title*='Git branch in']")).not.toBeNull();
  });
});
