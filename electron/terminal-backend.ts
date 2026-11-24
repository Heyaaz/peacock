import type { TerminalSessionRecord } from "../shared/terminal-ipc.js";
import type { TerminalControlFrame } from "./terminal-session.js";

/** How a view's shell ended, or that the view lost it while it may still run. */
export interface TerminalEnd {
  exitCode: number;
  signal?: number;
  /** The connection to the terminal went away; the program itself may still be running. */
  disconnected?: boolean;
}

/**
 * One view's hold on a shell. A herdr-core terminal outlives every hold, so letting go
 * (`detach`) and ending it (`kill`) are different things; an in-app pty ends either way.
 */
export interface TerminalHandle {
  handle(frame: TerminalControlFrame): void;
  /** The view's window closed or the app quits: a herdr-core shell keeps running. */
  detach(): void;
  /** The session is deleted or restarted: the shell ends. */
  kill(): void;
}

export interface SessionTerminalRequest {
  record: TerminalSessionRecord;
  cols?: number;
  rows?: number;
  /** End the session's running shell and start a fresh one. */
  restart: boolean;
  onData(data: string): void;
  onExit(end: TerminalEnd): void;
}

/** Where terminal sessions' shells live when they outlive the app. */
export interface SessionTerminalProvider {
  /** Attaches to the session's shell, starting one when it has none (or a finished one). */
  open(request: SessionTerminalRequest): Promise<TerminalHandle>;
  /** Ends the session's shell, whether or not any view holds it. */
  kill(record: TerminalSessionRecord): Promise<void>;
  /** Ends every session shell this provider keeps; resolves how many it ended. */
  killAll(): Promise<number>;
}
