import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentSession, ManagedWorktree } from "../shared/agent-contract.js";
import { GJC_IPC } from "../shared/gjc-ipc.js";
import { TERMINAL_IPC } from "../shared/terminal-ipc.js";
import { AttachmentStore } from "./attachment-store.js";
import { registerGjcIpcHandlers } from "./gjc-ipc-handlers.js";
import type { IpcSecurity } from "./ipc-security.js";
import { SessionWorktreeRemoval } from "./session-worktree-removal.js";
import { registerTerminalIpcHandlers } from "./terminal-ipc-handlers.js";
import { terminalAgentSession } from "./terminal-session-row.js";
import { TerminalSessionStore } from "./terminal-session-store.js";
import type { SessionTerminalProvider } from "./terminal-backend.js";
import { createSessionWorktree } from "./worktree-service.js";

const handled = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handled.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handled.delete(channel);
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

const sandboxes: string[] = [];

afterEach(() => {
  handled.clear();
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository(): string {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-removal-ipc-")));
  sandboxes.push(parent);
  const repo = path.join(parent, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const exists = (repo: string, branch: string) => git(repo, "branch", "--list", branch).trim() !== "";
const event = { sender: { id: 3 } } as unknown as IpcMainInvokeEvent;
const call = (channel: string, ...args: unknown[]) => handled.get(channel)!(event, ...args);

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

/** The host's own dialogs, with the order they were asked in. */
function dialogs(answers: { worktree?: boolean } = {}) {
  const log: string[] = [];
  const confirmWorktree = vi.fn(async () => {
    log.push("worktree question");
    return answers.worktree ?? true;
  });
  const security = {
    guarded: (handler: (...args: unknown[]) => unknown) => handler,
    owner: vi.fn(),
    preauthorize: vi.fn(async (_event: unknown, _grant: string, _content: unknown, followUp?: () => Promise<void>) => {
      log.push("delete confirmation");
      await followUp?.();
      return true;
    }),
    authorizeDestructive: vi.fn(async () => {
      log.push("delete authorization");
    }),
  } as unknown as IpcSecurity;
  return { log, confirmWorktree, security };
}

describe("deleting a GJC session or omp chat that has a worktree", () => {
  async function setup(options: { runtime?: AgentSession["runtime"]; others?: (worktree: ManagedWorktree) => AgentSession[]; worktree?: boolean } = {}) {
    const repo = repository();
    const made = await createSessionWorktree({ workspace: repo });
    const worktree = made.worktree;
    const sessions: AgentSession[] = [
      row("s1", worktree.path, { worktree, ...(options.runtime ? { runtime: options.runtime } : {}) }),
      ...(options.others?.(worktree) ?? []),
    ];
    const { log, confirmWorktree, security } = dialogs({ ...(options.worktree === undefined ? {} : { worktree: options.worktree }) });
    const deleteSession = vi.fn(async () => {
      log.push(`session deleted (worktree ${existsSync(worktree.path) ? "still there" : "gone"})`);
      sessions.shift();
    });
    const hideSession = vi.fn(() => {
      sessions.shift();
    });
    const controller = {
      sessionTitle: () => "첫 세션",
      runtimeOf: () => options.runtime ?? "gjc",
      sessionHostElsewhere: async () => undefined,
      deleteSession,
      hideSession,
      listSessions: async () => sessions,
    };
    const removal = new SessionWorktreeRemoval({ listSessions: () => controller.listSessions(), confirm: confirmWorktree });
    registerGjcIpcHandlers(controller as never, new AttachmentStore(), security, removal);
    return { repo, worktree, log, confirmWorktree, deleteSession, hideSession, security };
  }

  it.each([["gjc"], ["omp-rpc"]] as const)("asks about the worktree once the delete is confirmed, then removes it after the session (%s)", async (runtime) => {
    const { repo, worktree, log, confirmWorktree, deleteSession } = await setup({ runtime });
    expect(await call(GJC_IPC.confirmSessionRemoval, "s1", "delete")).toBe(true);
    expect(confirmWorktree).toHaveBeenCalledTimes(1);
    const outcome = await call(GJC_IPC.deleteSession, "s1");
    // the question is not asked a second time, and the worktree goes only after the session
    expect(confirmWorktree).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["delete confirmation", "worktree question", "delete authorization", "session deleted (worktree still there)"]);
    expect(outcome).toEqual({ worktree: { status: "removed" } });
    expect(existsSync(worktree.path)).toBe(false);
    expect(exists(repo, worktree.branch)).toBe(false);
    expect(exists(repo, "main")).toBe(true);
  });

  it("leaves the worktree when the user chooses to keep it, and answers nothing about it", async () => {
    const { repo, worktree, confirmWorktree } = await setup({ worktree: false });
    await call(GJC_IPC.confirmSessionRemoval, "s1", "delete");
    expect(await call(GJC_IPC.deleteSession, "s1")).toBeUndefined();
    expect(confirmWorktree).toHaveBeenCalledTimes(1);
    expect(existsSync(worktree.path)).toBe(true);
    expect(exists(repo, worktree.branch)).toBe(true);
  });

  it("asks after the delete's own confirmation when the window did not ask ahead", async () => {
    const { worktree, log } = await setup();
    const outcome = await call(GJC_IPC.deleteSession, "s1");
    expect(log).toEqual(["delete authorization", "worktree question", "session deleted (worktree still there)"]);
    expect(outcome).toEqual({ worktree: { status: "removed" } });
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("does not ask when hiding, and leaves the worktree where GJC's history resumes", async () => {
    const { worktree, confirmWorktree, hideSession } = await setup();
    expect(await call(GJC_IPC.confirmSessionRemoval, "s1", "hide")).toBe(true);
    await call(GJC_IPC.hideSession, "s1");
    expect(confirmWorktree).not.toHaveBeenCalled();
    expect(hideSession).toHaveBeenCalledTimes(1);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("removes nothing when the delete fails", async () => {
    const { repo, worktree, deleteSession } = await setup();
    deleteSession.mockRejectedValueOnce(new Error("세션 삭제를 확정하지 못했습니다."));
    await call(GJC_IPC.confirmSessionRemoval, "s1", "delete");
    await expect(call(GJC_IPC.deleteSession, "s1")).rejects.toThrow("확정하지 못했습니다");
    expect(existsSync(worktree.path)).toBe(true);
    expect(exists(repo, worktree.branch)).toBe(true);
  });

  it("does not offer a worktree that a fork or another runtime's session still uses", async () => {
    const forked = await setup({ others: (worktree) => [row("fork", worktree.path, { worktree })] });
    await call(GJC_IPC.confirmSessionRemoval, "s1", "delete");
    expect(await call(GJC_IPC.deleteSession, "s1")).toBeUndefined();
    expect(forked.confirmWorktree).not.toHaveBeenCalled();
    expect(existsSync(forked.worktree.path)).toBe(true);
    handled.clear();

    const terminal = await setup({ others: (worktree) => [row("terminal-9", worktree.path, { runtime: "herdr", agentKind: "claude" })] });
    expect(await call(GJC_IPC.deleteSession, "s1")).toBeUndefined();
    expect(terminal.confirmWorktree).not.toHaveBeenCalled();
    expect(existsSync(terminal.worktree.path)).toBe(true);
  });

  it("keeps the worktree, and says so, when something changed after the user agreed", async () => {
    const { worktree, deleteSession } = await setup();
    await call(GJC_IPC.confirmSessionRemoval, "s1", "delete");
    deleteSession.mockImplementationOnce(async () => {
      // the agent's last write lands while the session is being ended
      writeFileSync(path.join(worktree.path, "last-write.txt"), "x");
    });
    expect(await call(GJC_IPC.deleteSession, "s1")).toEqual({ worktree: { status: "kept", reason: "changed" } });
    expect(existsSync(path.join(worktree.path, "last-write.txt"))).toBe(true);
  });

  it("deletes a session that has no worktree as it always did", async () => {
    const repo = repository();
    const { confirmWorktree, security } = dialogs();
    const deleteSession = vi.fn(async () => undefined);
    const controller = {
      sessionTitle: () => "t",
      runtimeOf: () => "gjc",
      sessionHostElsewhere: async () => undefined,
      deleteSession,
      listSessions: async () => [row("plain", repo)],
    };
    const removal = new SessionWorktreeRemoval({ listSessions: () => controller.listSessions(), confirm: confirmWorktree });
    registerGjcIpcHandlers(controller as never, new AttachmentStore(), security, removal);
    await call(GJC_IPC.confirmSessionRemoval, "plain", "delete");
    expect(await call(GJC_IPC.deleteSession, "plain")).toBeUndefined();
    expect(confirmWorktree).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith("plain", undefined);
  });

  it("works without the removal, leaving worktrees alone", async () => {
    const repo = repository();
    const made = await createSessionWorktree({ workspace: repo });
    const { security } = dialogs();
    const deleteSession = vi.fn(async () => undefined);
    registerGjcIpcHandlers(
      { sessionTitle: () => "t", runtimeOf: () => "gjc", sessionHostElsewhere: async () => undefined, deleteSession } as never,
      new AttachmentStore(),
      security,
    );
    expect(await call(GJC_IPC.deleteSession, "s1")).toBeUndefined();
    expect(existsSync(made.worktree.path)).toBe(true);
  });
});

describe("deleting a terminal session that has a worktree", () => {
  async function setup(options: { worktree?: boolean; withWorktree?: boolean; others?: (worktree: ManagedWorktree) => AgentSession[] } = {}) {
    const repo = repository();
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-removal-terminal-"));
    sandboxes.push(directory);
    const store = new TerminalSessionStore(directory);
    const made = options.withWorktree === false ? undefined : await createSessionWorktree({ workspace: repo });
    const record = store.create({
      title: "claude",
      workspace: made?.worktree.path ?? repo,
      agentKind: "claude",
      ...(made ? { worktree: made.worktree } : {}),
    });
    const { log, confirmWorktree, security } = dialogs({ ...(options.worktree === undefined ? {} : { worktree: options.worktree }) });
    const provider = {
      open: vi.fn(),
      kill: vi.fn(async () => {
        log.push(`terminal ended (worktree ${made && existsSync(made.worktree.path) ? "still there" : "gone"})`);
      }),
      killAll: vi.fn(),
    } as unknown as SessionTerminalProvider;
    const removal = new SessionWorktreeRemoval({
      listSessions: async () => [...store.list().map((entry) => terminalAgentSession(entry)), ...(made ? (options.others?.(made.worktree) ?? []) : [])],
      confirm: confirmWorktree,
    });
    const registration = registerTerminalIpcHandlers(security, { store, provider, worktrees: removal });
    return { repo, store, record, made, log, confirmWorktree, registration };
  }

  it("ends the terminal first, then removes the worktree and the branch this app made", async () => {
    const { repo, store, record, made, log, confirmWorktree } = await setup();
    expect(await call(TERMINAL_IPC.confirmSessionRemoval, record.id)).toBe(true);
    const outcome = await call(TERMINAL_IPC.deleteSession, record.id);
    expect(confirmWorktree).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["delete confirmation", "worktree question", "delete authorization", "terminal ended (worktree still there)"]);
    expect(outcome).toEqual({ worktree: { status: "removed" } });
    expect(store.get(record.id)).toBeUndefined();
    expect(existsSync(made!.worktree.path)).toBe(false);
    expect(exists(repo, made!.worktree.branch)).toBe(false);
    expect(exists(repo, "main")).toBe(true);
  });

  it("deletes only the session when the user keeps the worktree", async () => {
    const { repo, store, record, made } = await setup({ worktree: false });
    await call(TERMINAL_IPC.confirmSessionRemoval, record.id);
    expect(await call(TERMINAL_IPC.deleteSession, record.id)).toBeUndefined();
    expect(store.get(record.id)).toBeUndefined();
    expect(existsSync(made!.worktree.path)).toBe(true);
    expect(exists(repo, made!.worktree.branch)).toBe(true);
  });

  it("keeps the worktree of a terminal session whose fork-like sibling still works in it", async () => {
    const { store, record, made, confirmWorktree } = await setup({
      others: (worktree) => [row("omp-1", worktree.path, { runtime: "omp-rpc", agentKind: "omp", worktree })],
    });
    await call(TERMINAL_IPC.confirmSessionRemoval, record.id);
    expect(await call(TERMINAL_IPC.deleteSession, record.id)).toBeUndefined();
    expect(confirmWorktree).not.toHaveBeenCalled();
    expect(store.get(record.id)).toBeUndefined();
    expect(existsSync(made!.worktree.path)).toBe(true);
  });

  it("asks nothing of a session in the folder as it is, and never touches that folder", async () => {
    const { repo, store, record, confirmWorktree } = await setup({ withWorktree: false });
    writeFileSync(path.join(repo, "mine.txt"), "mine");
    await call(TERMINAL_IPC.confirmSessionRemoval, record.id);
    expect(await call(TERMINAL_IPC.deleteSession, record.id)).toBeUndefined();
    expect(confirmWorktree).not.toHaveBeenCalled();
    expect(store.get(record.id)).toBeUndefined();
    expect(existsSync(path.join(repo, "mine.txt"))).toBe(true);
    expect(exists(repo, "main")).toBe(true);
  });
});
