/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInspection } from "../../shared/settings-ipc";
import type { AgentAvailability } from "../../shared/terminal-ipc";
import { setLanguageMode } from "../i18n";
import { NewSessionDialog, type NewSessionDialogProps, type NewSessionInput } from "./dialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  setLanguageMode("ko");
});

const AGENTS: AgentAvailability[] = [
  { id: "claude", name: "Claude Code", installed: true, binary: "/bin/claude" },
  { id: "omp", name: "Oh My Pi", installed: true, binary: "/bin/omp" },
  { id: "gjc", name: "GJC", installed: true, binary: "/bin/gjc" },
  { id: "shell", name: "Shell", installed: true },
];

async function open(inspection: Partial<WorkspaceInspection> | undefined, props: Partial<NewSessionDialogProps> = {}) {
  vi.stubGlobal("agentControlDesktop", undefined);
  (window as unknown as { agentControlDesktop: unknown }).agentControlDesktop = {
    settings: { inspectWorkspace: vi.fn(async () => ({ broad: false, git: true, ...inspection })), discardAttachments: vi.fn() },
    terminal: { listAgents: vi.fn(async () => AGENTS) },
  };
  const created: NewSessionInput[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/work/project",
        terminalSessions: true,
        choice: { agentKind: "claude", surface: "terminal" },
        onCancel: () => undefined,
        onCreate: (input) => {
          created.push(input);
        },
        ...props,
      }),
    );
  });
  return { container, created };
}

const radio = (container: HTMLElement, label: string): HTMLInputElement => {
  const entry = [...container.querySelectorAll<HTMLLabelElement>(".isolation-options label")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  return entry!.querySelector<HTMLInputElement>("input")!;
};

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("NewSessionDialog worktree option", () => {
  it("offers a separate copy to a terminal agent in a repository, starting in the folder as it is", async () => {
    const { container, created } = await open({});
    expect(container.querySelector<HTMLInputElement>('input[name="session-agent"]:checked')?.value).toBe("claude");
    expect(radio(container, "지금 폴더에서 바로 작업").checked).toBe(true);
    expect(radio(container, "별도 복사본에서 작업").checked).toBe(false);
    await submit(container);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "terminal", agentKind: "claude", workspace: "/work/project" });
    expect(created[0]).not.toHaveProperty("isolation");
  });

  it("starts a terminal agent in a new worktree on the branch the user typed", async () => {
    const { container, created } = await open({});
    await act(async () => radio(container, "별도 복사본에서 작업").click());
    await type(container.querySelector<HTMLInputElement>('input[placeholder="브랜치 이름 (선택)"]')!, "  feat/own  ");
    await submit(container);
    expect(created[0]).toMatchObject({ kind: "terminal", agentKind: "claude", isolation: "worktree", worktreeBranch: "feat/own" });
  });

  it("leaves the branch to the host when none is typed", async () => {
    const { container, created } = await open({});
    await act(async () => radio(container, "별도 복사본에서 작업").click());
    await submit(container);
    expect(created[0]).toMatchObject({ isolation: "worktree" });
    expect(created[0]).not.toHaveProperty("worktreeBranch");
  });

  it("opens on a worktree when the project starts new sessions in one", async () => {
    const { container, created } = await open({ newSessionWorktreeRoot: "/work/project" });
    expect(radio(container, "별도 복사본에서 작업").checked).toBe(true);
    await submit(container);
    expect(created[0]).toMatchObject({ kind: "terminal", agentKind: "claude", isolation: "worktree" });
  });

  it("lets the user take the folder as it is against the project's default", async () => {
    const { container, created } = await open({ newSessionWorktreeRoot: "/work/project" });
    await act(async () => radio(container, "지금 폴더에서 바로 작업").click());
    expect(radio(container, "지금 폴더에서 바로 작업").checked).toBe(true);
    await submit(container);
    expect(created[0]).not.toHaveProperty("isolation");
  });

  it("starts a GJC session in a worktree the same way", async () => {
    const { container, created } = await open({ newSessionWorktreeRoot: "/work/project" });
    await act(async () => container.querySelector<HTMLInputElement>('input[name="session-agent"][value="gjc"]')!.click());
    expect(radio(container, "별도 복사본에서 작업").checked).toBe(true);
    await submit(container);
    expect(created[0]).toMatchObject({ isolation: "worktree" });
    expect(created[0]).not.toHaveProperty("kind");
  });

  it("offers no copy outside a repository", async () => {
    const { container } = await open({ git: false });
    expect(container.querySelector(".isolation-options")).toBeNull();
  });

  it("takes a handed-over worktree for any agent, but only GJC for a request with a prompt or a branch that must exist", async () => {
    const plain = await open({}, { prefill: { workspace: "/work/project", isolation: "worktree", worktreeBranch: "feat/handed" } });
    expect(plain.container.querySelector(".agent-options")).not.toBeNull();
    expect(radio(plain.container, "별도 복사본에서 작업").checked).toBe(true);
    await submit(plain.container);
    expect(plain.created[0]).toMatchObject({ kind: "terminal", agentKind: "claude", isolation: "worktree", worktreeBranch: "feat/handed" });
    act(() => root?.unmount());

    const withPrompt = await open({}, { prefill: { workspace: "/work/project", isolation: "worktree", worktreeBranch: "issue-1", prompt: "고쳐 줘" } });
    expect(withPrompt.container.querySelector(".agent-options")).toBeNull();
    act(() => root?.unmount());

    const mustExist = await open(
      {},
      { prefill: { workspace: "/work/project", isolation: "worktree", worktreeBranch: "feat/x", worktreeBranchExisting: true } },
    );
    expect(mustExist.container.querySelector(".agent-options")).toBeNull();
  });
});
