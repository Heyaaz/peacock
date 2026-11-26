import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isAgentKindId, parseManagedWorktree, type ManagedWorktree } from "../shared/agent-contract.js";
import { launchOptions, type AgentLaunchOptions } from "../shared/agent-launch.js";
import {
  TERMINAL_SESSION_PREFIX,
  type TerminalSessionCreateInput,
  type TerminalSessionRecord,
} from "../shared/terminal-ipc.js";

/** Where a session's shell runs in herdr-core. */
export interface TerminalBinding {
  coreId: string;
  terminalAddress: string;
}

const TERMINAL_ADDRESS = /^[A-Za-z0-9_./-]{1,128}$/u;
/** An agent's own session id: Claude Code's are UUIDs. */
const AGENT_SESSION_REF = /^[A-Za-z0-9_-]{1,128}$/u;

/** What an agent reported about its own session. */
export interface AgentSessionReport {
  agentSessionRef?: string;
  transcriptPath?: string;
}

const TITLE_LIMIT = 200;

/**
 * Terminal sessions the user made in this app, newest first. GJC's broker has
 * no record of them, so this file is the only list there is.
 */
export class TerminalSessionStore {
  private readonly filePath: string;
  private sessions: TerminalSessionRecord[];

  constructor(
    userDataDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(userDataDirectory, "terminal-sessions.json");
    const { sessions, migrated } = this.read();
    this.sessions = sessions;
    // Records from before herdr-core name no agent; they were all shells.
    if (migrated) this.write();
  }

  list(): TerminalSessionRecord[] {
    return this.sessions.map((session) => ({ ...session }));
  }

  get(sessionId: string): TerminalSessionRecord | undefined {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    return session ? { ...session } : undefined;
  }

  create(
    input: Omit<TerminalSessionCreateInput, "isolation" | "worktreeBranch"> & {
      launch?: AgentLaunchOptions;
      agentSessionRef?: string;
      /** The worktree the session's `workspace` is the folder of. */
      worktree?: ManagedWorktree;
    },
  ): TerminalSessionRecord {
    const agentKind = input.agentKind ?? "shell";
    const launch = launchOptions(agentKind, input.launch);
    const session: TerminalSessionRecord = {
      id: `${TERMINAL_SESSION_PREFIX}${randomUUID()}`,
      title: sessionTitle(input.title),
      workspace: path.resolve(input.workspace),
      createdAt: this.now().toISOString(),
      agentKind,
      ...(launch ? { launch } : {}),
      ...(input.agentSessionRef && AGENT_SESSION_REF.test(input.agentSessionRef)
        ? { agentSessionRef: input.agentSessionRef }
        : {}),
      ...(input.worktree ? { worktree: { ...input.worktree } } : {}),
    };
    this.sessions = [session, ...this.sessions];
    this.write();
    return { ...session };
  }

  rename(sessionId: string, title: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Terminal session not found");
    session.title = sessionTitle(title);
    this.write();
  }

  /** Records what the agent said about its own session; returns whether anything changed. */
  reportAgentSession(sessionId: string, report: AgentSessionReport): boolean {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    let changed = false;
    if (
      report.agentSessionRef &&
      AGENT_SESSION_REF.test(report.agentSessionRef) &&
      report.agentSessionRef !== session.agentSessionRef
    ) {
      session.agentSessionRef = report.agentSessionRef;
      changed = true;
    }
    if (
      report.transcriptPath &&
      path.isAbsolute(report.transcriptPath) &&
      report.transcriptPath.length <= 4096 &&
      report.transcriptPath !== session.transcriptPath
    ) {
      session.transcriptPath = report.transcriptPath;
      changed = true;
    }
    if (changed) this.write();
    return changed;
  }

  /** Records where the session's shell runs in herdr-core, or forgets it. */
  bindTerminal(sessionId: string, binding: TerminalBinding | undefined): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (
      session.coreId === binding?.coreId &&
      session.terminalAddress === binding?.terminalAddress
    )
      return;
    if (binding) {
      session.coreId = binding.coreId;
      session.terminalAddress = binding.terminalAddress;
    } else {
      delete session.coreId;
      delete session.terminalAddress;
    }
    this.write();
  }

  delete(sessionId: string): void {
    const remaining = this.sessions.filter((session) => session.id !== sessionId);
    if (remaining.length === this.sessions.length) return;
    this.sessions = remaining;
    this.write();
  }

  private read(): { sessions: TerminalSessionRecord[]; migrated: boolean } {
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8")) as { sessions?: unknown };
      if (!Array.isArray(value?.sessions)) return { sessions: [], migrated: false };
      const sessions = value.sessions.flatMap(parseRecord);
      const migrated = value.sessions.some(
        (raw) => raw && typeof raw === "object" && !isAgentKindId((raw as Record<string, unknown>).agentKind),
      );
      return { sessions, migrated: migrated && sessions.length > 0 };
    } catch {
      return { sessions: [], migrated: false };
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ sessions: this.sessions }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}

function sessionTitle(value: string): string {
  const title = value.trim().slice(0, TITLE_LIMIT);
  if (!title) throw new Error("Session title cannot be empty");
  return title;
}

function parseRecord(raw: unknown): TerminalSessionRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !value.id.startsWith(TERMINAL_SESSION_PREFIX) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.workspace !== "string" ||
    !path.isAbsolute(value.workspace) ||
    typeof value.createdAt !== "string"
  )
    return [];
  const agentKind = isAgentKindId(value.agentKind) ? value.agentKind : "shell";
  let launch: AgentLaunchOptions | undefined;
  try {
    launch = launchOptions(agentKind, value.launch);
  } catch {
    launch = undefined;
  }
  const bound =
    typeof value.coreId === "string" &&
    /^[A-Za-z0-9]{1,128}$/u.test(value.coreId) &&
    typeof value.terminalAddress === "string" &&
    TERMINAL_ADDRESS.test(value.terminalAddress);
  const worktree = parseManagedWorktree(value.worktree);
  return [
    {
      id: value.id,
      title: value.title,
      workspace: value.workspace,
      createdAt: value.createdAt,
      agentKind,
      ...(bound
        ? { coreId: value.coreId as string, terminalAddress: value.terminalAddress as string }
        : {}),
      ...(launch ? { launch } : {}),
      ...(typeof value.agentSessionRef === "string" && AGENT_SESSION_REF.test(value.agentSessionRef)
        ? { agentSessionRef: value.agentSessionRef }
        : {}),
      ...(typeof value.transcriptPath === "string" &&
      path.isAbsolute(value.transcriptPath) &&
      value.transcriptPath.length <= 4096
        ? { transcriptPath: value.transcriptPath }
        : {}),
      ...(worktree ? { worktree } : {}),
    },
  ];
}
