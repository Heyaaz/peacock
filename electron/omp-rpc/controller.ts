import path from "node:path";
import { validDirectory } from "../settings-store.js";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageDelivery,
  SessionCapabilities,
  SessionStatus,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "../../shared/agent-contract.js";
import { agentCatalogEntry } from "../../shared/agent-catalog.js";
import { launchOptions } from "../../shared/agent-launch.js";
import { selectTranscriptPage, transcriptSyncWindow } from "../../shared/transcript-page.js";
import { transcriptDelivery } from "../../shared/transcript-item-equal.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { AgentUnsupportedError, type AgentRuntimeController } from "../agent-host.js";
import type { ResolvedMessageInput } from "../gjc-sdk-model.js";
import { recentLabel, timestampMs } from "../gjc-sdk-model.js";
import { TranscriptFollower } from "../herdr-core/transcript/transcripts.js";
import type { RpcProcess } from "./rpc-client.js";
import { OMP_RPC_SESSION_PREFIX, type OmpRpcSessionRecord, type OmpRpcSessionStore } from "./session-store.js";

export interface OmpRpcControllerOptions {
  store: OmpRpcSessionStore;
  /** Where omp is installed (agent-detect.ts). */
  detect(): Promise<AgentAvailability>;
  /** The environment omp runs with: the allow-listed variables and the login shell's PATH (herdr-core/env.ts). */
  environment(): Promise<Record<string, string>>;
  /** Starts a process (tests hand in a fake). */
  spawn?(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): RpcProcess;
  emit(event: AgentEvent): void;
  /** Tells the router this runtime owns a new session. */
  claim?(sessionId: string): void;
  log?(message: string, error?: unknown): void;
}

const EMPTY_PAGE: TranscriptPage = { items: [], hasMoreBefore: false, hasMoreAfter: false, requests: [] };

/**
 * omp chats driven over `omp --mode rpc-ui` (design §10), as a runtime next to GJC and herdr.
 *
 * A session is a Gajae id (`omp-<uuid>`) with the folder it works in and, once omp has started
 * for it, omp's session file. The conversation is that file: read with the omp transcript reader,
 * so row ids are the file's own and stay the same across restarts.
 */
export class OmpRpcController implements AgentRuntimeController {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly unread = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private readonly followers = new Map<string, TranscriptFollower>();
  private readonly baselines = new Map<string, TranscriptItem[]>();
  private disposed = false;
  protected readonly log: (message: string, error?: unknown) => void;

  constructor(protected readonly options: OmpRpcControllerOptions) {
    this.log = options.log ?? ((message, error) => console.error(`omp rpc: ${message}`, error ?? ""));
  }

  // ---- AgentHost

  async getConnection(): Promise<BackendConnection> {
    return { state: "connected", backend: "omp-rpc", label: "omp", detail: "RPC", workspace: "" };
  }

  reconnect(): Promise<BackendConnection> {
    return this.getConnection();
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.rows();
  }

  rows(): AgentSession[] {
    return this.options.store.list().map((record) => this.row(record));
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    if ((input.agentKind ?? "omp") !== "omp") throw new Error("An RPC chat runs omp");
    if (!validDirectory(input.workspace)) throw new Error("Workspace must be an existing folder");
    const launch = launchOptions("omp", input.launch);
    const agent = await this.options.detect();
    if (!agent.installed) throw new Error(`${agent.name}: ${agent.reason ?? "not installed"}`);
    const record = this.options.store.create({
      title: input.title?.trim() || path.basename(input.workspace) || "omp",
      workspace: input.workspace,
      ...(launch ? { launch } : {}),
    });
    this.options.claim?.(record.id);
    const session = this.row(record);
    this.options.emit({ type: "session.created", session });
    return session;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.options.store.rename(sessionId, title);
    this.emitUpdated(sessionId);
  }

  sessionTitle(sessionId: string): string | undefined {
    return this.options.store.get(sessionId)?.title;
  }

  /** A chat keeps nothing apart from omp's own session file, so hiding it is deleting the row. */
  hideSession(sessionId: string): void {
    void this.deleteSession(sessionId).catch((error: unknown) => this.log(`could not hide ${sessionId}`, error));
  }

