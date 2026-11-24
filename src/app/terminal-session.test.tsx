/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../backend/types";
import { initialAgent } from "./agent-choice";
import { NewSessionDialog, type NewSessionInput } from "./dialogs";
import type { AgentAvailability } from "../../shared/terminal-ipc";

const AGENT = (id: AgentAvailability["id"]): AgentAvailability => ({ id, name: id, installed: true, ...(id === "shell" ? {} : { binary: `/bin/${id}` }) });
import { Sidebar } from "./sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

const noop = () => undefined;

function row(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    subtitle: "repo",
    workspace: "/repo",
    runtime: "gjc",
    status: "idle",
    updatedAt: "now",
    pinned: false,
    unread: false,
    accent: "#ff8a34",
    ownership: "gajae",
    attachment: "attached",
    ...overrides,
  };
}

describe("new session dialog", () => {
  const submit = (node: HTMLElement) =>
    act(async () =>
      node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );

  it("asks only for the name, isolation, and folder of a GJC session", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    Object.assign(window, {
      agentControlDesktop: {
        settings: { inspectWorkspace: async () => ({ broad: false, git: true }) },
      },
    });
    const node = await mount(
      createElement(NewSessionDialog, { defaultWorkspace: "/repo", onCancel: noop, onCreate }),
    );
    Reflect.deleteProperty(window, "agentControlDesktop");
    expect(node.querySelector("h2")?.textContent).toBe("새 세션");
    expect(node.querySelector("fieldset.isolation-options")).not.toBeNull();
    expect(node.querySelector("textarea")).toBeNull();
    expect(node.querySelector("fieldset.parallel-options")).toBeNull();
    expect(node.querySelector('input[name="session-kind"]')).toBeNull();

    await submit(node);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "새 세션",
      workspace: "/repo",
      isolation: "workspace",
      worktreeBranch: undefined,
      initialPrompt: undefined,
      initialImages: undefined,
    });
  });

  it("starts on the agent last chosen while it is installed, a terminal session named after its folder", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => Promise<void>>().mockResolvedValue();
    Object.assign(window, {
      agentControlDesktop: {
        terminal: { listAgents: async () => [AGENT("claude"), AGENT("shell")] },
      },
    });
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/work/repo",
        terminalSessions: true,
        choice: { agentKind: "shell", surface: "terminal" },
        onCancel: noop,
        onCreate,
      }),
    );
    await act(async () => undefined);
    Reflect.deleteProperty(window, "agentControlDesktop");
    expect(node.querySelector<HTMLInputElement>('input[name="session-agent"]:checked')?.value).toBe("shell");
    expect(node.querySelector("fieldset.isolation-options")).toBeNull();

    await submit(node);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "repo",
      workspace: "/work/repo",
      kind: "terminal",
      surface: "terminal",
      remember: true,
    });
  });

  it("keeps a handed-over request on a GJC session whatever was chosen before", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/repo",
        terminalSessions: true,
        choice: { agentKind: "claude", surface: "terminal" },
        prefill: { prompt: "  CI를 고쳐 줘 " },
        onCancel: noop,
        onCreate,
      }),
    );
    expect(node.querySelector("h2")?.textContent).toBe("새 세션");

    await submit(node);
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ initialPrompt: "CI를 고쳐 줘" });
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("kind");
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("remember");
  });
});

const SIDEBAR_PROPS = {
  connection: { state: "connected", backend: "gjc", label: "GJC", detail: "", workspace: "/repo" },
  selectedId: null,
  grouping: "status",
  onGroupingChange: () => undefined,
  collapsedProjects: new Set<string>(),
  onToggleProject: () => undefined,
  projects: [],
  projectId: "__all__",
  onProjectChange: noop,
  onOpenRepository: noop,
  onOpenProjects: noop,
  inboxCount: 0,
  inboxOpen: false,
  onToggleInbox: noop,
  onOpenProjectGithub: noop,
  onOpenProjectFolder: noop,
  searchQuery: "",
  onSearchChange: noop,
  onSearchOpen: noop,
  onSelect: noop,
  onCreate: noop,
  onFork: noop,
  onResume: noop,
  onResumePicker: noop,
  onRename: noop,
  onDelete: noop,
  onHide: noop,
  onSettings: noop,
  workspaceLabel: "",
  onWorkspaceLabelChange: noop,
  updateStatus: null,
  updateBusy: false,
  onUpdate: noop,
  parallelGroups: [],
  openParallelGroupId: null,
  onOpenParallelGroup: noop,
} as unknown as Parameters<typeof Sidebar>[0];

