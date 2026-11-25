import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { validDirectory } from "../settings-store.js";
import type {
  AgentCommand,
  AgentConfigOption,
  AgentEvent,
  ModelCatalogFacts,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageDelivery,
  NoticeActivity,
  QueuedMessage,
  QuestionActivity,
  QuestionSubmission,
  SessionCapabilities,
  SessionStatus,
  ToolActivity,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "../../shared/agent-contract.js";
import { normalizeRulePrefix, type CommandRuleDecision, type CommandRuleMatch } from "../../shared/command-rules.js";
import { permissionOptionLabel } from "../../shared/permission-options.js";
import { agentCatalogEntry } from "../../shared/agent-catalog.js";
import { launchOptions } from "../../shared/agent-launch.js";
import { selectTranscriptPage, transcriptSyncWindow } from "../../shared/transcript-page.js";
import { transcriptDelivery } from "../../shared/transcript-item-equal.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { AgentUnsupportedError, type AgentRuntimeController } from "../agent-host.js";
import type { ResolvedMessageInput } from "../gjc-sdk-model.js";
import { recentLabel, timestampMs } from "../gjc-sdk-model.js";
import { withoutInherited } from "../herdr-core/env.js";
import { bounded, clockLabel, record, string, toolRow, TranscriptRows } from "../herdr-core/transcript/transcript-records.js";
import { TranscriptFollower } from "../herdr-core/transcript/transcripts.js";
import { isLiveRowId, OmpLiveRows } from "./live-rows.js";
import { OmpRpcClient, type RpcFrame, type RpcProcess, type RpcPromptResult } from "./rpc-client.js";
import { OMP_RPC_SESSION_PREFIX, type OmpRpcSessionRecord, type OmpRpcSessionStore } from "./session-store.js";
import { transcriptSyncEvents } from "./transcript-sync.js";
import {
  approvalChoices,
  approvalDetail,
  approvalToolName,
  formValue,
  pairApproval,
  parseHtmlForm,
  type ApprovalChoice,
  type FormField,
} from "./ui-requests.js";

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
  /** Project command rules that answer an approval without a card (GJC's store). */
  commandRules?: {
    decide(projectPath: string, toolName: string, command: string): Promise<CommandRuleMatch | undefined>;
    add(projectPath: string, prefix: string, decision: CommandRuleDecision): Promise<void>;
  };
}

/** An approval card waiting for its answer. */
interface PendingApproval {
  kind: "approval";
  requestId: string;
  sessionId: string;
  client: OmpRpcClient;
  rowId: string;
  /** The call it was paired with; unset for a card of its own. */
  callId?: string;
  toolName: string;
  command?: string;
  choices: ApprovalChoice[];
}

/** What one question card of a dialog answers with. */
type QuestionShape =
  | { kind: "form"; field: FormField }
  | { kind: "ask"; id: string; labels: string[]; multi: boolean }
  | { kind: "select"; labels: string[] }
  | { kind: "confirm" }
  | { kind: "input" };

/** A dialog of one or more question cards, answered together once every card has its answer. */
interface PendingQuestion {
  kind: "question";
  requestId: string;
  sessionId: string;
  client: OmpRpcClient;
  method: "form" | "ask" | "select" | "confirm" | "input";
  cards: { id: string; shape: QuestionShape; answer?: { value: unknown; summary: string } }[];
}

type PendingUi = PendingApproval | PendingQuestion;

const YES = "예";
const NO = "아니요";

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
  /** omp's slash commands (`available_commands_update`). */
  commands?: AgentCommand[];
  /** Models omp's picker offers (`get_model_picker` with catalog facts from `get_available_models`), read when the chat opens. */
  models?: { value: string; name: string; group: string; catalog: ModelCatalogFacts }[];
  /** omp's queue of steering and follow-up messages (`queue_update`). */
  queue: { steering: string[]; followUp: string[] };
  /** A compaction is running. */
  compacting: boolean;
  /** omp waits to retry a model call. */
  retry?: { attempt: number; maxAttempts?: number; retryAt: number; error?: string };
  stateTimer?: ReturnType<typeof setTimeout>;
}