  /** Forgets the chat; omp's session file stays in omp's store, where a terminal can resume it. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.options.store.get(sessionId)) return;
    this.options.store.delete(sessionId);
    this.forget(sessionId);
    this.options.emit({ type: "session.deleted", sessionId });
  }

  protected forget(sessionId: string): void {
    this.statuses.delete(sessionId);
    this.unread.delete(sessionId);
    this.revisions.delete(sessionId);
    this.followers.delete(sessionId);
    this.baselines.delete(sessionId);
  }

  // ---- transcript: omp's session file

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.items(sessionId);
  }

  async getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    if (!this.options.store.get(sessionId)) return EMPTY_PAGE;
    return selectTranscriptPage(await this.items(sessionId), request);
  }

  async getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    const items = await this.items(sessionId);
    const previous = this.baselines.get(sessionId);
    const next = transcriptSyncWindow(items, previous);
    this.baselines.set(sessionId, next);
    return transcriptDelivery(previous, next);
  }

  async getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    const follower = await this.followed(sessionId);
    return follower?.revision();
  }

  watchTranscripts(): void {}

  async refreshSessionContext(): Promise<void> {}

  async sendMessage(sessionId: string, _input: ResolvedMessageInput): Promise<MessageDelivery> {
    throw new AgentUnsupportedError("sending messages", sessionId);
  }

  async cancelRun(): Promise<void> {}

  async markSessionRead(sessionId: string): Promise<void> {
    if (!this.unread.delete(sessionId)) return;
    this.emitUpdated(sessionId);
  }

  /** The session a tool id belongs to: every row id here starts with its session's id. */
  sessionOfTool(toolId: string): string | undefined {
    const sessionId = sessionOfOmpToolId(toolId);
    return sessionId !== undefined && this.options.store.get(sessionId) !== undefined ? sessionId : undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  protected get isDisposed(): boolean {
    return this.disposed;
  }

  /** The rows of the chat's session file. */
  protected async items(sessionId: string): Promise<TranscriptItem[]> {
    const follower = await this.followed(sessionId);
    return follower?.items() ?? [];
  }

  protected async followed(sessionId: string): Promise<TranscriptFollower | undefined> {
    const record = this.options.store.get(sessionId);
    if (!record) return undefined;
    let follower = this.followers.get(sessionId);
    if (!follower) {
      follower = new TranscriptFollower(sessionId);
      this.followers.set(sessionId, follower);
    }
    await follower.sync(record.sessionFile ? { path: record.sessionFile, format: "omp" } : undefined);
    return follower;
  }

  // ---- rows

  /** What a chat offers: omp's RPC chat ceiling (agent-catalog.ts). */
  protected capabilities(_record: OmpRpcSessionRecord): SessionCapabilities {
    const entry = agentCatalogEntry("omp");
    return { ...(entry.chatCapabilities ?? entry.capabilities) };
  }

  protected status(sessionId: string): SessionStatus {
    return this.statuses.get(sessionId) ?? "idle";
  }

  protected setStatus(sessionId: string, status: SessionStatus): boolean {
    if (this.statuses.get(sessionId) === status) return false;
    this.statuses.set(sessionId, status);
    this.bump(sessionId);
    return true;
  }

  protected markUnread(sessionId: string): void {
    this.unread.add(sessionId);
  }

  protected bump(sessionId: string): void {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
  }

  protected rowExtras(_record: OmpRpcSessionRecord): Partial<AgentSession> {
    return {};
  }

  protected row(record: OmpRpcSessionRecord): AgentSession {
    const folder = path.basename(record.workspace) || record.workspace;
    const changed = record.updatedAt ?? record.createdAt;
    return {
      id: record.id,
      title: record.title,
      subtitle: `${agentCatalogEntry("omp").name} · ${folder}`,
      workspace: record.workspace,
      runtime: "omp-rpc",
      status: this.status(record.id),
      ...(this.revisions.has(record.id) ? { runRevision: this.revisions.get(record.id) } : {}),
      updatedAt: recentLabel(changed),
      updatedAtMs: timestampMs(changed),
      pinned: false,
      unread: this.unread.has(record.id),
      accent: "#b48cff",
      ownership: "gajae",
      attachment: "attached",
      agentKind: "omp",
      surfaces: ["chat"],
      capabilities: this.capabilities(record),
      ...this.rowExtras(record),
    };
  }

  protected emitUpdated(sessionId: string): void {
    const record = this.options.store.get(sessionId);
    if (record) this.options.emit({ type: "session.updated", session: this.row(record) });
  }
}

/** The session a row id belongs to: the Gajae session id before the first `:`. */
export function sessionOfOmpToolId(toolId: string): string | undefined {
  const match = new RegExp(`^(${OMP_RPC_SESSION_PREFIX}[0-9a-f-]{36}):`, "u").exec(toolId);
  return match?.[1];
}