describe("terminal agents in the new session dialog", () => {
  const submit = (node: HTMLElement) =>
    act(async () =>
      node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  const select = (node: HTMLElement, value: string) =>
    act(async () => {
      const field = node.querySelector<HTMLSelectElement>('select[aria-label="권한 모드"]')!;
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("starts on the first installed of Claude Code, omp, codex and GJC, with its screen and permission mode", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => Promise<void>>().mockResolvedValue();
    Object.assign(window, {
      agentControlDesktop: {
        terminal: {
          listAgents: async () => [
            AGENT("claude"),
            { id: "omp", name: "Oh My Pi", installed: false, reason: "설치되어 있지 않습니다" },
            AGENT("gjc"),
            AGENT("shell"),
          ],
        },
      },
    });
    const node = await mount(createElement(NewSessionDialog, { defaultWorkspace: "/work/repo", terminalSessions: true, onCancel: noop, onCreate }));
    await act(async () => undefined);
    const options = [...node.querySelectorAll<HTMLInputElement>('input[name="session-agent"]')];
    expect(options.map((option) => option.value)).toEqual(["claude", "omp", "gjc", "shell"]);
    expect(options.find((option) => option.value === "omp")!.disabled).toBe(true);
    expect(node.querySelector<HTMLInputElement>('input[name="session-agent"]:checked')?.value).toBe("claude");
    expect(node.textContent).toContain("설치되어 있지 않습니다");
    // Claude Code has both screens; the terminal comes first, as its catalog entry says
    const chat = [...node.querySelectorAll<HTMLButtonElement>(".session-kind-switch button")].find((button) => button.textContent === "채팅")!;
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="권한 모드"]')!.value).toBe("");
    await act(async () => chat.click());
    await select(node, "plan");
    await submit(node);
    Reflect.deleteProperty(window, "agentControlDesktop");
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      title: "repo",
      workspace: "/work/repo",
      kind: "terminal",
      agentKind: "claude",
      surface: "chat",
      launch: { permissionMode: "plan" },
      remember: true,
    });
  });

  it("starts from the agent's defaults in the settings, and following the agent leaves its permission mode out", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => Promise<void>>().mockResolvedValue();
    Object.assign(window, { agentControlDesktop: { terminal: { listAgents: async () => [AGENT("claude"), AGENT("shell")] } } });
    const node = await mount(
      createElement(NewSessionDialog, {
        defaultWorkspace: "/work/repo",
        terminalSessions: true,
        choice: { agentKind: "claude", surface: "terminal" },
        agentDefaults: { claude: { launch: { model: "haiku", permissionMode: "default" } } },
        onCancel: noop,
        onCreate,
      }),
    );
    await act(async () => undefined);
    expect(node.querySelector<HTMLSelectElement>('select[aria-label="권한 모드"]')!.value).toBe("default");
    await select(node, "");
    await submit(node);
    Reflect.deleteProperty(window, "agentControlDesktop");
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ agentKind: "claude", surface: "terminal", launch: { model: "haiku" } });
    expect(onCreate.mock.calls[0]![0].launch).not.toHaveProperty("permissionMode");
  });

  it("offers only GJC when the backend runs no terminal sessions, as on a phone", async () => {
    const onCreate = vi.fn<(input: NewSessionInput) => void>();
    Object.assign(window, { agentControlDesktop: { terminal: { listAgents: async () => [AGENT("claude")] } } });
    const node = await mount(
      createElement(NewSessionDialog, { defaultWorkspace: "/repo", choice: { agentKind: "claude", surface: "terminal" }, onCancel: noop, onCreate }),
    );
    await act(async () => undefined);
    Reflect.deleteProperty(window, "agentControlDesktop");
    expect(node.querySelector('input[name="session-agent"]')).toBeNull();
    await submit(node);
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("kind");
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty("remember");
  });

  it("chooses the first installed agent, and GJC or a shell when no other is there", () => {
    expect(initialAgent([AGENT("gjc"), AGENT("omp"), AGENT("shell")], undefined)).toBe("omp");
    expect(initialAgent([AGENT("gjc"), AGENT("shell")], { agentKind: "claude", surface: "chat" })).toBe("gjc");
    expect(initialAgent([AGENT("shell")], undefined)).toBe("shell");
    expect(initialAgent([AGENT("claude"), AGENT("codex")], { agentKind: "codex", surface: "terminal" })).toBe("codex");
  });
});

