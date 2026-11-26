import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import type { AgentSession, SessionRemovalResult } from "../shared/agent-contract.js";
import type { SessionWorktreeRemoval } from "./session-worktree-removal.js";
import type { IpcSecurity } from "./ipc-security.js";
import { validDirectory } from "./settings-store.js";
import { resolveShellCwd } from "./terminal-shell.js";
import {
  openLoginShell,
  type LoginShellOptions,
  type LoginShellSession,
} from "./terminal-session.js";
import type { SessionTerminalProvider, TerminalEnd, TerminalHandle } from "./terminal-backend.js";
import { terminalAgentSession } from "./terminal-session-row.js";
export { terminalAgentSession } from "./terminal-session-row.js";
import { hostText } from "./host-text.js";
import { ReplayBuffer, createOutputBatcher, type OutputBatcher } from "./terminal-output.js";
import type { TerminalSessionStore } from "./terminal-session-store.js";
import { isAgentKindId } from "../shared/agent-contract.js";
import { launchOptions } from "../shared/agent-launch.js";
import { terminalIsolation } from "./gjc-input-validation.js";
import {
  TERMINAL_IPC,
  isTerminalSessionId,
  type AgentAvailability,
  type TerminalSessionCreateInput,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
  type TerminalSessionRecord,
  type TerminalStartRequest,
} from "../shared/terminal-ipc.js";

interface TerminalSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** The chat surface's shell, which stays an in-app pty and lives only while its view does. */
const SURFACE_KEY = "";
/** What a terminal session replays to a view that attaches to it again. */
export const TERMINAL_REPLAY_LIMIT = 512 * 1024;
/** How long a delete waits for a closed session's program to finish exiting. */
const CLOSE_TIMEOUT_MS = 5_000;

interface LiveTerminal {
  id: string;
  /** {@link SURFACE_KEY}, or the terminal session this shell belongs to. */
  key: string;
  token: number;
  cwd: string;
  handle: TerminalHandle;
  /** Where the shell runs: herdr-core keeps it when the app quits, the app's own pty does not. */
  backend: "pty" | "hc";
  /** Why a session's shell runs in the app instead of herdr-core. */
  notice?: string;
  replay: ReplayBuffer;
  outgoing: OutputBatcher;
  /** The views showing this shell, by start token. With none, output only goes to the replay. */
  views: Set<number>;
  exitCode?: number;
  exited: Promise<void>;
}

/** An in-app shell, which ends whichever way a view lets go of it. */
function ptyHandle(session: LoginShellSession): TerminalHandle {
  return {
    handle: (frame) => session.handle(frame),
    detach: () => session.dispose(),
    kill: () => session.dispose(),
  };
}

