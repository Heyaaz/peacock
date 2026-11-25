import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { validDirectory } from "../settings-store.js";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageDelivery,
  NoticeActivity,
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
import { withoutInherited } from "../herdr-core/env.js";
import { clockLabel, record, string } from "../herdr-core/transcript/transcript-records.js";
import { TranscriptFollower } from "../herdr-core/transcript/transcripts.js";
import { isLiveRowId, OmpLiveRows } from "./live-rows.js";
import { OmpRpcClient, type RpcFrame, type RpcProcess, type RpcPromptResult } from "./rpc-client.js";
import { OMP_RPC_SESSION_PREFIX, type OmpRpcSessionRecord, type OmpRpcSessionStore } from "./session-store.js";
import { transcriptSyncEvents } from "./transcript-sync.js";

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
  /** How long omp gets to report ready (tests shorten it). */
  readyTimeoutMs?: number;
  /** Waits between reads of the session file after a turn (tests shorten them). */
  resyncDelaysMs?: readonly number[];
  /** Arguments a smoke run adds (`GAJAE_SMOKE_OMP_ARGS`), never the user's own runs. */
  extraArgs?: readonly string[];
}

/** The approval mode a chat starts omp with when the window chose none: cards need omp to ask. */
export const DEFAULT_APPROVAL_MODE = "always-ask";
/** How long a starting omp gets to say it is ready. */
const READY_TIMEOUT_MS = 30_000;
/**
 * When the session file is read again after a turn: at once, then a little later while the file
 * has not caught up with what streamed (omp writes an entry as its message ends).
 */
const RESYNC_DELAYS_MS = [150, 400, 800, 1500, 3000];

const EMPTY_PAGE: TranscriptPage = { items: [], hasMoreBefore: false, hasMoreAfter: false, requests: [] };

/** One chat's process and the turn it is streaming. */
interface ChatRuntime {
  client?: OmpRpcClient;
  starting?: Promise<OmpRpcClient>;
  live: OmpLiveRows;
  follower: TranscriptFollower;
  /** The session file's rows as last read. */
  fileRows: TranscriptItem[];
  /** What the window was last given: the baseline a resync is told against. */
  published?: TranscriptItem[];
  /** Baseline of the safety-net read (getTranscriptChanges). */
  baseline?: TranscriptItem[];
  /** Goes up with every live change, for the transcript revision. */
  liveVersion: number;
  /** A prompt is being worked on (from its acceptance to its prompt_result). */
  working: boolean;
  /** The file revision when the turn began, to tell when the file has caught up. */
  turnFileRevision?: string;
  resyncTimer?: ReturnType<typeof setTimeout>;
  resyncAttempt: number;
  /** The last `get_state` answer. */
  state?: Record<string, unknown>;
  notices: number;
}

/**
 * omp chats driven over `omp --mode rpc-ui` (design §10), as a runtime next to GJC and herdr.
 *
 * A session is a Gajae id (`omp-<uuid>`) with the folder it works in and, once omp has started
 * for it, omp's session file. One omp process per chat starts when the chat is opened or sent to
 * and ends with the app; opening the chat again resumes the file (`--resume`). While omp streams,
 * its events become the chat's rows and the window's events (live-rows.ts); when a turn ends the
 * file is read again and the live rows give way to the file's, whose ids stay the same across
 * restarts.
 */
export class OmpRpcController implements AgentRuntimeController {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly unread = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private readonly chats = new Map<string, ChatRuntime>();
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