describe("sidebar footer without GJC", () => {
  it("names the agent new sessions open instead of a GJC connection that is not coming", async () => {
    const connecting = { state: "connecting" as const, backend: "gjc" as const, label: "GJC", detail: "gjc를 찾지 못했습니다", workspace: "/repo" };
    const node = await mount(createElement(Sidebar, { ...SIDEBAR_PROPS, sessions: [], connection: connecting, gjcUnused: { defaultAgent: "Claude Code" } }));
    const footer = node.querySelector(".profile-row")!;
    expect(footer.textContent).toContain("새 세션: Claude Code");
    expect(footer.textContent).not.toContain("GJC · 연결 중");
    expect(footer.querySelector(".connection-dot")).toBeNull();
    const automatic = await mount(createElement(Sidebar, { ...SIDEBAR_PROPS, sessions: [], connection: connecting, gjcUnused: {} }));
    expect(automatic.querySelector(".profile-row")!.textContent).toContain("새 세션: 설치된 첫 에이전트");
    const used = await mount(createElement(Sidebar, { ...SIDEBAR_PROPS, sessions: [], connection: connecting }));
    expect(used.querySelector(".profile-row")!.textContent).toContain("GJC · 연결 중");
  });
});

describe("terminal session row", () => {
  it("shows an agent session's status instead of the terminal mark", async () => {
    const node = await mount(
      createElement(Sidebar, {
        ...SIDEBAR_PROPS,
        sessions: [row("terminal-2", { runtime: "herdr", agentKind: "claude", status: "waiting", title: "Claude" })],
      }),
    );
    const sessionRow = node.querySelector<HTMLElement>(".session-row")!;
    expect(sessionRow.querySelector(".session-state-dot--waiting")).not.toBeNull();
    expect(sessionRow.querySelector('[aria-label="터미널 세션"]')).toBeNull();
  });

  it("marks the row as a terminal and leaves only rename and delete in its menu", async () => {
    const node = await mount(
      createElement(Sidebar, {
        sessions: [row("terminal-1", { runtime: "herdr", agentKind: "shell", title: "셸" })],
        connection: { state: "connected", backend: "gjc", label: "GJC", detail: "", workspace: "/repo" },
        selectedId: null,
        grouping: "status",
        onGroupingChange: () => undefined,
        collapsedProjects: new Set<string>(),
        onToggleProject: () => undefined,
        projects: [],
        projectId: "__all__",
        onProjectChange: noop,
        onOpenRepository: noop,
        onOpenProjects: noop,
        inboxCount: 0,
        inboxOpen: false,
        onToggleInbox: noop,
        onOpenProjectGithub: noop,
        onOpenProjectFolder: noop,
        searchQuery: "",
        onSearchChange: noop,
        onSearchOpen: noop,
        onSelect: noop,
        onCreate: noop,
        onFork: noop,
        onResume: noop,
        onResumePicker: noop,
        onRename: noop,
        onDelete: noop,
        onHide: noop,
        onSettings: noop,
        workspaceLabel: "",
        onWorkspaceLabelChange: noop,
        updateStatus: null,
        updateBusy: false,
        onUpdate: noop,
        parallelGroups: [],
        openParallelGroupId: null,
        onOpenParallelGroup: noop,
      }),
    );
    const sessionRow = node.querySelector<HTMLElement>(".session-row")!;
    expect(sessionRow.querySelector('[aria-label="터미널 세션"]')).not.toBeNull();
    expect(sessionRow.querySelector(".session-state-dot")).toBeNull();

    await act(async () =>
      sessionRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })),
    );
    const items = [...node.querySelectorAll<HTMLButtonElement>(".session-context-menu button")].map(
      (button) => button.textContent?.trim() ?? "",
    );
    expect(items).toEqual(["이름 변경", "삭제"]);
  });
});