/** A side question waiting for its answer (`btw`). */
interface PendingSideQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a side question may take. */
const SIDE_QUESTION_TIMEOUT_MS = 5 * 60_000;
/** How many models the composer's picker lists: omp's whole catalog (P4: 286 on this Mac). */
const MODEL_PICKER_LIMIT = 1000;
/** omp's chat model roles a picker scope names, in omp's order (config/model-roles.ts). */
const MODEL_ROLE_NAMES: Readonly<Record<string, string>> = {
  default: "메인",
  smol: "smol",
  slow: "slow",
  plan: "plan",
  task: "task",
  advisor: "advisor",
  commit: "commit",
  tiny: "tiny",
  vision: "vision",
  memory: "memory",
};

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
  /** Open approval and question dialogs by omp's request id. */
  private readonly pendingUi = new Map<string, PendingUi>();
  /** Calls an approval was paired with, per chat, so a second prompt pairs with another. */
  private readonly pairedCalls = new Map<string, Set<string>>();
  /** Side questions by omp's record id. */
  private readonly sideQuestions = new Map<string, PendingSideQuestion>();
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
    for (const [requestId, pending] of this.pendingUi) if (pending.sessionId === sessionId) this.pendingUi.delete(requestId);
    this.pairedCalls.delete(sessionId);
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
    const client = await this.ensureProcess(sessionId);
    const chat = this.chat(sessionId);
    if (chat.commands) this.options.emit({ type: "session.commands", sessionId, commands: chat.commands });
    else
      void client
        .call<{ commands?: unknown }>({ type: "get_available_commands" })
        .then((data) => this.applyCommands(sessionId, data?.commands))
        .catch(() => undefined);
    if (!chat.models) void this.loadModels(sessionId, client);
    else this.emitConfig(sessionId);
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
    if (!body && input.images.length === 0 && input.files.length === 0) throw new Error("The message is empty");
    const client = await this.ensureProcess(sessionId);
    const chat = this.chat(sessionId);
    const images = await this.images(input);
    const message = this.promptText(body, input);
    if (chat.working && (steer || queue)) {
      await client.call({ type: steer ? "steer" : "follow_up", message, ...(images ? { images } : {}) });
      return steer ? "steer" : "prompt";
    }
    const prompt = client.prompt({
      type: "prompt",
      message,
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

  /** A fresh `get_state` answer: the composer's model and thinking settings follow it. */
  protected onState(sessionId: string, state: Record<string, unknown>): void {
    const queued = record(state.queuedMessages);
    if (Array.isArray(queued.steering) || Array.isArray(queued.followUp))
      this.chat(sessionId).queue = {
        steering: Array.isArray(queued.steering) ? queued.steering.filter((entry): entry is string => typeof entry === "string") : [],
        followUp: Array.isArray(queued.followUp) ? queued.followUp.filter((entry): entry is string => typeof entry === "string") : [],
      };
    this.emitConfig(sessionId);
  }

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

  /** A UI request omp sends: an approval, a question, a notice, or the close of one of them. */
  protected onUiRequest(sessionId: string, client: OmpRpcClient, frame: RpcFrame): void {
    const requestId = string(frame.id);
    if (!requestId) return;
    switch (frame.method) {
      case "select": {
        const title = string(frame.title) ?? "";
        const options = Array.isArray(frame.options) ? frame.options.filter((option): option is string => typeof option === "string") : [];
        if (approvalToolName(title)) void this.requestApproval(sessionId, client, requestId, title, options);
        else this.askQuestion(sessionId, client, requestId, "select", [{ question: title, options, multi: false, shape: { kind: "select", labels: options } }]);
        return;
      }
      case "form": {
        const fields = parseHtmlForm(string(frame.html) ?? "");
        // a form with nothing to fill in has only its defaults to send
        if (fields.length === 0) {
          client.send({ type: "extension_ui_response", id: requestId, data: {} });
          return;
        }
        this.askQuestion(
          sessionId,
          client,
          requestId,
          "form",
          fields.map((field) => ({
            question: field.label,
            options: field.kind === "choice" ? field.options.filter((entry) => !entry.disabled).map((entry) => ({ label: entry.label, ...(entry.checked ? { recommended: true } : {}) })) : [],
            multi: field.kind === "choice" && field.multi,
            shape: { kind: "form", field },
          })),
        );
        return;
      }
      case "ask": {
        const questions = Array.isArray(frame.questions) ? frame.questions.map(record) : [];
        this.askQuestion(
          sessionId,
          client,
          requestId,
          "ask",
          questions.map((question) => {
            const labels = (Array.isArray(question.options) ? question.options.map(record) : []).flatMap((option) => (typeof option.label === "string" ? [option.label] : []));
            const recommended = typeof question.recommended === "number" ? question.recommended : -1;
            return {
              question: [string(question.header), string(question.question)].filter(Boolean).join("\n"),
              options: labels.map((label, index) => ({ label, ...(index === recommended ? { recommended: true } : {}) })),
              multi: question.multi === true,
              shape: { kind: "ask", id: string(question.id) ?? "", labels, multi: question.multi === true },
            };
          }),
        );
        return;
      }
      case "confirm":
        this.askQuestion(sessionId, client, requestId, "confirm", [
          { question: [string(frame.title), string(frame.message)].filter(Boolean).join("\n"), options: [YES, NO], multi: false, shape: { kind: "confirm" } },
        ]);
        return;
      case "input":
      case "editor":
        this.askQuestion(sessionId, client, requestId, "input", [{ question: string(frame.title) ?? "", options: [], multi: false, shape: { kind: "input" } }]);
        return;
      case "notify": {
        const message = string(frame.message);
        if (message) this.addNotice(sessionId, "omp", message, frame.notifyType === "error" || frame.notifyType === "warning" ? "warning" : "neutral");
        return;
      }
      case "cancel": {
        const target = string(frame.targetId);
        if (target) this.closeDialog(target, "cancelled");
        return;
      }
      default:
        // setStatus, setWidget, setTitle, set_editor_text, open_url: nothing the chat shows
        return;
    }
  }

  // ---- approvals

  private async requestApproval(sessionId: string, client: OmpRpcClient, requestId: string, title: string, options: string[]): Promise<void> {
    const chat = this.chat(sessionId);
    const paired = this.pairedCalls.get(sessionId) ?? new Set<string>();
    this.pairedCalls.set(sessionId, paired);
    const call = pairApproval(title, chat.live.runningTools(), paired);
    if (call) paired.add(call.callId);
    const toolName = call?.name ?? approvalToolName(title) ?? "tool";
    const command = call && typeof call.input.command === "string" ? call.input.command : undefined;
    let choices = approvalChoices(options);
    if (!choices.some((choice) => choice.option.kind === "allow_once")) {
      const allow = options.find((option) => option.startsWith("Approve"));
      if (allow) choices = [{ option: { optionId: "allow_once", kind: "allow_once", name: "Allow once" }, label: allow }, ...choices];
    }
    const workspace = this.options.store.get(sessionId)?.workspace;
    if (command !== undefined && toolName === "bash" && workspace && this.options.commandRules) {
      let match: CommandRuleMatch | undefined;
      try {
        match = await this.options.commandRules.decide(workspace, "bash", command);
      } catch {
        match = undefined;
      }
      const choice = match && choices.find((entry) => entry.option.kind === (match.decision === "allow" ? "allow_once" : "reject_once"));
      if (match && choice && call) {
        client.send({ type: "extension_ui_response", id: requestId, value: choice.label });
        this.emitLive(
          sessionId,
          chat.live.updateTool(call.rowId, (tool) => ({ ...dropOptions(tool), status: match.decision === "allow" ? "approved" : "denied", autoDecision: match })),
        );
        return;
      }
    }
    // the call finished while the rules were read: nothing is left to ask
    if (client.exited || (call && chat.live.tool(call.callId)?.endedAt !== undefined)) return;
    const rowId = call?.rowId ?? `${sessionId}:ui:approval-${requestId}`;
    const pending: PendingApproval = { kind: "approval", requestId, sessionId, client, rowId, toolName, choices, ...(call ? { callId: call.callId } : {}), ...(command !== undefined ? { command } : {}) };
    this.pendingUi.set(requestId, pending);
    const permissionOptions = choices.map((choice) => choice.option);
    if (call) this.emitLive(sessionId, chat.live.updateTool(rowId, (tool) => ({ ...tool, status: "approval-required", permissionOptions })));
    else {
      const row = toolRow(new TranscriptRows(sessionId), rowId, toolName, {}, approvalDetail(title) || toolName, Date.now());
      this.emitLive(sessionId, chat.live.put({ ...row, command: bounded(title), status: "approval-required", permissionOptions }));
    }
    this.markWaiting(sessionId);
  }

  toolDecisionInfo(toolId: string, decision: ToolDecision): { name: string; requiresConfirmation: boolean } {
    const { choice } = this.approvalChoice(toolId, decision);
    const allows = choice.option.kind.startsWith("allow");
    const label = permissionOptionLabel(choice.option);
    return {
      name: decision.rule && allows ? `${label}\n"${decision.rule.prefix}"로 시작하는 명령은 이 프로젝트에서 앞으로 묻지 않고 허용합니다.` : label,
      requiresConfirmation: allows,
    };
  }

  /**
   * Answers an approval card with omp's own option, remembering a command prefix for the project
   * first when asked to. A rule that cannot be saved must not leave omp waiting: the call is
   * answered either way and the save error is thrown afterwards. omp's select takes no words for a
   * rejection, so a comment is not passed on.
   */
  async resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    const { pending, choice } = this.approvalChoice(toolId, decision);
    const allows = choice.option.kind.startsWith("allow");
    let ruleFailure: unknown;
    if (decision.rule) {
      try {
        const workspace = this.options.store.get(pending.sessionId)?.workspace;
        const prefix = normalizeRulePrefix(decision.rule.prefix);
        if (!this.options.commandRules || !workspace) throw new Error("Command rules are unavailable for this session");
        if (pending.toolName !== "bash" || pending.command === undefined) throw new Error("Command rules apply to bash calls only");
        if (!prefix) throw new Error("Command rule prefix is invalid");
        await this.options.commandRules.add(workspace, prefix, allows ? "allow" : "reject");
      } catch (error) {
        ruleFailure = error;
      }
    }
    if (this.pendingUi.get(pending.requestId) !== pending) throw new Error(`No pending permission for tool call ${toolId}`);
    this.pendingUi.delete(pending.requestId);
    pending.client.send({ type: "extension_ui_response", id: pending.requestId, value: choice.label });
    const chat = this.chat(pending.sessionId);
    this.emitLive(pending.sessionId, chat.live.updateTool(pending.rowId, (tool) => ({ ...dropOptions(tool), status: allows ? "approved" : "denied" })));
    this.settleWaiting(pending.sessionId);
    if (ruleFailure) throw ruleFailure;
  }

  private approvalChoice(toolId: string, decision: ToolDecision): { pending: PendingApproval; choice: ApprovalChoice } {
    const pending = [...this.pendingUi.values()].find((entry): entry is PendingApproval => entry.kind === "approval" && entry.rowId === toolId);
    if (!pending) throw new Error(`No pending permission for tool call ${toolId}`);
    const choice = pending.choices.find((entry) => entry.option.optionId === decision.optionId);
    if (!choice) throw new Error(`Unknown permission option ${decision.optionId}`);
    return { pending, choice };
  }

  // ---- questions

  private askQuestion(
    sessionId: string,
    client: OmpRpcClient,
    requestId: string,
    method: PendingQuestion["method"],
    questions: { question: string; options: (string | { label: string; recommended?: boolean })[]; multi: boolean; shape: QuestionShape }[],
  ): void {
    const chat = this.chat(sessionId);
    const createdAt = clockLabel(Date.now());
    const pending: PendingQuestion = { kind: "question", requestId, sessionId, client, method, cards: [] };
    const events: AgentEvent[] = [];
    questions.forEach((entry, index) => {
      const id = `${sessionId}:ui:question-${requestId}-${index}`;
      pending.cards.push({ id, shape: entry.shape });
      const card: QuestionActivity = {
        id,
        kind: "question",
        sessionId,
        question: entry.question || "omp",
        options: entry.options.map((option) => (typeof option === "string" ? { label: option } : option)),
        multi: entry.multi,
        status: "pending",
        createdAt,
        answerable: true,
        tag: "pending",
        expectedSessionId: sessionId,
      };
      events.push(...chat.live.put(card));
    });
    this.pendingUi.set(requestId, pending);
    this.emitLive(sessionId, events);
    this.markWaiting(sessionId);
  }

  async listPendingQuestions(sessionId: string): Promise<QuestionActivity[]> {
    return this.chat(sessionId)
      .live.items()
      .filter((item): item is QuestionActivity => item.kind === "question" && item.answerable && (item.status === "pending" || item.status === "rejected"));
  }

  /**
   * Answers one question card. A dialog of several cards (a form with several fields, an ask with
   * several questions) goes back to omp once every card has its answer.
   */
  async answerQuestion(sessionId: string, gateId: string, submission: QuestionSubmission): Promise<void> {
    const pending = [...this.pendingUi.values()].find(
      (entry): entry is PendingQuestion => entry.kind === "question" && entry.sessionId === sessionId && entry.cards.some((card) => card.id === gateId),
    );
    if (!pending) throw new Error("This question is no longer waiting for an answer");
    const card = pending.cards.find((entry) => entry.id === gateId)!;
    const chat = this.chat(sessionId);
    const current = chat.live.get(gateId);
    if (current?.kind !== "question") throw new Error("This question is no longer waiting for an answer");
    const answer = cardAnswer(card.shape, submission);
    if ("error" in answer) {
      this.emitLive(sessionId, chat.live.put({ ...current, status: "rejected", error: answer.error }));
      return;
    }
    card.answer = answer;
    const { error: _error, ...settled } = current;
    this.emitLive(sessionId, chat.live.put({ ...settled, status: "answered", answerSummary: answer.summary }));
    if (pending.cards.some((entry) => !entry.answer)) return;
    this.pendingUi.delete(pending.requestId);
    pending.client.send({ type: "extension_ui_response", id: pending.requestId, ...dialogResponse(pending) });
    this.settleWaiting(sessionId);
  }

  // ---- dialogs closing

  /** omp closed a dialog (aborted, timed out) or it can no longer be answered. */
  private closeDialog(requestId: string, status: "cancelled" | "closed"): void {
    const pending = this.pendingUi.get(requestId);
    if (!pending) return;
    this.pendingUi.delete(requestId);
    const chat = this.chats.get(pending.sessionId);
    if (!chat) return;
    if (pending.kind === "approval") {
      this.emitLive(
        pending.sessionId,
        chat.live.updateTool(pending.rowId, (tool) => ({ ...dropOptions(tool), status: pending.callId && status === "cancelled" && chat.working ? "running" : "cancelled" })),
      );
    } else {
      const events: AgentEvent[] = [];
      for (const card of pending.cards) {
        const current = chat.live.get(card.id);
        if (current?.kind === "question" && current.status !== "answered") events.push(...chat.live.put({ ...current, status, answerable: false }));
      }
      this.emitLive(pending.sessionId, events);
    }
    this.settleWaiting(pending.sessionId);
  }

  private markWaiting(sessionId: string): void {
    this.setStatusNow(sessionId, "waiting", "permission");
  }

  /** The chat waits no more on the user when its last dialog is answered. */
  private settleWaiting(sessionId: string): void {
    if (this.waitingOnUser(sessionId)) return;
    const chat = this.chats.get(sessionId);
    this.setStatusNow(sessionId, chat?.working ? "running" : "idle");
  }

  /** A frame the turn's rows do not cover: commands, the queue, model changes, compaction, retries, notices. */
  protected onOtherFrame(sessionId: string, client: OmpRpcClient, frame: RpcFrame): void {
    const chat = this.chat(sessionId);
    switch (frame.type) {
      case "available_commands_update":
        this.applyCommands(sessionId, frame.commands);
        return;
      case "model_changed":
      case "thinking_level_changed":
        this.refreshStateSoon(sessionId, client);
        return;
      case "queue_update":
        chat.queue = {
          steering: Array.isArray(frame.steering) ? frame.steering.filter((entry): entry is string => typeof entry === "string") : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp.filter((entry): entry is string => typeof entry === "string") : [],
        };
        return;
      case "manual_compaction_start":
      case "auto_compaction_start":
        chat.compacting = true;
        this.bump(sessionId);
        this.emitUpdated(sessionId);
        return;
      case "manual_compaction_end":
      case "auto_compaction_end": {
        chat.compacting = false;
        const message = string(frame.errorMessage);
        if (message && frame.skipped !== true && frame.aborted !== true) this.addNotice(sessionId, "압축 실패", message, "warning");
        this.bump(sessionId);
        this.emitUpdated(sessionId);
        if (!chat.working) this.scheduleResync(sessionId);
        this.refreshStateSoon(sessionId, client);
        return;
      }
      case "auto_retry_start":
        chat.retry = {
          attempt: typeof frame.attempt === "number" ? frame.attempt : 1,
          ...(typeof frame.maxAttempts === "number" ? { maxAttempts: frame.maxAttempts } : {}),
          retryAt: Date.now() + (typeof frame.delayMs === "number" ? frame.delayMs : 0),
          ...(typeof frame.errorMessage === "string" ? { error: frame.errorMessage } : {}),
        };
        this.bump(sessionId);
        this.emitUpdated(sessionId);
        return;
      case "auto_retry_end":
        chat.retry = undefined;
        this.bump(sessionId);
        this.emitUpdated(sessionId);
        return;
      case "notice":
        // omp's info notices (MCP tools added, prewalk) are its own bookkeeping
        if ((frame.level === "warning" || frame.level === "error") && typeof frame.message === "string")
          this.addNotice(sessionId, "omp", frame.message, "warning");
        return;
      case "btw_record": {
        const entry = record(frame.record);
        const id = string(entry.id);
        const pending = id ? this.sideQuestions.get(id) : undefined;
        if (!pending || !id) return;
        const latest = sideTurn(entry);
        if (latest.status === "running") return;
        this.sideQuestions.delete(id);
        clearTimeout(pending.timer);
        if (latest.status === "complete") pending.resolve(latest.answer);
        else pending.reject(new Error(latest.error || `The side question ended: ${latest.status}`));
        return;
      }
      default:
        return;
    }
  }

  /**
   * omp's model picker as the composer shows it: the picker's own order, recent block and role tags
   * (`get_model_picker`), with each model's score, speed, context and price from the catalog
   * (`get_available_models`, P4: `int` on 131 of 286, `tps` on 33).
   */
  private async loadModels(sessionId: string, client: OmpRpcClient): Promise<void> {
    const [picker, available] = await Promise.all([
      client.call<{ rows?: unknown; recent?: unknown }>({ type: "get_model_picker", limit: MODEL_PICKER_LIMIT }).catch(() => undefined),
      client.call<{ models?: unknown }>({ type: "get_available_models" }, 60_000).catch(() => undefined),
    ]);
    if (!picker) return;
    const facts = new Map<string, Record<string, unknown>>();
    for (const model of Array.isArray(available?.models) ? available.models.map(record) : []) {
      const provider = string(model.provider);
      const id = string(model.id);
      if (provider && id) facts.set(`${provider}/${id}`, model);
    }
    const recent = typeof picker.recent === "number" ? picker.recent : 0;
    this.chat(sessionId).models = (Array.isArray(picker.rows) ? picker.rows.map(record) : []).flatMap((row, index) => {
      const provider = string(row.provider);
      const id = string(row.id);
      if (!provider || !id) return [];
      const value = `${provider}/${id}`;
      const model = facts.get(value) ?? {};
      const cost = record(model.cost);
      const roles = (Array.isArray(row.roles) ? row.roles.map(record) : []).flatMap((role) => {
        const name = string(role.role);
        return name ? [{ role: name, label: string(role.label) ?? name }] : [];
      });
      const catalog: ModelCatalogFacts = {
        provider,
        ...(roles.length > 0 ? { roles } : {}),
        ...(index < recent ? { recent: true } : {}),
        ...(finite(model.int) ? { intelligence: model.int as number } : {}),
        ...(finite(model.tps) ? { tokensPerSecond: model.tps as number } : {}),
        ...(finite(model.contextWindow) ? { contextWindow: model.contextWindow as number } : {}),
        ...(finite(cost.input) && finite(cost.output) ? { cost: { input: cost.input as number, output: cost.output as number } } : {}),
      };
      return [{ value, name: string(row.name) ?? id, group: provider, catalog }];
    });
    this.emitConfig(sessionId);
  }

  private applyCommands(sessionId: string, value: unknown): void {
    const commands = (Array.isArray(value) ? value.map(record) : []).flatMap((command): AgentCommand[] => {
      const name = string(command.name);
      if (!name) return [];
      const hint = string(record(command.input).hint);
      return [{ name, description: string(command.description) ?? "", ...(hint ? { hint } : {}) }];
    });
    // omp answers `/btw` over RPC (the `btw` command) though its slash list leaves it out (19.1.1)
    if (!commands.some((command) => command.name === "btw"))
      commands.push({ name: "btw", description: "대화에 남기지 않고 묻는 사이드 질문", hint: "<질문>" });
    this.chat(sessionId).commands = commands;
    this.options.emit({ type: "session.commands", sessionId, commands });
  }

  private refreshStateSoon(sessionId: string, client: OmpRpcClient): void {
    const chat = this.chat(sessionId);
    if (chat.stateTimer) return;
    chat.stateTimer = setTimeout(() => {
      chat.stateTimer = undefined;
      void this.refreshState(sessionId, client).catch(() => undefined);
    }, 50);
    chat.stateTimer.unref?.();
  }

  /** The composer's model and thinking settings, from omp's state and its model picker. */
  private emitConfig(sessionId: string): void {
    const options = this.configOptions(sessionId);
    if (options.length > 0) this.options.emit({ type: "session.config", sessionId, options });
  }

  private configOptions(sessionId: string): AgentConfigOption[] {
    const chat = this.chat(sessionId);
    const state = chat.state;
    if (!state) return [];
    const model = record(state.model);
    const provider = string(model.provider);
    const id = string(model.id);
    const current = provider && id ? `${provider}/${id}` : "";
    const known = chat.models ?? [];
    const models = current && !known.some((entry) => entry.value === current) ? [{ value: current, name: string(model.name) ?? id ?? current, group: provider ?? "", catalog: { provider: provider ?? "" } as ModelCatalogFacts }, ...known] : known;
    const options: AgentConfigOption[] = [];
    // the roles models hold now; over RPC a choice switches this session's model (`set_model` keeps
    // role assignments as they are), so only the main scope takes one
    const holders = new Map<string, string>();
    for (const entry of known) for (const role of entry.catalog.roles ?? []) if (!holders.has(role.role)) holders.set(role.role, entry.name);
    const scopes = Object.entries(MODEL_ROLE_NAMES)
      .filter(([role]) => role === "default" || holders.has(role))
      .map(([role, name]) => ({ id: role, name, enabled: role === "default", ...(role === "default" ? { current: string(model.name) ?? id ?? current } : holders.has(role) ? { current: holders.get(role)! } : {}) }));
    if (current)
      options.push({
        id: "model",
        name: "모델",
        category: "model",
        type: "select",
        currentValue: current,
        options: models.map((entry) => ({ value: entry.value, name: entry.name, group: entry.group, kind: "model" as const, catalog: entry.catalog })),
        ...(known.length > 0 ? { scopes } : {}),
      });
    const levels = Array.isArray(state.thinkingLevels) ? state.thinkingLevels.filter((level): level is string => typeof level === "string") : [];
    const level = string(state.configuredThinkingLevel, state.thinkingLevel);
    if (levels.length > 0 && level)
      options.push({ id: "thinking", name: "생각", category: "thought_level", type: "select", currentValue: level, options: levels.map((entry) => ({ value: entry, name: entry })) });
    return options;
  }

  // ---- model, thinking, compaction, queue, side questions

  async setSessionConfig(sessionId: string, configId: string, value: string): Promise<void> {
    const client = await this.ensureProcess(sessionId);
    if (configId === "model") {
      const at = value.indexOf("/");
      if (at <= 0 || at === value.length - 1) throw new Error(`Model must be provider/id: ${value}`);
      await client.call({ type: "set_model", provider: value.slice(0, at), modelId: value.slice(at + 1) });
    } else if (configId === "thinking") {
      await client.call({ type: "set_thinking_level", level: value });
    } else throw new AgentUnsupportedError(`the ${configId} setting`, sessionId);
    await this.refreshState(sessionId, client);
  }

  async cycleThinking(sessionId: string): Promise<string | undefined> {
    const client = await this.ensureProcess(sessionId);
    const data = await client.call<{ level?: unknown } | null>({ type: "cycle_thinking_level" });
    await this.refreshState(sessionId, client);
    return typeof data?.level === "string" ? data.level : undefined;
  }

  async refreshRuntimeState(sessionId: string): Promise<never> {
    throw new AgentUnsupportedError("GJC's runtime state", sessionId);
  }

  /** `compact`: omp folds the conversation into a summary it records in the session file. */
  async compactSession(sessionId: string): Promise<void> {
    const client = await this.ensureProcess(sessionId);
    await client.call({ type: "compact" }, 0);
    this.scheduleResync(sessionId);
  }

  async steerSession(sessionId: string, input: ResolvedMessageInput): Promise<MessageDelivery> {
    if (!this.chat(sessionId).working) return this.sendMessage(sessionId, input);
    const client = await this.ensureProcess(sessionId);
    const images = await this.images(input);
    await client.call({ type: "steer", message: this.promptText(input.text.trim(), input), ...(images ? { images } : {}) });
    return "steer";
  }

  async queueFollowUp(sessionId: string, input: ResolvedMessageInput): Promise<MessageDelivery> {
    if (!this.chat(sessionId).working) return this.sendMessage(sessionId, input);
    const client = await this.ensureProcess(sessionId);
    const images = await this.images(input);
    await client.call({ type: "follow_up", message: this.promptText(input.text.trim(), input), ...(images ? { images } : {}) });
    return "prompt";
  }

  async listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    const { steering, followUp } = this.chat(sessionId).queue;
    return [
      ...steering.map((text, index): QueuedMessage => ({ id: `steer-${index}`, text, mode: "steer", label: text })),
      ...followUp.map((text, index): QueuedMessage => ({ id: `follow-${index}`, text, mode: "followUp", label: text })),
    ];
  }

  /** Delivers omp's queue now: the running turn stops and the queued messages go in (`abort_and_deliver_queue`). */
  async flushQueuedNow(sessionId: string): Promise<boolean> {
    const client = this.client(sessionId);
    if (!client) return false;
    const data = await client.call<{ aborted?: unknown }>({ type: "abort_and_deliver_queue" });
    return data?.aborted === true;
  }

  async controlRetry(sessionId: string, action: "now" | "abort"): Promise<void> {
    if (action !== "abort") throw new AgentUnsupportedError("retrying at once", sessionId);
    await this.client(sessionId)?.call({ type: "abort_retry" });
  }

  /** `/btw`: omp answers from the conversation without adding to it, as `btw_record` frames. */
  async askSideQuestion(sessionId: string, question: string): Promise<string> {
    const client = await this.ensureProcess(sessionId);
    const data = record(await client.call({ type: "btw", question }));
    const started = record(data.record);
    const id = string(started.id);
    if (!id) throw new Error("omp did not start the side question");
    const first = sideTurn(started);
    if (first.status === "complete") return first.answer;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sideQuestions.delete(id);
        void client.call({ type: "btw_cancel", recordId: id }).catch(() => undefined);
        reject(new Error("The side question took too long"));
      }, SIDE_QUESTION_TIMEOUT_MS);
      timer.unref?.();
      this.sideQuestions.set(id, { resolve, reject, timer });
    });
  }

  /** The open cards of a chat whose turn ended or whose omp went away: nothing will read their answers. */
  protected closeCards(sessionId: string, _reason: "ended" | "exited"): void {
    for (const [requestId, pending] of [...this.pendingUi]) if (pending.sessionId === sessionId) this.closeDialog(requestId, "closed");
    this.pairedCalls.delete(sessionId);
  }

  /** Whether the chat waits on the user (an approval or a question). */
  protected waitingOnUser(sessionId: string): boolean {
    for (const pending of this.pendingUi.values()) if (pending.sessionId === sessionId) return true;
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
    chat.compacting = false;
    chat.retry = undefined;
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
    // a question read back is the ask tool's row in the file; one still open stays
    if (item.kind === "question") return item.answerable && (item.status === "pending" || item.status === "rejected");
    if (item.kind === "tool" && item.id.startsWith(`${sessionId}:ui:`)) return item.status === "approval-required";
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
        queue: { steering: [], followUp: [] },
        compacting: false,
      };
      this.chats.set(sessionId, chat);
    }
    return chat;
  }

  protected client(sessionId: string): OmpRpcClient | undefined {
    const client = this.chats.get(sessionId)?.client;
    return client && !client.exited ? client : undefined;
  }

  /** Attachments go with the prompt: pictures as omp's images, other files named by their path. */
  protected checkAttachments(_sessionId: string, _input: ResolvedMessageInput): void {}

  private async images(input: ResolvedMessageInput): Promise<{ type: "image"; data: string; mimeType: string }[] | undefined> {
    if (input.images.length === 0) return undefined;
    return Promise.all(
      input.images.map(async (image) => ({
        type: "image" as const,
        data: image.data || (image.nativePath ? (await readFile(image.nativePath)).toString("base64") : ""),
        mimeType: image.mimeType,
      })),
    );
  }

  /** The message as omp takes it: the text, and the path of each attached file for its tools to read. */
  private promptText(text: string, input: ResolvedMessageInput): string {
    if (input.files.length === 0) return text;
    return [text, ...input.files.map((attached) => `Attached file: ${attached.nativePath}`)].filter(Boolean).join("\n\n");
  }

  // ---- rows

  /** What a chat offers now: omp's RPC chat ceiling (agent-catalog.ts) less what is not wired yet. */
  protected capabilities(_record: OmpRpcSessionRecord): SessionCapabilities {
    const entry = agentCatalogEntry("omp");
    const ceiling = entry.chatCapabilities ?? entry.capabilities;
    return { ...ceiling };
  }

  protected applyStatus(sessionId: string, status: SessionStatus, activity?: "completed" | "failed" | "permission"): void {
    this.setStatusNow(sessionId, (status === "idle" || status === "running") && this.waitingOnUser(sessionId) ? "waiting" : status, activity);
  }

  private setStatusNow(sessionId: string, effective: SessionStatus, activity?: "completed" | "failed" | "permission"): void {
    const record = this.options.store.get(sessionId);
    if (!record) return;
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
    const chat = this.chats.get(session.id);
    const live: Partial<AgentSession> = {
      ...(chat?.compacting ? { phase: "compacting" } : {}),
      ...(chat?.retry ? { retry: chat.retry } : {}),
    };
    const state = chat?.state;
    if (!state) return live;
    const model = record(state.model);
    const provider = string(model.provider);
    const id = string(model.id);
    const usage = record(state.contextUsage);
    const thinking = string(state.configuredThinkingLevel, state.thinkingLevel);
    return {
      ...live,
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

function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** The latest turn of a side-question topic: its last follow-up, or the record itself. */
function sideTurn(entry: Record<string, unknown>): { status: string; answer: string; error?: string } {
  const followUps = Array.isArray(entry.followUps) ? entry.followUps.map(record) : [];
  const turn = followUps.at(-1) ?? entry;
  return {
    status: string(turn.status) ?? "running",
    answer: string(turn.answer) ?? "",
    ...(string(turn.error) ? { error: string(turn.error) } : {}),
  };
}

function dropOptions(tool: ToolActivity): ToolActivity {
  if (!tool.permissionOptions) return tool;
  const { permissionOptions: _options, ...rest } = tool;
  return rest;
}

/** One card's answer as omp's dialog takes it, or why it cannot be one. */
function cardAnswer(shape: QuestionShape, submission: QuestionSubmission): { value: unknown; summary: string } | { error: string } {
  const custom = submission.custom?.trim();
  const selected = submission.selected;
  const summary = custom || selected.join(", ");
  switch (shape.kind) {
    case "form": {
      const value = formValue(shape.field, selected, custom);
      return "error" in value ? value : { value: value.value, summary };
    }
    case "ask": {
      const chosen = custom ? [] : selected.filter((label) => shape.labels.includes(label));
      if (!custom && chosen.length === 0) return { error: "하나를 골라 주세요" };
      return { value: { id: shape.id, selectedOptions: shape.multi ? chosen : chosen.slice(0, 1), ...(custom ? { customInput: custom } : {}) }, summary };
    }
    case "select": {
      const value = custom || selected[0];
      return value ? { value, summary } : { error: "하나를 골라 주세요" };
    }
    case "confirm": {
      if (selected[0] === YES) return { value: true, summary: YES };
      if (selected[0] === NO) return { value: false, summary: NO };
      return { error: "예 또는 아니요를 골라 주세요" };
    }
    case "input":
      return custom ? { value: custom, summary } : { error: "답을 입력해 주세요" };
  }
}

/** The `extension_ui_response` body of a dialog whose cards all have their answers. */
function dialogResponse(pending: PendingQuestion): Record<string, unknown> {
  const answers = pending.cards.map((card) => card.answer!.value);
  switch (pending.method) {
    case "form": {
      const data: Record<string, unknown> = {};
      pending.cards.forEach((card, index) => {
        if (card.shape.kind === "form") data[card.shape.field.name] = answers[index];
      });
      return { data };
    }
    case "ask":
      return { answers };
    case "confirm":
      return { confirmed: answers[0] === true };
    default:
      return { value: String(answers[0] ?? "") };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
