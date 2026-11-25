import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchOptions, type AgentLaunchOptions } from "../../shared/agent-launch.js";

/** omp RPC chat ids carry this prefix, so a row or a tool id says which runtime owns it. */
export const OMP_RPC_SESSION_PREFIX = "omp-";
const SESSION_ID = /^omp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** omp's own session ids (P0: `01a2103a-b2a8-7412-b3ed-0106bbece8c3`). */
const OMP_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TITLE_LIMIT = 200;
const PATH_LIMIT = 4096;

export function isOmpRpcSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/** One omp RPC chat as the app keeps it: its folder, and the omp session file it resumes. */
export interface OmpRpcSessionRecord {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  /** When the chat last had a turn, for the rail's order. */
  updatedAt?: string;
  /** omp's session file (`get_state.sessionFile`), which `--resume` reopens. */
  sessionFile?: string;
  /** omp's id for that session. */
  ompSessionId?: string;
  /** The model and approval mode the chat starts omp with. */
  launch?: AgentLaunchOptions;
}

/**
 * The omp RPC chats made in this app, newest first (design §10). omp keeps the conversation in
 * its own session file; this file (0600 in userData) is the only list of which ones are Gajae's.
 */
export class OmpRpcSessionStore {
  private readonly filePath: string;
  private sessions: OmpRpcSessionRecord[];

  constructor(
    userDataDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(userDataDirectory, "omp-rpc-sessions.json");
    this.sessions = this.read();
  }

  list(): OmpRpcSessionRecord[] {
    return this.sessions.map((session) => ({ ...session }));
  }

  get(sessionId: string): OmpRpcSessionRecord | undefined {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    return session ? { ...session } : undefined;
  }

  create(input: { title: string; workspace: string; launch?: AgentLaunchOptions }): OmpRpcSessionRecord {
    const launch = launchOptions("omp", input.launch);
    const session: OmpRpcSessionRecord = {
      id: `${OMP_RPC_SESSION_PREFIX}${randomUUID()}`,
      title: sessionTitle(input.title),
      workspace: path.resolve(input.workspace),
      createdAt: this.now().toISOString(),
      ...(launch ? { launch } : {}),
    };
    this.sessions = [session, ...this.sessions];
    this.write();
    return { ...session };
  }

  rename(sessionId: string, title: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("omp chat not found");
    session.title = sessionTitle(title);
    this.write();
  }

  /** Records omp's session for the chat (after `ready`, from `get_state`); returns whether it changed. */
  reportSession(sessionId: string, report: { sessionFile?: string; ompSessionId?: string }): boolean {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    let changed = false;
    if (report.sessionFile && validPath(report.sessionFile) && report.sessionFile !== session.sessionFile) {
      session.sessionFile = report.sessionFile;
      changed = true;
    }
    if (report.ompSessionId && OMP_SESSION_ID.test(report.ompSessionId) && report.ompSessionId !== session.ompSessionId) {
      session.ompSessionId = report.ompSessionId;
      changed = true;
    }
    if (changed) this.write();
    return changed;
  }

  /** Notes that the chat had a turn now. */
  touch(sessionId: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    session.updatedAt = this.now().toISOString();
    this.write();
  }

  delete(sessionId: string): void {
    const remaining = this.sessions.filter((session) => session.id !== sessionId);
    if (remaining.length === this.sessions.length) return;
    this.sessions = remaining;
    this.write();
  }

  private read(): OmpRpcSessionRecord[] {
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8")) as { sessions?: unknown };
      return Array.isArray(value?.sessions) ? value.sessions.flatMap(parseRecord) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ sessions: this.sessions }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
  }
}

function sessionTitle(value: string): string {
  const title = value.trim().slice(0, TITLE_LIMIT);
  if (!title) throw new Error("Session title cannot be empty");
  return title;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= PATH_LIMIT && !value.includes("\0");
}

function parseRecord(raw: unknown): OmpRpcSessionRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    !SESSION_ID.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !validPath(value.workspace) ||
    typeof value.createdAt !== "string"
  )
    return [];
  let launch: AgentLaunchOptions | undefined;
  try {
    launch = launchOptions("omp", value.launch);
  } catch {
    launch = undefined;
  }
  return [
    {
      id: value.id,
      title: value.title,
      workspace: value.workspace,
      createdAt: value.createdAt,
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
      ...(validPath(value.sessionFile) ? { sessionFile: value.sessionFile } : {}),
      ...(typeof value.ompSessionId === "string" && OMP_SESSION_ID.test(value.ompSessionId) ? { ompSessionId: value.ompSessionId } : {}),
      ...(launch ? { launch } : {}),
    },
  ];
}
