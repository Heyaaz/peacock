/**
 * Desktop terminal bridge.
 *
 * The renderer never chooses the program. Main spawns the user's login shell
 * and this channel set only carries bytes, size, and flow control.
 */

import type { AgentKindId, AgentSession } from "./agent-contract.js";
import type { AgentLaunchOptions } from "./agent-launch.js";

export const TERMINAL_IPC = {
  start: "agent-control:terminal:start",
  input: "agent-control:terminal:input",
  resize: "agent-control:terminal:resize",
  pause: "agent-control:terminal:pause",
  dispose: "agent-control:terminal:dispose",
  output: "agent-control:terminal:output",
  exit: "agent-control:terminal:exit",
  listSessions: "agent-control:terminal:list-sessions",
  createSession: "agent-control:terminal:create-session",
  renameSession: "agent-control:terminal:rename-session",
  confirmSessionRemoval: "agent-control:terminal:confirm-session-removal",
  deleteSession: "agent-control:terminal:delete-session",
  killBackground: "agent-control:terminal:kill-background",
  listAgents: "agent-control:terminal:list-agents",
} as const;

/** Terminal session ids carry this prefix, so a session row says which runtime owns it. */
export const TERMINAL_SESSION_PREFIX = "terminal-";

export function isTerminalSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TERMINAL_SESSION_PREFIX);
}

/**
 * A terminal session as the app stores it. GJC's broker never sees these. The
 * shell behind one runs in herdr-core and outlives the app; when herdr-core is
 * not available it runs in the app instead and lives only while its window does.
 */
export interface TerminalSessionRecord {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  /** The agent the session runs. Every terminal session so far is a shell. */
  agentKind?: AgentKindId;
  /** The herdr-core whose terminal this is: an address means something only on its own core. */
  coreId?: string;
  /** The session's terminal on that core (`t7`), while it has one. */
  terminalAddress?: string;
  /** What the agent was started with (model, effort, permission mode). */
  launch?: AgentLaunchOptions;
  /** The agent's own session id (Claude Code's `session_id`), which a new terminal resumes. */
  agentSessionRef?: string;
  /** Where the agent writes that session's transcript, as it last reported. */
  transcriptPath?: string;
}

/** Whether an agent can be started here, and where it was found. */
export interface AgentAvailability {
  id: AgentKindId;
  name: string;
  installed: boolean;
  /** The executable, as an absolute path. */
  binary?: string;
  version?: string;
  /** Why it cannot be started, for a disabled choice. */
  reason?: string;
}

export interface TerminalSessionCreateInput {
  title: string;
  workspace: string;
  /** The agent the terminal runs; a shell when unset. */
  agentKind?: AgentKindId;
  launch?: AgentLaunchOptions;
}

export interface TerminalStartRequest {
  /** Working directory. Main ignores anything that is not an existing directory. */
  cwd?: string;
  /**
   * A terminal session to attach to. Its shell outlives the view: starting again
   * replays what it printed instead of opening a new one. Main takes the folder
   * from the stored session, not from `cwd`.
   */
  session?: string;
  /** Replaces the session's shell, even a running one, with a fresh one. */
  restart?: boolean;
  cols?: number;
  rows?: number;
  /**
   * Pairs this start with the dispose that ends its view. A dispose for the same
   * token wins even when it is processed first. A session's shell sends output
   * only while a view that started it is still there.
   */
  token: number;
}

export interface TerminalSessionInfo {
  id: string;
  /** Directory the shell actually started in. Missing paths fall back to home. */
  cwd: string;
  /** Output so far, for a view attaching to a session shell that was already running. */
  replay?: string;
  /** Set when the session's shell has already exited. */
  exitCode?: number;
  /** Where the shell runs: in herdr-core (kept when the app quits), or in the app (`pty`). */
  backend?: "hc" | "pty";
  /** Why the shell runs in the app although it should have run in herdr-core. */
  notice?: string;
}

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
  /**
   * The view lost its connection to the terminal, which may still be running: starting the
   * session again attaches to it. Nothing exited, so `exitCode` means nothing here.
   */
  disconnected?: boolean;
}

export interface TerminalDesktopBridge {
  start(request: TerminalStartRequest): Promise<TerminalSessionInfo>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  setPaused(id: string, paused: boolean): void;
  dispose(token: number): Promise<void>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: TerminalSessionCreateInput): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Asks the user, in the host's own dialog, before the session and its shell go away. */
  confirmSessionRemoval(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
  /** Ends every terminal session's shell that keeps running in herdr-core; resolves how many. */
  killBackground(): Promise<number>;
  /** The terminal agents and whether each can be started here. */
  listAgents(): Promise<AgentAvailability[]>;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
}