  /** Ends the chat's omp and forgets the chat; omp's session file stays in omp's store, where a terminal can resume it. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.options.store.get(sessionId)) return;
    this.stopProcess(sessionId);
    this.options.store.delete(sessionId);
    this.forget(sessionId);
    this.options.emit({ type: "session.deleted", sessionId });
  }

  protected forget(sessionId: string): void {
    const chat = this.chats.get(sessionId);
    if (chat?.resyncTimer) clearTimeout(chat.resyncTimer);
    this.chats.delete(sessionId);
    this.statuses.delete(sessionId);
    this.unread.delete(sessionId);
    this.revisions.delete(sessionId);
  }

  // ---- transcript: omp's session file, with the turn omp streams now laid after it

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    if (!this.options.store.get(sessionId)) return [];
    return this.composed(await this.readFile(sessionId));
  }

  async getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    if (!this.options.store.get(sessionId)) return EMPTY_PAGE;
    const chat = await this.readFile(sessionId);
    const items = this.composed(chat);
    // the window now holds this read: later events are what changed after it
    chat.published = items;
    return selectTranscriptPage(items, request);
  }

  async getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    if (!this.options.store.get(sessionId)) return { kind: "full", items: [] };
    const chat = await this.readFile(sessionId);
    const items = this.composed(chat);
    const next = transcriptSyncWindow(items, chat.baseline);
    const previous = chat.baseline;
    chat.baseline = next;
    chat.published = items;
    return transcriptDelivery(previous, next);
  }

  async getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    if (!this.options.store.get(sessionId)) return undefined;
    const chat = await this.readFile(sessionId);
    const file = chat.follower.revision();
    return file === undefined && chat.liveVersion === 0 ? undefined : `${file ?? "none"}#${chat.liveVersion}`;
  }

  watchTranscripts(): void {}

  /** Opening the chat starts its omp (resuming its file), so its model and commands are known. */
  async refreshSessionContext(sessionId: string): Promise<void> {
    if (!this.options.store.get(sessionId)) return;
    await this.ensureProcess(sessionId);
  }

  /**
   * Sends a message as a prompt. While a turn works, `/steer <text>` steers it and anything else
   * is held as omp's follow-up (the composer itself holds a queued message until the turn ends).
   */
  async sendMessage(sessionId: string, input: ResolvedMessageInput): Promise<MessageDelivery> {
    const record = this.options.store.get(sessionId);
    if (!record) throw new AgentUnsupportedError("sending messages", sessionId);
    const text = input.text.trim();
    this.checkAttachments(sessionId, input);
    const steer = /^\/steer(?:\s+|$)/u.exec(text);
    const queue = /^\/queue(?:\s+|$)/u.exec(text);
    const body = steer || queue ? text.slice((steer ?? queue)![0].length).trim() : text;
    if (!body && input.images.length === 0) throw new Error("The message is empty");
    const client = await this.ensureProcess(sessionId);
    const chat = this.chat(sessionId);
    const images = this.images(input);
    if (chat.working && (steer || queue)) {
      await client.call({ type: steer ? "steer" : "follow_up", message: body, ...(images ? { images } : {}) });
      return steer ? "steer" : "prompt";
    }
    const prompt = client.prompt({
      type: "prompt",
      message: body,
      ...(images ? { images } : {}),
      ...(chat.working ? { streamingBehavior: steer ? "steer" : "followUp" } : {}),
    });
    const wasWorking = chat.working;
    chat.working = true;
    chat.turnFileRevision ??= chat.follower.revision();
    try {
      await prompt.accepted;
    } catch (error) {
      chat.working = wasWorking;
      throw error;
    }
    this.options.store.touch(sessionId);
    if (!wasWorking) this.applyStatus(sessionId, "running");
    return wasWorking && steer ? "steer" : "prompt";
  }

  /** Stops the running turn (`abort`). */
  async cancelRun(sessionId: string): Promise<void> {
    const client = this.chats.get(sessionId)?.client;
    if (!client || client.exited) return;
    await client.call({ type: "abort" });
  }

  async markSessionRead(sessionId: string): Promise<void> {
    if (!this.unread.delete(sessionId)) return;
    this.emitUpdated(sessionId);
  }

  /** The session a tool id belongs to: every row id here starts with its session's id. */
  sessionOfTool(toolId: string): string | undefined {
    const sessionId = sessionOfOmpToolId(toolId);
    return sessionId !== undefined && this.options.store.get(sessionId) !== undefined ? sessionId : undefined;
  }