function fallbackNotice(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${hostText("herdr-core를 쓸 수 없어 앱 안에서 셸을 열었습니다. 앱을 닫으면 이 셸은 종료됩니다.")} (${reason})`;
}

/**
 * Shells per renderer. The chat surface keeps one in-app shell that dies with its view.
 * Each terminal session's shell runs in herdr-core when a provider is given: it outlives the
 * view, the window and the app, and every window attaches to the same one. Without herdr-core
 * a session falls back to an in-app shell per window, which outlives only its view.
 *
 * Letting go and ending are different: a window closing or the app quitting detaches (an
 * herdr-core shell keeps running), deleting or restarting a session kills.
 */
export class TerminalHost {
  private readonly windows = new Map<number, Map<string, LiveTerminal>>();
  private readonly cancelled = new Map<number, Set<number>>();
  /** Session starts waiting on herdr-core, by window and session, so two views share one. */
  private readonly pending = new Map<string, Promise<LiveTerminal>>();

  constructor(
    private readonly openShell: (options: LoginShellOptions) => LoginShellSession = openLoginShell,
    private readonly lookup: (sessionId: string) => TerminalSessionRecord | undefined = () =>
      undefined,
    private readonly provider?: SessionTerminalProvider,
    private readonly log: (message: string, error?: unknown) => void = (message, error) =>
      console.error(message, error),
  ) {}

  start(
    sender: TerminalSender,
    request: TerminalStartRequest,
  ): TerminalSessionInfo | Promise<TerminalSessionInfo> {
    const key = request.session ?? SURFACE_KEY;
    const token = request.token;
    if (this.takeCancel(sender.id, token)) throw new Error("Terminal start was cancelled");
    const stored = key === SURFACE_KEY ? undefined : this.lookup(key);
    if (key !== SURFACE_KEY && !stored) throw new Error("Terminal session not found");
    const current = this.windows.get(sender.id)?.get(key);
    if (current && key !== SURFACE_KEY && !request.restart) return this.rejoin(current, request);
    if (process.env.GAJAE_DEBUG_HERDR)
      console.log(`[terminal start] ${key} token=${token} restart=${request.restart === true} current=${current ? "yes" : "no"}`);
    if (stored && this.provider) return this.startProvided(sender, request, stored);
    this.kill(sender.id, key);
    const cwd = resolveShellCwd(stored?.workspace ?? request.cwd);
    const { terminal, onData, onExit } = this.createLive(sender, key, token, cwd);
    const session = this.openShell({
      cwd,
      cols: request.cols,
      rows: request.rows,
      onData,
      onExit: (status) => onExit({ exitCode: status.exitCode, signal: status.signal }),
    });
    if (this.takeCancel(sender.id, token)) {
      session.dispose();
      throw new Error("Terminal start was cancelled");
    }
    terminal.handle = ptyHandle(session);
    this.register(sender.id, key, terminal);
    return { id: terminal.id, cwd };
  }

  write(senderId: number, id: unknown, data: unknown): void {
    if (typeof data !== "string") return;
    this.find(senderId, id)?.handle.handle({ t: "i", d: data });
  }

  resize(senderId: number, id: unknown, cols: unknown, rows: unknown): void {
    this.find(senderId, id)?.handle.handle({ t: "r", c: cols, r: rows });
  }

  setPaused(senderId: number, id: unknown, paused: unknown): void {
    if (typeof paused !== "boolean") return;
    this.find(senderId, id)?.handle.handle({ t: "p", paused });
  }

  /**
   * A view went away. A terminal session's shell outlives it and stops sending
   * output once no view is left; the chat surface's shell ends with its view.
   */
  dispose(senderId: number, token?: number): void {
    if (typeof token === "number" && this.leaveSession(senderId, token)) return;
    if (typeof token === "number") this.cancel(senderId, token);
    const current = this.windows.get(senderId)?.get(SURFACE_KEY);
    if (token !== undefined && current && current.token !== token) return;
    this.kill(senderId, SURFACE_KEY);
  }

  /** The window closed: herdr-core shells keep running, in-app shells end. */
  disposeWindow(senderId: number): void {
    for (const key of [...(this.windows.get(senderId)?.keys() ?? [])]) this.detach(senderId, key);
    this.windows.delete(senderId);
    this.cancelled.delete(senderId);
  }

  /**
   * Ends a terminal session's shell everywhere: every window's view lets go, the session's
   * herdr-core terminal ends whether or not a view held it, and in-app shells are waited for.
   */
  async closeSession(sessionId: string, record?: TerminalSessionRecord): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [senderId, terminals] of this.windows) {
      const terminal = terminals.get(sessionId);
      if (!terminal) continue;
      if (terminal.backend === "hc") {
        this.detach(senderId, sessionId);
        continue;
      }
      this.kill(senderId, sessionId);
      if (terminal.exitCode === undefined)
        closing.push(
          Promise.race([
            terminal.exited,
            new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref?.()),
          ]),
        );
    }
    if (this.provider && record)
      closing.push(
        this.provider.kill(record).catch((error: unknown) =>
          this.log(`Could not end the herdr-core terminal of ${sessionId}`, error),
        ),
      );
    await Promise.all(closing);
  }

  /** Ends every session shell that keeps running in herdr-core; resolves how many. */
  async killBackground(): Promise<number> {
    if (!this.provider) return 0;
    return this.provider.killAll();
  }

  /** The app quits: every view lets go, and herdr-core shells keep running for the next launch. */
  disposeAll(): void {
    for (const senderId of [...this.windows.keys()]) this.disposeWindow(senderId);
    this.cancelled.clear();
  }

  private startProvided(
    sender: TerminalSender,
    request: TerminalStartRequest,
    stored: TerminalSessionRecord,
  ): Promise<TerminalSessionInfo> {
    const key = stored.id;
    const pendingKey = `${sender.id}\0${key}`;
    const inFlight = this.pending.get(pendingKey);
    if (inFlight && !request.restart) return inFlight.then((terminal) => this.rejoin(terminal, request));
    const replacing = this.windows.get(sender.id)?.has(key) === true;
    this.kill(sender.id, key);
    const opening = this.openProvided(sender, request, stored, replacing);
    this.pending.set(pendingKey, opening);
    const settle = (): void => {
      if (this.pending.get(pendingKey) === opening) this.pending.delete(pendingKey);
    };
    opening.then(settle, settle);
    return opening.then((terminal) => ({
      id: terminal.id,
      cwd: terminal.cwd,
      backend: terminal.backend,
      ...(terminal.notice ? { notice: terminal.notice } : {}),
    }));
  }

  private async openProvided(
    sender: TerminalSender,
    request: TerminalStartRequest,
    stored: TerminalSessionRecord,
    replacing: boolean,
  ): Promise<LiveTerminal> {
    const key = stored.id;
    const token = request.token;
    const cwd = resolveShellCwd(stored.workspace);
    const { terminal, onData, onExit } = this.createLive(sender, key, token, cwd);
    let handle: TerminalHandle;
    try {
      handle = await this.provider!.open({
        record: stored,
        cols: request.cols,
        rows: request.rows,
        restart: request.restart === true || replacing,
        onData,
        onExit,
      });
      terminal.backend = "hc";
    } catch (error) {
      // an agent session asked for that agent: an in-app shell instead would be a different thing
      if ((stored.agentKind ?? "shell") !== "shell") throw error;
      this.log(`herdr-core could not open terminal session ${key}; using an in-app shell`, error);
      terminal.notice = fallbackNotice(error);
      handle = ptyHandle(
        this.openShell({
          cwd,
          cols: request.cols,
          rows: request.rows,
          onData,
          onExit: (status) => onExit({ exitCode: status.exitCode, signal: status.signal }),
        }),
      );
    }
    if (this.takeCancel(sender.id, token) || sender.isDestroyed()) {
      handle.detach();
      throw new Error("Terminal start was cancelled");
    }
    terminal.handle = handle;
    this.register(sender.id, key, terminal);
    return terminal;
  }

  /** A live shell and the callbacks its backend reports to, before it is registered. */
  private createLive(
    sender: TerminalSender,
    key: string,
    token: number,
    cwd: string,
  ): { terminal: LiveTerminal; onData: (data: string) => void; onExit: (end: TerminalEnd) => void } {
    const id = randomUUID();
    let markExited = (): void => undefined;
    const isCurrent = (): boolean => this.windows.get(sender.id)?.get(key) === terminal;
    const terminal: LiveTerminal = {
      id,
      key,
      token,
      cwd,
      handle: undefined as unknown as TerminalHandle,
      backend: "pty",
      replay: new ReplayBuffer(TERMINAL_REPLAY_LIMIT),
      outgoing: createOutputBatcher((data) => {
        if (!isCurrent() || sender.isDestroyed()) return;
        const payload: TerminalOutputEvent = { id, data };
        sender.send(TERMINAL_IPC.output, payload);
      }),
      views: new Set([token]),
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    const onData = (data: string): void => {
      if (!isCurrent()) return;
      if (key !== SURFACE_KEY) terminal.replay.push(data);
      if (terminal.views.size > 0) terminal.outgoing.push(data);
    };
    const onExit = (end: TerminalEnd): void => {
      markExited();
      if (!isCurrent()) return;
      terminal.outgoing.flush();
      // a lost connection leaves the shell running: the next start attaches again
      if (key === SURFACE_KEY || end.disconnected) this.windows.get(sender.id)?.delete(key);
      else terminal.exitCode = end.exitCode;
      if (sender.isDestroyed()) return;
      const payload: TerminalExitEvent = {
        id,
        exitCode: end.exitCode,
        signal: end.signal,
        ...(end.disconnected ? { disconnected: true } : {}),
      };
      sender.send(TERMINAL_IPC.exit, payload);
    };
    return { terminal, onData, onExit };
  }

  private register(senderId: number, key: string, terminal: LiveTerminal): void {
    let terminals = this.windows.get(senderId);
    if (!terminals) {
      terminals = new Map();
      this.windows.set(senderId, terminals);
    }
    terminals.set(key, terminal);
  }

  private rejoin(current: LiveTerminal, request: TerminalStartRequest): TerminalSessionInfo {
    current.handle.handle({ t: "r", c: request.cols, r: request.rows });
    // The replay covers anything still waiting, and this view is not listening yet.
    current.outgoing.flush();
    current.views.add(request.token);
    return {
      id: current.id,
      cwd: current.cwd,
      replay: current.replay.read(),
      ...(current.exitCode === undefined ? {} : { exitCode: current.exitCode }),
      ...(this.provider ? { backend: current.backend } : {}),
      ...(current.notice ? { notice: current.notice } : {}),
    };
  }

  private leaveSession(senderId: number, token: number): boolean {
    for (const terminal of this.windows.get(senderId)?.values() ?? []) {
      if (terminal.key === SURFACE_KEY || !terminal.views.delete(token)) continue;
      if (terminal.views.size === 0) terminal.outgoing.discard();
      return true;
    }
    return false;
  }

  private find(senderId: number, id: unknown): LiveTerminal | undefined {
    if (typeof id !== "string") return undefined;
    for (const terminal of this.windows.get(senderId)?.values() ?? [])
      if (terminal.id === id) return terminal;
    return undefined;
  }

  private cancel(senderId: number, token: number): void {
    let tokens = this.cancelled.get(senderId);
    if (!tokens) {
      tokens = new Set();
      this.cancelled.set(senderId, tokens);
    }
    tokens.add(token);
    if (tokens.size > 32) {
      const oldest = tokens.values().next().value;
      if (oldest !== undefined) tokens.delete(oldest);
    }
  }

  private takeCancel(senderId: number, token: number): boolean {
    const tokens = this.cancelled.get(senderId);
    if (!tokens?.has(token)) return false;
    tokens.delete(token);
    return true;
  }

  private kill(senderId: number, key: string): void {
    const terminals = this.windows.get(senderId);
    const current = terminals?.get(key);
    terminals?.delete(key);
    current?.outgoing.discard();
    current?.handle.kill();
  }

  private detach(senderId: number, key: string): void {
    const terminals = this.windows.get(senderId);
    const current = terminals?.get(key);
    terminals?.delete(key);
    current?.outgoing.discard();
    current?.handle.detach();
  }
}

export function terminalStartRequest(value: unknown): TerminalStartRequest {
  const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const token = request.token;
  if (typeof token !== "number" || !Number.isSafeInteger(token) || token <= 0) {
    throw new Error("Terminal token is required");
  }
  const session = request.session;
  if (session !== undefined && (typeof session !== "string" || !isTerminalSessionId(session)))
    throw new Error("Terminal session ID is invalid");
  return {
    token,
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    cols: typeof request.cols === "number" ? request.cols : undefined,
    rows: typeof request.rows === "number" ? request.rows : undefined,
    ...(session === undefined ? {} : { session }),
    ...(request.restart === true ? { restart: true } : {}),
  };
}

function terminalSessionId(value: unknown): string {
  if (typeof value !== "string" || !isTerminalSessionId(value))
    throw new Error("Terminal session ID is invalid");
  return value;
}

function removalConfirmation(record: TerminalSessionRecord | undefined) {
  return {
    message: "터미널 세션을 삭제할까요?",
    detail: [record?.title, "이 세션에서 실행 중인 셸과 프로그램을 종료합니다."]
      .filter(Boolean)
      .join("\n\n"),
    confirmLabel: "삭제",
    danger: true,
  };
}

const KILL_BACKGROUND_CONFIRMATION = {
  message: "백그라운드 터미널을 모두 종료할까요?",
  detail: "앱을 닫아도 계속 실행되던 터미널 세션의 셸과 그 안의 프로그램을 모두 종료합니다.",
  confirmLabel: "모두 종료",
  danger: true,
};

/** The terminal agent sessions' owner (HerdrAgentController): their rows, creation and agents. */
export interface TerminalAgents {
  listSessions(): AgentSession[];
  createTerminalSession(input: TerminalSessionCreateInput): Promise<AgentSession>;
  listAgents(): Promise<AgentAvailability[]>;
  forget(sessionId: string): void;
}

const SHELL_ONLY: AgentAvailability[] = [{ id: "shell", name: "Shell", installed: true }];

/** A create request's agent and launch options, checked; a shell when it names none. */
function terminalCreateInput(value: Record<string, unknown>): TerminalSessionCreateInput {
  if (typeof value.title !== "string") throw new Error("Session title is required");
  if (!validDirectory(value.workspace)) throw new Error("Workspace must be an existing folder");
  const agentKind = value.agentKind === undefined ? "shell" : value.agentKind;
  if (!isAgentKindId(agentKind) || agentKind === "gjc") throw new Error("Terminal agent is invalid");
  // an older client named the program here (`launch: "shell"`); the agent says that now
  const launch = launchOptions(agentKind, typeof value.launch === "string" ? undefined : value.launch);
  const isolation = terminalIsolation(value);
  return {
    title: value.title,
    workspace: value.workspace,
    agentKind,
    ...(launch ? { launch } : {}),
    ...(isolation.isolation === "worktree" ? isolation : {}),
  };
}

export function registerTerminalIpcHandlers(
  security: IpcSecurity,
  options?: {
    open?: (sessionOptions: LoginShellOptions) => LoginShellSession;
    store?: TerminalSessionStore;
    /** Where terminal sessions' shells live past the app (herdr-core); without it, in-app ptys. */
    provider?: SessionTerminalProvider;
    /** Agent sessions' owner; without it only shells can be made. */
    agents?: TerminalAgents;
    /** Asks about a session's worktree when the session is deleted; without it a delete leaves worktrees alone. */
    worktrees?: SessionWorktreeRemoval;
  },
): {
  unregister(): void;
  bindWindow(window: BrowserWindow): void;
  disposeAll(): void;
} {
  const store = options?.store;
  const worktrees = options?.worktrees;
  const host = new TerminalHost(
    options?.open,
    (sessionId) => store?.get(sessionId),
    options?.provider,
  );
  const requireStore = (): TerminalSessionStore => {
    if (!store) throw new Error("Terminal sessions are not available");
    return store;
  };

  ipcMain.handle(
    TERMINAL_IPC.start,
    security.guarded((event: IpcMainInvokeEvent, request: unknown) =>
      host.start(event.sender, terminalStartRequest(request)),
    ),
  );
  ipcMain.handle(
    TERMINAL_IPC.dispose,
    security.guarded((event: IpcMainInvokeEvent, token: unknown) => {
      host.dispose(event.sender.id, typeof token === "number" ? token : undefined);
    }),
  );
  const agents = options?.agents;
  ipcMain.handle(
    TERMINAL_IPC.listSessions,
    security.guarded(() =>
      agents ? agents.listSessions() : (store?.list() ?? []).map((record) => terminalAgentSession(record)),
    ),
  );
  ipcMain.handle(
    TERMINAL_IPC.listAgents,
    security.guarded(() => (agents ? agents.listAgents() : SHELL_ONLY)),
  );
  ipcMain.handle(
    TERMINAL_IPC.createSession,
    security.guarded((_event: IpcMainInvokeEvent, input: unknown) => {
      const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const request = terminalCreateInput(value);
      if (agents) return agents.createTerminalSession(request);
      if (request.agentKind !== "shell") throw new Error("Agent sessions need herdr-core");
      if (request.isolation === "worktree") throw new Error("A session in its own worktree needs herdr-core");
      return terminalAgentSession(requireStore().create({ title: request.title, workspace: request.workspace }));
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.renameSession,
    security.guarded((_event: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
      if (typeof title !== "string") throw new Error("Session title is required");
      requireStore().rename(terminalSessionId(sessionId), title);
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.confirmSessionRemoval,
    security.guarded((event: IpcMainInvokeEvent, sessionId: unknown) => {
      const id = terminalSessionId(sessionId);
      return security.preauthorize(
        event,
        `delete:${id}`,
        removalConfirmation(store?.get(id)),
        worktrees ? () => worktrees.remember(event, id) : undefined,
      );
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.deleteSession,
    security.guarded(async (event: IpcMainInvokeEvent, sessionId: unknown): Promise<SessionRemovalResult | void> => {
      const id = terminalSessionId(sessionId);
      const sessions = requireStore();
      const record = sessions.get(id);
      await security.authorizeDestructive(event, removalConfirmation(record), `delete:${id}`);
      // asked before the session goes: its row is what says which worktree it has
      const decision = await worktrees?.decide(event, id);
      await host.closeSession(id, record);
      sessions.delete(id);
      agents?.forget(id);
      // the terminal has ended, so nothing writes in the worktree any more
      if (decision) return { worktree: await worktrees!.run(decision) };
    }),
  );
  ipcMain.handle(
    TERMINAL_IPC.killBackground,
    security.guarded(async (event: IpcMainInvokeEvent) => {
      await security.authorizeDestructive(event, KILL_BACKGROUND_CONFIRMATION);
      return host.killBackground();
    }),
  );

  const onInput = (event: IpcMainEvent, id: unknown, data: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.write(event.sender.id, id, data);
  };
  const onResize = (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.resize(event.sender.id, id, cols, rows);
  };
  const onPause = (event: IpcMainEvent, id: unknown, paused: unknown): void => {
    if (!security.isAllowed(event as unknown as IpcMainInvokeEvent)) return;
    host.setPaused(event.sender.id, id, paused);
  };
  ipcMain.on(TERMINAL_IPC.input, onInput);
  ipcMain.on(TERMINAL_IPC.resize, onResize);
  ipcMain.on(TERMINAL_IPC.pause, onPause);

  return {
    unregister(): void {
      host.disposeAll();
      for (const channel of [
        TERMINAL_IPC.start,
        TERMINAL_IPC.dispose,
        TERMINAL_IPC.listSessions,
        TERMINAL_IPC.createSession,
        TERMINAL_IPC.renameSession,
        TERMINAL_IPC.confirmSessionRemoval,
        TERMINAL_IPC.deleteSession,
        TERMINAL_IPC.killBackground,
        TERMINAL_IPC.listAgents,
      ])
        ipcMain.removeHandler(channel);
      ipcMain.removeListener(TERMINAL_IPC.input, onInput);
      ipcMain.removeListener(TERMINAL_IPC.resize, onResize);
      ipcMain.removeListener(TERMINAL_IPC.pause, onPause);
    },
    bindWindow(window: BrowserWindow): void {
      const senderId = window.webContents.id;
      const dispose = (): void => host.disposeWindow(senderId);
      window.on("closed", dispose);
      window.webContents.once("destroyed", dispose);
    },
    disposeAll(): void {
      host.disposeAll();
    },
  };
}