  /** Ends every chat's omp: they end with the app (design §10). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionId of this.chats.keys()) this.stopProcess(sessionId);
  }

  // ---- the process

  /** The chat's omp, started (resuming its session file) if it is not running. */
  protected ensureProcess(sessionId: string): Promise<OmpRpcClient> {
    if (this.disposed) return Promise.reject(new Error("The app is closing"));
    const chat = this.chat(sessionId);
    if (chat.client && !chat.client.exited) return Promise.resolve(chat.client);
    if (chat.starting) return chat.starting;
    const starting = this.startProcess(sessionId).finally(() => {
      if (chat.starting === starting) chat.starting = undefined;
    });
    chat.starting = starting;
    return starting;
  }

  private async startProcess(sessionId: string): Promise<OmpRpcClient> {
    const record = this.options.store.get(sessionId);
    if (!record) throw new Error("omp chat not found");
    const agent = await this.options.detect();
    if (!agent.installed || !agent.binary) throw new Error(`${agent.name}: ${agent.reason ?? "not installed"}`);
    const resume = record.sessionFile !== undefined && (await exists(record.sessionFile));
    const args = [...ompRpcArgs(record, resume), ...(this.options.extraArgs ?? [])];
    const env = await this.options.environment();
    const child = this.spawnProcess(agent.binary, args, { cwd: record.workspace, env });
    const client = new OmpRpcClient(child, { log: (message) => this.log(`${sessionId}: ${message}`) });
    const chat = this.chat(sessionId);
    chat.client = client;
    client.onFrame((frame) => this.onFrame(sessionId, client, frame));
    client.onExit((info) => this.onExit(sessionId, client, info));
    try {
      await client.waitReady(this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      // protocol 2 puts a frame over 1 MiB back together instead of cutting its strings (P0)
      await client.call({ type: "negotiate_protocol", protocolVersion: 2 }).catch(() => undefined);
      await client.call({ type: "set_event_filter", events: null, messageUpdates: "delta" });
      await this.configure(sessionId, client);
      await this.refreshState(sessionId, client);
    } catch (error) {
      client.close(500);
      if (chat.client === client) chat.client = undefined;
      throw error;
    }
    return client;
  }

  /** What a started omp is told before it is used (approvals and questions add theirs). */
  protected async configure(_sessionId: string, client: OmpRpcClient): Promise<void> {
    await client.call({ type: "set_ask_dialog", enabled: true }).catch(() => undefined);
  }

  private spawnProcess(binary: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): RpcProcess {
    if (this.options.spawn) return this.options.spawn(binary, args, options);
    // Chromium keeps descriptors open without close-on-exec; omp gets only its stdio
    const [command, argv] = withoutInherited(binary, args);
    return spawn(command, argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  }

  private stopProcess(sessionId: string): void {
    const chat = this.chats.get(sessionId);
    chat?.client?.close();
  }

  /** omp's state: the session file to resume, the model and the context in use. */
  protected async refreshState(sessionId: string, client: OmpRpcClient): Promise<void> {
    const state = record(await client.call({ type: "get_state" }));
    const chat = this.chat(sessionId);
    chat.state = state;
    const sessionFile = string(state.sessionFile);
    const ompSessionId = string(state.sessionId);
    this.options.store.reportSession(sessionId, {
      ...(sessionFile ? { sessionFile } : {}),
      ...(ompSessionId ? { ompSessionId } : {}),
    });
    this.onState(sessionId, state);
    this.bump(sessionId);
    this.emitUpdated(sessionId);
  }

  /** A fresh `get_state` answer (model settings read it). */
  protected onState(_sessionId: string, _state: Record<string, unknown>): void {}

  // ---- frames

  private onFrame(sessionId: string, client: OmpRpcClient, frame: RpcFrame): void {
    const chat = this.chats.get(sessionId);
    if (!chat || chat.client !== client) return;
    if (frame.type === "extension_ui_request") {
      this.onUiRequest(sessionId, client, frame);
      return;
    }
    this.emitLive(sessionId, chat.live.apply(frame));
    switch (frame.type) {
      case "agent_start":
        if (!chat.working) {
          chat.working = true;
          chat.turnFileRevision ??= chat.follower.revision();
        }
        this.applyStatus(sessionId, "running");
        break;
      case "prompt_result":
        this.onTurnEnd(sessionId, client, frame as unknown as RpcPromptResult);
        break;
      default:
        this.onOtherFrame(sessionId, client, frame);
    }
  }

  /** A UI request omp sends (approvals and questions answer them). */
  protected onUiRequest(_sessionId: string, _client: OmpRpcClient, _frame: RpcFrame): void {}

  /** A frame the turn's rows do not cover (commands, queue, model changes). */
  protected onOtherFrame(_sessionId: string, _client: OmpRpcClient, _frame: RpcFrame): void {}

  /** The open cards of a chat whose turn ended or whose omp went away (approvals and questions close theirs). */
  protected closeCards(_sessionId: string, _reason: "ended" | "exited"): void {}

  /** Whether the chat waits on the user (an approval or a question). */
  protected waitingOnUser(_sessionId: string): boolean {
    return false;
  }

  private onTurnEnd(sessionId: string, client: OmpRpcClient, result: RpcPromptResult): void {
    const chat = this.chat(sessionId);
    chat.working = false;
    this.closeCards(sessionId, "ended");
    this.emitLive(sessionId, chat.live.cancelOpenTools());
    const category = result.status === "error" ? "failed" : result.status === "completed" && result.agentInvoked ? "completed" : undefined;
    if (result.status === "error" && result.error?.message) this.addNotice(sessionId, "작업 실패", result.error.message, "warning");
    this.applyStatus(sessionId, "idle", category);
    this.scheduleResync(sessionId);
    void this.refreshState(sessionId, client).catch((error: unknown) => this.log(`could not read the state of ${sessionId}`, error));
  }

  private onExit(sessionId: string, client: OmpRpcClient, info: { code: number | null; signal: string | null; stderr: string }): void {
    const chat = this.chats.get(sessionId);
    if (!chat || chat.client !== client) return;
    chat.client = undefined;
    if (this.disposed) return;
    const wasWorking = chat.working;
    chat.working = false;
    this.closeCards(sessionId, "exited");
    this.emitLive(sessionId, chat.live.cancelOpenTools());
    const expected = info.code === 0 && !wasWorking;
    if (!expected) {
      const last = info.stderr.trim().split("\n").at(-1) ?? "";
      const how = info.signal ? `signal ${info.signal}` : `code ${info.code ?? "?"}`;
      this.addNotice(sessionId, "omp가 종료되었습니다", [`(${how})`, last].filter(Boolean).join(" "), "warning");
      this.log(`omp of ${sessionId} ended (${how})`);
    }
    this.applyStatus(sessionId, wasWorking ? "failed" : "idle", wasWorking ? "failed" : undefined);
    this.scheduleResync(sessionId);
  }

  /** A notice row of the controller's own: kept after the turn is read back from the file. */
  protected addNotice(sessionId: string, title: string, content: string, tone: NoticeActivity["tone"]): void {
    const chat = this.chat(sessionId);
    chat.notices += 1;
    const row: NoticeActivity = {
      id: `${sessionId}:ui:notice-${Date.now().toString(36)}-${chat.notices}`,
      kind: "notice",
      sessionId,
      title,
      content,
      tone,
      createdAt: clockLabel(Date.now()),
    };
    this.emitLive(sessionId, chat.live.put(row));
  }

  /** Hands the window what changed in the live rows, and keeps the baseline in step. */
  protected emitLive(sessionId: string, events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    const chat = this.chat(sessionId);
    chat.liveVersion += 1;
    if (chat.published) chat.published = this.composed(chat);
    for (const event of events) this.options.emit(event);
  }

  // ---- resync: the file after a turn

  private scheduleResync(sessionId: string): void {
    const chat = this.chat(sessionId);
    if (chat.resyncTimer) clearTimeout(chat.resyncTimer);
    chat.resyncAttempt = 0;
    this.queueResync(sessionId);
  }

  private queueResync(sessionId: string): void {
    const chat = this.chat(sessionId);
    const delays = this.options.resyncDelaysMs ?? RESYNC_DELAYS_MS;
    const delay = delays[Math.min(chat.resyncAttempt, delays.length - 1)] ?? 0;
    chat.resyncTimer = setTimeout(() => {
      chat.resyncTimer = undefined;
      void this.resync(sessionId).catch((error: unknown) => this.log(`could not read the session of ${sessionId}`, error));
    }, delay);
    chat.resyncTimer.unref?.();
  }

  /**
   * Reads the session file again and lets the turn's live rows give way to the file's: the
   * window hears it as one synced tail. Rows the file never holds (cards, the app's notices) stay.
   * A file that has not caught up yet (no growth since the turn began) is read again shortly.
   */
  protected async resync(sessionId: string): Promise<void> {
    const chat = this.chats.get(sessionId);
    if (!chat || chat.working || !this.options.store.get(sessionId)) return;
    await this.readFile(sessionId);
    const streamed = chat.live.items().some((item) => isLiveRowId(sessionId, item.id));
    const grown = chat.follower.revision() !== chat.turnFileRevision;
    const delays = this.options.resyncDelaysMs ?? RESYNC_DELAYS_MS;
    if (streamed && !grown && chat.resyncAttempt < delays.length - 1) {
      chat.resyncAttempt += 1;
      this.queueResync(sessionId);
      return;
    }
    chat.turnFileRevision = undefined;
    const fileIds = new Set(chat.fileRows.map((item) => item.id));
    chat.live.retain((item) => !fileIds.has(item.id) && this.keepAfterSync(sessionId, item));
    chat.liveVersion += 1;
    const next = this.composed(chat);
    const events = transcriptSyncEvents(sessionId, chat.published, next);
    if (chat.published) chat.published = next;
    for (const event of events) this.options.emit(event);
  }

  /** Whether a live row stays once the file is read back: what the file never holds. */
  protected keepAfterSync(sessionId: string, item: TranscriptItem): boolean {
    if (isLiveRowId(sessionId, item.id)) return false;
    if (item.id.startsWith(`${sessionId}:ui:`)) return true;
    // a tool row the file does not have yet (a turn cut short) stays only while it waits on the user
    return item.kind === "tool" && item.status === "approval-required";
  }

  private async readFile(sessionId: string): Promise<ChatRuntime> {
    const chat = this.chat(sessionId);
    const record = this.options.store.get(sessionId);
    await chat.follower.sync(record?.sessionFile ? { path: record.sessionFile, format: "omp" } : undefined);
    chat.fileRows = chat.follower.items();
    return chat;
  }

  /** The file's rows with the live rows the file does not hold yet after them. */
  private composed(chat: ChatRuntime): TranscriptItem[] {
    const fileIds = new Set(chat.fileRows.map((item) => item.id));
    const live = chat.live.items();
    const replacing = new Map(live.filter((item) => fileIds.has(item.id)).map((item) => [item.id, item]));
    const rows = replacing.size === 0 ? chat.fileRows.slice() : chat.fileRows.map((item) => replacing.get(item.id) ?? item);
    for (const item of live) if (!fileIds.has(item.id)) rows.push(item);
    return rows;
  }

  protected chat(sessionId: string): ChatRuntime {
    let chat = this.chats.get(sessionId);
    if (!chat) {
      chat = {
        live: new OmpLiveRows(sessionId),
        follower: new TranscriptFollower(sessionId),
        fileRows: [],
        liveVersion: 0,
        working: false,
        resyncAttempt: 0,
        notices: 0,
      };
      this.chats.set(sessionId, chat);
    }
    return chat;
  }

  protected client(sessionId: string): OmpRpcClient | undefined {
    const client = this.chats.get(sessionId)?.client;
    return client && !client.exited ? client : undefined;
  }

  /** Attachments go with the prompt as omp's images once the chat takes them (P4). */
  protected checkAttachments(sessionId: string, input: ResolvedMessageInput): void {
    if (input.images.length > 0 || input.files.length > 0) throw new AgentUnsupportedError("attachments", sessionId);
  }

  protected images(_input: ResolvedMessageInput): { type: "image"; data: string; mimeType: string }[] | undefined {
    return undefined;
  }

  // ---- rows

  /** What a chat offers now: omp's RPC chat ceiling (agent-catalog.ts) less what is not wired yet. */
  protected capabilities(_record: OmpRpcSessionRecord): SessionCapabilities {
    const entry = agentCatalogEntry("omp");
    const ceiling = entry.chatCapabilities ?? entry.capabilities;
    return {
      ...ceiling,
      approvals: false,
      questions: false,
      compact: false,
      sideQuestion: false,
      modelConfig: false,
      thinking: false,
      attachments: false,
    };
  }

  protected applyStatus(sessionId: string, status: SessionStatus, activity?: "completed" | "failed" | "permission"): void {
    const record = this.options.store.get(sessionId);
    if (!record) return;
    const effective = status === "idle" && this.waitingOnUser(sessionId) ? "waiting" : status;
    const changed = this.statuses.get(sessionId) !== effective;
    this.statuses.set(sessionId, effective);
    if (changed) this.bump(sessionId);
    if (activity) this.unread.add(sessionId);
    if (changed || activity) this.emitUpdated(sessionId);
    if (activity) this.options.emit({ type: "session.activity", sessionId, title: record.title, unread: true, category: activity });
  }

  protected bump(sessionId: string): void {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
  }

  /** What omp's state adds to the row: the model, thinking and context in use. */
  protected rowExtras(session: OmpRpcSessionRecord): Partial<AgentSession> {
    const state = this.chats.get(session.id)?.state;
    if (!state) return {};
    const model = record(state.model);
    const provider = string(model.provider);
    const id = string(model.id);
    const usage = record(state.contextUsage);
    const thinking = string(state.configuredThinkingLevel, state.thinkingLevel);
    return {
      ...(provider && id ? { model: `${provider}/${id}`, modelDisplay: string(model.name) ?? id } : {}),
      ...(thinking ? { thinking } : {}),
      ...(typeof usage.percent === "number" && Number.isFinite(usage.percent) ? { usagePercent: Math.round(usage.percent) } : {}),
    };
  }

  protected row(record: OmpRpcSessionRecord): AgentSession {
    const folder = path.basename(record.workspace) || record.workspace;
    const changed = record.updatedAt ?? record.createdAt;
    const capabilities = this.capabilities(record);
    return {
      id: record.id,
      title: record.title,
      subtitle: `${agentCatalogEntry("omp").name} · ${folder}`,
      workspace: record.workspace,
      runtime: "omp-rpc",
      status: this.statuses.get(record.id) ?? "idle",
      ...(this.revisions.has(record.id) ? { runRevision: this.revisions.get(record.id) } : {}),
      updatedAt: recentLabel(changed),
      updatedAtMs: timestampMs(changed),
      pinned: false,
      unread: this.unread.has(record.id),
      accent: "#b48cff",
      ownership: "gajae",
      attachment: "attached",
      // the chat's own cards answer omp's approvals; no GJC permission mode refuses them
      ...(capabilities.approvals ? { approvalChannel: true } : {}),
      agentKind: "omp",
      surfaces: ["chat"],
      capabilities,
      ...this.rowExtras(record),
    };
  }

  protected emitUpdated(sessionId: string): void {
    const record = this.options.store.get(sessionId);
    if (record) this.options.emit({ type: "session.updated", session: this.row(record) });
  }
}

/** omp's command line for a chat: RPC with tool UI, its folder, its session to resume, how it asks. */
export function ompRpcArgs(record: Pick<OmpRpcSessionRecord, "workspace" | "sessionFile" | "launch">, resume: boolean): string[] {
  return [
    "--mode",
    "rpc-ui",
    "--cwd",
    record.workspace,
    ...(resume && record.sessionFile ? ["--resume", record.sessionFile] : []),
    `--approval-mode=${record.launch?.permissionMode ?? DEFAULT_APPROVAL_MODE}`,
    ...(record.launch?.model ? [`--model=${record.launch.model}`] : []),
  ];
}

/** The session a row id belongs to: the Gajae session id before the first `:`. */
export function sessionOfOmpToolId(toolId: string): string | undefined {
  const match = new RegExp(`^(${OMP_RPC_SESSION_PREFIX}[0-9a-f-]{36}):`, "u").exec(toolId);
  return match?.[1];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
