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
  ContextBreakdown,
  CreateSessionInput,
  DiffSnapshot,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  MessageDelivery,
  NoticeActivity,
  QueuedMessage,
  QuestionActivity,
  RuntimeModeId,
  RuntimeModeState,
  SessionLiveStatus,
  SessionTreeEntry,
  SessionUsageStats,
  SubagentMessage,
  SubagentSnapshot,
  TodoSnapshotPhase,
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
import { bounded, clockLabel, record, string, stripTerminalControls, toolRow, TranscriptRows } from "../herdr-core/transcript/transcript-records.js";
import { TranscriptFollower } from "../herdr-core/transcript/transcripts.js";
import { parseContextReport } from "./context-report.js";
import { commitChanges, getGitStatus, pushChanges, stageFiles, unstageFiles, type GitScope } from "../gjc-sdk-git.js";
import { workspaceDiff } from "../herdr-core/workspace-diff.js";
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
  /** When the running turn began, for the status line. */
  turnStartedAt?: number;
  /** What the turn does now, as the status line names it. */
  activity?: string;
  /** How long each thought read back from the file was watched streaming (by file row id). */
  thoughtDurations: Map<string, number>;
  /** omp's subagents as its progress frames report them (`set_subagent_subscription`). */
  subagents: Map<string, Record<string, unknown>>;
  /** Calls reading a slash command's `command_output` themselves; the chat shows none meanwhile. */
  readingOutput: number;
  /** omp's goal as last read. */
  goal?: GoalSnapshot;
  /** Auto-retry as last set here: `get_state` does not report it. */
  autoRetry?: boolean;
  /** The row of the user's `!` command omp is running (one at a time, as in omp's TUI). */
  userShell?: string;
  shellRuns: number;
}

/** A side question waiting for its answer (`btw`). */
interface PendingSideQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** What omp's `goal` command does to a goal; it has no "complete". */
const GOAL_OPERATIONS: GoalOperation[] = ["pause", "resume", "drop"];
const NO_GOAL: GoalSnapshot = { enabled: false, completed: 0, total: 0, operations: GOAL_OPERATIONS };

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
  /** Renames that wait for the chat's omp to start. */
  private readonly pendingNames = new Map<string, string>();
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

  /** Renames the row and omp's session (`set_session_name`), now or when its omp next starts. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.options.store.rename(sessionId, title);
    this.emitUpdated(sessionId);
    const client = this.client(sessionId);
    if (!client) {
      if (this.options.store.get(sessionId)) this.pendingNames.set(sessionId, title);
      return;
    }
    await client
      .call({ type: "set_session_name", name: title })
      .catch((error: unknown) => this.log(`could not name omp's session ${sessionId}`, error));
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
    // `!command` runs in omp's shell (RPC `bash`), `!!command` keeps its output out of the model's context
    const shell = /^(!!?)([\s\S]*)$/u.exec(text);
    if (shell && shell[2]!.trim() && input.images.length === 0 && input.files.length === 0)
      return this.runUserShell(sessionId, shell[2]!.trim(), shell[1] === "!!");
    // `/goal` is omp's TUI command; over RPC it is the `goal` command
    const goal = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text);
    if (goal && input.images.length === 0 && input.files.length === 0) return this.goalCommand(sessionId, goal[1]?.trim() ?? "");
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
    let ack: { agentInvoked?: unknown } | undefined;
    try {
      ack = (await prompt.accepted) as { agentInvoked?: unknown } | undefined;
    } catch (error) {
      chat.working = wasWorking;
      throw error;
    }
    // a slash command omp answered itself (`/context`, `/session`): no turn, no prompt_result
    if (ack?.agentInvoked === false) {
      chat.working = wasWorking;
      if (!wasWorking) chat.turnFileRevision = undefined;
      return "prompt";
    }
    this.options.store.touch(sessionId);
    chat.turnStartedAt ??= Date.now();
    if (!wasWorking) this.applyStatus(sessionId, "running");
    return wasWorking && steer ? "steer" : "prompt";
  }

  // ---- subagents (19.1.1 `cancel_subagent`, `steer_subagent`, `get_subagent_messages`)

  async cancelSubagent(sessionId: string, subagentId: string): Promise<boolean> {
    const client = this.client(sessionId);
    if (!client) return false;
    const data = record(await client.call({ type: "cancel_subagent", subagentId }));
    return data.cancelled === true;
  }

  async steerSubagent(sessionId: string, subagentId: string, message: string): Promise<void> {
    const client = this.client(sessionId);
    if (!client) throw new Error("omp is not running for this chat");
    await client.call({ type: "steer_subagent", subagentId, message: message.trim() });
  }

  /** The subagent's session file as omp reads it, its messages cut to what a panel shows. */
  async getSubagentMessages(sessionId: string, subagentId: string): Promise<SubagentMessage[]> {
    const client = await this.ensureProcess(sessionId);
    const data = record(await client.call({ type: "get_subagent_messages", subagentId }));
    return subagentMessages(data.messages);
  }

  // ---- omp's queue (19.1.1 `promote_queued_message`, `remove_queued_message`)

  /** A queued follow-up goes to steering: the running turn reads it at its next step. */
  async promoteQueuedMessage(sessionId: string, text: string): Promise<boolean> {
    const client = this.client(sessionId);
    if (!client) return false;
    return record(await client.call({ type: "promote_queued_message", message: text })).promoted === true;
  }

  async removeQueuedMessage(sessionId: string, text: string, mode: QueuedMessage["mode"]): Promise<boolean> {
    const client = this.client(sessionId);
    if (!client) return false;
    const data = record(await client.call({ type: "remove_queued_message", message: text, queue: mode === "steer" ? "steering" : "followUp" }));
    return data.removed === true;
  }

  // ---- switches (19.1.1 `set_fast_mode`, `set_slow_mode`, `set_auto_compaction`, `set_auto_retry`)

  async setRuntimeMode(sessionId: string, mode: RuntimeModeId, enabled: boolean): Promise<void> {
    const client = await this.ensureProcess(sessionId);
    const type = { fast: "set_fast_mode", slow: "set_slow_mode", autoCompaction: "set_auto_compaction", autoRetry: "set_auto_retry" }[mode];
    await client.call({ type, enabled });
    if (mode === "autoRetry") this.chat(sessionId).autoRetry = enabled;
    await this.refreshState(sessionId, client);
  }

  /** `get_session_stats`: cost, tokens and requests of the session so far (no model call). */
  async getSessionStats(sessionId: string): Promise<SessionUsageStats> {
    const client = await this.ensureProcess(sessionId);
    const data = record(await client.call({ type: "get_session_stats" }));
    const tokens = record(data.tokens);
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
      costUsd: count(data.cost),
      tokens: {
        input: count(tokens.input),
        output: count(tokens.output),
        reasoning: count(tokens.reasoning),
        cacheRead: count(tokens.cacheRead),
        cacheWrite: count(tokens.cacheWrite),
        total: count(tokens.total),
      },
      requests: count(data.assistantMessages),
      userMessages: count(data.userMessages),
      toolCalls: count(data.toolCalls),
      premiumRequests: count(data.premiumRequests),
    };
  }

  // ---- the user's shell (19.1.1 `bash`, `abort_bash`)

  /**
   * A command the user typed as `!command`: omp runs it in the session's folder and records it in
   * the session (`bashExecution`), into the model's context unless `excluded` (`!!`). omp's RPC
   * returns the result when it ends, with no output on the way, so the card shows it running until
   * then, with a stop button (`abort_bash`). One at a time, as omp's TUI allows.
   */
  private async runUserShell(sessionId: string, command: string, excluded: boolean): Promise<MessageDelivery> {
    const client = await this.ensureProcess(sessionId);
    const chat = this.chat(sessionId);
    if (chat.userShell) throw new Error("셸 명령이 이미 실행 중입니다. 먼저 멈추세요.");
    chat.shellRuns += 1;
    const rowId = `${sessionId}:ui:shell-${Date.now().toString(36)}-${chat.shellRuns}`;
    const startedAt = Date.now();
    const row: ToolActivity = {
      ...toolRow(new TranscriptRows(sessionId), rowId, "bash", { command }, command.slice(0, 120), startedAt),
      status: "running",
      stoppable: true,
      userShell: excluded ? { excludedFromContext: true } : {},
    };
    chat.userShell = rowId;
    this.emitLive(sessionId, chat.live.put(row));
    const finish = (change: (tool: ToolActivity) => ToolActivity): void => {
      if (chat.userShell === rowId) chat.userShell = undefined;
      this.emitLive(sessionId, chat.live.updateTool(rowId, (tool) => {
        const { stoppable: _stoppable, ...rest } = change(tool);
        return { ...rest, durationMs: Date.now() - startedAt };
      }));
      // omp writes the command's record into the session file now, or after the turn it ran beside
      this.scheduleResync(sessionId);
    };
    void client.call<Record<string, unknown>>({ type: "bash", command, ...(excluded ? { excludeFromContext: true } : {}) }, 0).then(
      (result) => {
        const data = record(result);
        const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
        const output = string(data.output);
        finish((tool) => ({
          ...tool,
          status: data.cancelled === true ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
          ...(output ? { output: bounded(output) } : {}),
        }));
      },
      (error: unknown) => finish((tool) => ({ ...tool, status: "failed", output: error instanceof Error ? error.message : String(error) })),
    );
    return "prompt";
  }

  /** Stops the user's running `!` command; its card ends as cancelled when omp answers. */
  async abortUserShell(sessionId: string): Promise<void> {
    await this.client(sessionId)?.call({ type: "abort_bash" });
  }

  // ---- the conversation's tree (19.1.1 `get_tree`, `fork`, `branch`)

  async getSessionTree(sessionId: string): Promise<SessionTreeEntry[]> {
    const client = await this.ensureProcess(sessionId);
    const [data, branch] = await Promise.all([client.call({ type: "get_tree" }), client.call({ type: "get_branch_messages" })]);
    // omp's own list of the user messages a rewrite can start from (every branch: getUserMessagesForBranching)
    const onBranch = new Set(
      (Array.isArray(record(branch).messages) ? (record(branch).messages as unknown[]).map(record) : []).flatMap((message) => (string(message.entryId) ? [string(message.entryId)!] : [])),
    );
    return flattenSessionTree(record(data).tree, string(record(data).leafId), onBranch);
  }

  /**
   * A new chat on a copy of this one, to its end or to `entryId`. omp forks the session it has
   * open into a new file and moves to it, so the copy is made by an omp of the new chat's own,
   * started on the source file; the source chat's omp is not touched.
   */
  async forkSession(input: { sourceSessionId: string; title?: string; entryId?: string }): Promise<AgentSession> {
    const source = this.options.store.get(input.sourceSessionId);
    if (!source) throw new AgentUnsupportedError("forking", input.sourceSessionId);
    // omp writes its file with the first message; before that there is nothing to copy
    if (!source.sessionFile || !(await exists(source.sessionFile))) throw new Error("This chat has nothing to fork yet");
    const created = this.options.store.create({
      title: input.title?.trim() || `${source.title} (포크)`,
      workspace: source.workspace,
      ...(source.launch ? { launch: source.launch } : {}),
      parentId: source.id,
    });
    this.options.store.reportSession(created.id, { sessionFile: source.sessionFile });
    try {
      const client = await this.ensureProcess(created.id);
      const data = record(await client.call({ type: "fork", ...(input.entryId ? { entryId: input.entryId } : {}) }));
      if (data.cancelled === true) throw new Error("omp did not fork the chat");
      await this.refreshState(created.id, client);
      if (this.options.store.get(created.id)?.sessionFile === source.sessionFile) throw new Error("omp stayed on the source session");
    } catch (error) {
      this.stopProcess(created.id);
      this.chats.delete(created.id);
      this.options.store.delete(created.id);
      throw error;
    }
    this.options.claim?.(created.id);
    const session = this.row(this.options.store.get(created.id)!);
    this.options.emit({ type: "session.created", session });
    return session;
  }

  /**
   * `navigate_tree`: omp moves the leaf of this chat's tree to `entryId` without writing a line
   * until the next record, so the file's reader is told the leaf omp now holds (`get_tree`) and
   * shows that branch only. A user message moves the leaf to before it and hands back its text.
   */
  async navigateSessionTree(sessionId: string, entryId: string): Promise<string> {
    const client = await this.ensureProcess(sessionId);
    const data = record(await client.call({ type: "navigate_tree", entryId }));
    if (data.cancelled === true) throw new Error("omp did not move in the tree");
    const tree = record(await client.call({ type: "get_tree" }));
    const chat = this.chat(sessionId);
    chat.follower.setLeaf(typeof tree.leafId === "string" ? tree.leafId : null);
    await this.refreshState(sessionId, client).catch(() => undefined);
    this.scheduleResync(sessionId);
    return string(data.editorText) ?? "";
  }

  // ---- the session's folder (git status and changes, as GJC's panel shows them; reads only)

  /** What `git diff HEAD` and the untracked files show in the chat's folder (herdr's workspace-diff). */
  async getDiff(sessionId: string): Promise<DiffSnapshot> {
    const record = this.options.store.get(sessionId);
    if (!record) throw new AgentUnsupportedError("reading changes", sessionId);
    return workspaceDiff(sessionId, record.workspace);
  }

  /**
   * The chat folder's git status through GJC's own reader. Staging, committing and pushing go
   * through it too, which allows them only in a managed worktree; an omp chat has none, so they
   * are refused as they are for a GJC session outside one.
   */
  private gitScope(sessionId: string): GitScope {
    const record = this.options.store.get(sessionId);
    if (!record) throw new AgentUnsupportedError("git", sessionId);
    return { workspace: record.workspace, sessions: new Map([[sessionId, this.row(record)]]), sessionCwds: new Map([[sessionId, record.workspace]]) };
  }

  async getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    return getGitStatus(this.gitScope(sessionId), sessionId);
  }

  async stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return stageFiles(this.gitScope(sessionId), sessionId, paths);
  }

  async unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return unstageFiles(this.gitScope(sessionId), sessionId, paths);
  }

  async commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot> {
    return commitChanges(this.gitScope(sessionId), sessionId, message);
  }

  async pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return pushChanges(this.gitScope(sessionId), sessionId);
  }

  /** `export_html`: omp renders the session file as one HTML page at the path given. */
  async exportSessionHtml(sessionId: string, outputPath: string): Promise<string> {
    const client = await this.ensureProcess(sessionId);
    const data = record(await client.call({ type: "export_html", outputPath }, 120_000));
    const written = string(data.path);
    if (!written) throw new Error("omp did not say where it saved the page");
    return written;
  }

  // ---- goal mode (19.1.1 `goal`: get, create, resume, pause, drop)

  /** omp's goal for the goal row; a chat whose omp is not running reads as the last one seen. */
  async getGoal(sessionId: string): Promise<GoalSnapshot> {
    const client = this.client(sessionId);
    const chat = this.chats.get(sessionId);
    if (!client || !chat) return chat?.goal ?? NO_GOAL;
    return this.goalSnapshot(sessionId, await client.call({ type: "goal", op: "get" }));
  }

  async operateGoal(sessionId: string, operation: GoalOperation): Promise<GoalSnapshot> {
    // omp ends a goal itself (its goal tool reports it complete); a host can only drop it
    if (operation === "complete") throw new AgentUnsupportedError("completing a goal", sessionId);
    const client = await this.ensureProcess(sessionId);
    return this.goalSnapshot(sessionId, await client.call({ type: "goal", op: operation }));
  }

  /** `/goal [set] <objective>`, `/goal pause|resume|drop|show` typed in the composer. */
  private async goalCommand(sessionId: string, args: string): Promise<MessageDelivery> {
    const client = await this.ensureProcess(sessionId);
    const [word = "", ...rest] = args.split(/\s+/u);
    const op = word.toLowerCase();
    if (!args || op === "show") {
      const goal = this.goalSnapshot(sessionId, await client.call({ type: "goal", op: "get" }));
      this.addNotice(sessionId, "goal", goal.enabled ? `${goal.objective} (${goal.mode})` : "진행 중인 목표가 없습니다", "neutral");
      return "prompt";
    }
    if (op === "pause" || op === "resume" || op === "drop") {
      this.goalSnapshot(sessionId, await client.call({ type: "goal", op }));
      return "prompt";
    }
    if (op === "budget") return { kind: "not_executed", detail: "omp RPC는 목표의 토큰 예산을 바꾸지 않습니다" };
    const objective = op === "set" ? rest.join(" ").trim() : args;
    if (!objective) throw new Error("목표를 적어 주세요: /goal <목표>");
    this.goalSnapshot(sessionId, await client.call({ type: "goal", op: "create", objective }, 0));
    return "prompt";
  }

  /** omp's goal (`RpcGoalResult`) as the goal row shows it, with the todo list it works through. */
  private goalSnapshot(sessionId: string, data: unknown): GoalSnapshot {
    const goal = record(record(data).goal);
    const objective = string(goal.objective);
    const status = string(goal.status);
    const chat = this.chat(sessionId);
    let snapshot: GoalSnapshot = NO_GOAL;
    if (objective && status && status !== "dropped") {
      const tasks = todoPhases(chat.state?.todoPhases).flatMap((phase) => phase.tasks);
      snapshot = {
        enabled: true,
        // a goal over its token budget stops like a finished one: only dropping it is left
        mode: status === "paused" ? "paused" : status === "active" ? "active" : "complete",
        objective,
        completed: tasks.filter((task) => task.status === "completed" || task.status === "done").length,
        total: tasks.length,
        ...(tasks.length > 0 ? { tasks } : {}),
        operations: GOAL_OPERATIONS,
      };
    }
    chat.goal = snapshot;
    return snapshot;
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
    // a fresh omp holds the file's leaf: a navigation the last one made is gone with it
    chat.follower.setLeaf(undefined);
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
  protected async configure(sessionId: string, client: OmpRpcClient): Promise<void> {
    await client.call({ type: "set_ask_dialog", enabled: true }).catch(() => undefined);
    // a rename made while omp was not running
    const name = this.pendingNames.get(sessionId);
    if (name !== undefined) {
      this.pendingNames.delete(sessionId);
      await client.call({ type: "set_session_name", name }).catch(() => undefined);
    }
    // subagents report their progress as frames of their own (rpc-subagents.ts)
    await client.call({ type: "set_subagent_subscription", level: "progress" }).catch(() => undefined);
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
    this.noteActivity(sessionId);
    switch (frame.type) {
      case "agent_start":
        if (!chat.working) {
          chat.working = true;
          chat.turnFileRevision ??= chat.follower.revision();
        }
        chat.turnStartedAt ??= Date.now();
        this.applyStatus(sessionId, "running");
        break;
      case "tool_execution_end":
        // the todo tool changes the list the status line counts
        if (frame.toolName === "todo") this.refreshStateSoon(sessionId, client);
        break;
      case "subagent_lifecycle":
      case "subagent_progress":
        this.noteSubagent(sessionId, record(frame.payload));
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
    const note =
      decision.rule && allows
        ? `"${decision.rule.prefix}"로 시작하는 명령은 이 프로젝트에서 앞으로 묻지 않고 허용합니다.`
        : choice.option.kind === "allow_session" && !choice.option.grant
          ? `이 세션에서 ${this.pendingApprovalTool(toolId)}는 다시 묻지 않습니다.`
          : undefined;
    return { name: note ? `${label}\n${note}` : label, requiresConfirmation: allows };
  }

  /**
   * Answers an approval card with omp's own option, remembering a command prefix for the project
   * first when asked to. A rule that cannot be saved must not leave omp waiting: the call is
   * answered either way and the save error is thrown afterwards. omp's select takes only a label,
   * so a rejection's comment reaches the agent as a steering message, read right after the call
   * omp refuses ("Tool call denied by user"). A session or grant answer is omp's to remember: it
   * asks no more for what it covers, whichever window or phone gave the answer.
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
    if (!allows && decision.comment)
      await pending.client
        .call({ type: "steer", message: `[${pending.toolName} 거절 사유] ${decision.comment}` })
        .catch((error: unknown) => this.log(`could not pass the rejection reason to ${pending.sessionId}`, error));
    if (ruleFailure) throw ruleFailure;
  }

  private pendingApprovalTool(toolId: string): string {
    return [...this.pendingUi.values()].find((entry): entry is PendingApproval => entry.kind === "approval" && entry.rowId === toolId)?.toolName ?? "이 도구";
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
        // the row's queue list follows it
        this.bump(sessionId);
        this.emitUpdated(sessionId);
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
      case "command_output":
        // what a slash command omp answers itself printed, unless a call is reading it
        if (chat.readingOutput === 0 && typeof frame.text === "string" && frame.text.trim())
          this.addNotice(sessionId, "omp", stripTerminalControls(frame.text).trimEnd(), "neutral");
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

  /** What the turn does now, from its live rows: the running tool, else thinking or writing. */
  private noteActivity(sessionId: string): void {
    const chat = this.chat(sessionId);
    if (!chat.working) return;
    const rows = chat.live.items();
    let activity: string | undefined;
    for (let index = rows.length - 1; index >= 0 && activity === undefined; index -= 1) {
      const item = rows[index]!;
      if (item.kind === "tool" && (item.status === "running" || item.status === "pending" || item.status === "approval-required"))
        activity = item.description && item.description !== item.name ? `${item.name} · ${item.description}` : item.name;
      else if (item.kind === "thought" && item.streaming) activity = "생각하는 중";
      else if (item.kind === "message" && item.role === "assistant" && item.streaming) activity = "답을 쓰는 중";
    }
    if (activity === chat.activity) return;
    chat.activity = activity;
    this.bump(sessionId);
    this.emitUpdated(sessionId);
  }

  /** One subagent's lifecycle or progress frame (`subagent_lifecycle`, `subagent_progress`). */
  private noteSubagent(sessionId: string, payload: Record<string, unknown>): void {
    const id = string(payload.id, payload.subagentId, record(payload.progress).id);
    if (!id) return;
    const chat = this.chat(sessionId);
    chat.subagents.set(id, { ...(chat.subagents.get(id) ?? {}), ...payload, seenAt: Date.now() });
  }

  /** omp's subagents in this chat: the ones it reported this run, and the ones it still lists. */
  async listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    const chat = this.chat(sessionId);
    const client = this.client(sessionId);
    if (client) {
      const data = await client.call<{ subagents?: unknown }>({ type: "get_subagents" }).catch(() => undefined);
      for (const entry of Array.isArray(data?.subagents) ? data.subagents.map(record) : []) {
        const id = string(entry.id);
        if (id) chat.subagents.set(id, { ...(chat.subagents.get(id) ?? {}), ...entry });
      }
    }
    return [...chat.subagents.entries()].map(([id, entry]) => subagentSnapshot(id, entry));
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
    // `!` runs a shell command (RPC `bash`): listed so the composer sends it at once, as a control
    if (!commands.some((command) => command.name === "!"))
      commands.push({ name: "!", description: "셸 명령 실행 (!!: 모델 컨텍스트에 넣지 않음)", hint: "<명령>" });
    // `/goal` is TUI-only in omp; this chat sends it as the `goal` command
    if (!commands.some((command) => command.name === "goal"))
      commands.push({ name: "goal", description: "목표 모드: 목표 정하기, pause, resume, drop", hint: "[set] <목표>" });
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

  /**
   * `/context`: what fills the context window, by category. omp 19.1.1 has no RPC command
   * for it, but answers the slash command itself, without a model call or a line in the
   * session file, as one `command_output` frame before the prompt's response.
   */
  async getContextBreakdown(sessionId: string): Promise<ContextBreakdown | null> {
    const client = await this.ensureProcess(sessionId);
    const chat = this.chat(sessionId);
    let text: string | undefined;
    const stop = client.onFrame((frame) => {
      if (frame.type === "command_output" && typeof frame.text === "string") text = frame.text;
    });
    chat.readingOutput += 1;
    try {
      await client.call({ type: "prompt", message: "/context" });
    } finally {
      stop();
      chat.readingOutput -= 1;
    }
    const report = text === undefined ? null : parseContextReport(text);
    // the same moment's model and auto-compaction setting, and a fresh share for the bar
    await this.refreshState(sessionId, client).catch(() => undefined);
    if (!report) return null;
    const state = this.chats.get(sessionId)?.state ?? {};
    const model = record(state.model);
    const name = string(model.name, model.id);
    const compacts = state.autoCompactionEnabled !== false && report.autoCompactBufferTokens > 0;
    return {
      ...report,
      ...(name ? { model: name } : {}),
      ...(compacts ? { autoCompactAtTokens: report.contextWindow - report.autoCompactBufferTokens } : {}),
    };
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
    return queuedMessages(this.chat(sessionId).queue);
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
    chat.turnStartedAt = undefined;
    chat.activity = undefined;
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
    chat.turnStartedAt = undefined;
    chat.activity = undefined;
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
    // A page read can already show the session file's copy of a prompt before omp's live
    // message_start arrives (omp writes the prompt first). Announcing the live row then
    // put the same request on screen twice until the next sync; composed() pairs the two,
    // so the event is already covered by the file's row.
    const filePrompts = new Map<string, number>();
    for (const item of chat.fileRows) {
      const key = promptKey(item);
      if (key !== undefined) filePrompts.set(key, (filePrompts.get(key) ?? 0) + 1);
    }
    const livePrompts = new Map<string, number>();
    for (const item of chat.live.items()) {
      const key = promptKey(item);
      if (key !== undefined) livePrompts.set(key, (livePrompts.get(key) ?? 0) + 1);
    }
    for (const event of events) {
      if (event.type === "transcript.appended") {
        const key = promptKey(event.item);
        if (key !== undefined && (filePrompts.get(key) ?? 0) >= (livePrompts.get(key) ?? 0)) continue;
      }
      this.options.emit(event);
    }
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
    // a thought watched streaming keeps how long it took once the file's row stands in for it
    const watched = chat.live.items().flatMap((item) => (item.kind === "thought" && isLiveRowId(sessionId, item.id) && item.durationMs !== undefined ? [item.durationMs] : []));
    if (watched.length > 0) {
      const fresh = chat.fileRows.filter((item) => item.kind === "thought" && !(chat.published ?? []).some((known) => known.id === item.id) && !chat.thoughtDurations.has(item.id));
      fresh.slice(-watched.length).forEach((item, index) => chat.thoughtDurations.set(item.id, watched[index]!));
    }
    const fileIds = new Set(chat.fileRows.map((item) => item.id));
    // a `!` command's card gives way to its record only once the file holds it: omp writes the
    // session file with the first reply, so a command run before that waits in memory
    const recorded = new Map<string, number>();
    for (const item of chat.fileRows)
      if (item.kind === "tool" && item.userShell && item.command) recorded.set(item.command, (recorded.get(item.command) ?? 0) + 1);
    const shellRecorded = (item: TranscriptItem): boolean => {
      if (item.kind !== "tool" || !item.userShell || !item.command || item.status === "running") return false;
      const left = recorded.get(item.command) ?? 0;
      if (left === 0) return false;
      recorded.set(item.command, left - 1);
      return true;
    };
    chat.live.retain((item) => !fileIds.has(item.id) && (item.kind === "tool" && item.userShell ? !shellRecorded(item) : this.keepAfterSync(sessionId, item)));
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
    const rows = chat.fileRows.map((item) => {
      const replaced = replacing.get(item.id) ?? item;
      const watched = replaced.kind === "thought" && replaced.durationMs === undefined ? chat.thoughtDurations.get(replaced.id) : undefined;
      return watched !== undefined && replaced.kind === "thought" ? { ...replaced, durationMs: watched } : replaced;
    });
    // omp names a prompt twice: the live RPC row (`msg-N`) and the session file's entry
    // id. Reading the file mid-turn therefore held the file's copy and the live copy at
    // once, and the same request appeared twice (in the transcript and in the recent
    // requests). Pair them by what both sides carry and count the file's copies, so two
    // genuinely repeated requests still keep both their rows.
    const recorded = new Map<string, number>();
    for (const item of chat.fileRows) {
      const key = promptKey(item);
      if (key !== undefined) recorded.set(key, (recorded.get(key) ?? 0) + 1);
    }
    for (const item of live) {
      if (fileIds.has(item.id)) continue;
      const key = promptKey(item);
      if (key !== undefined) {
        const left = recorded.get(key) ?? 0;
        if (left > 0) {
          recorded.set(key, left - 1);
          continue;
        }
      }
      rows.push(item);
    }
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
        thoughtDurations: new Map(),
        subagents: new Map(),
        readingOutput: 0,
        shellRuns: 0,
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
    const queued = chat ? queuedMessages(chat.queue) : [];
    if (!state)
      return chat?.turnStartedAt !== undefined || queued.length > 0
        ? {
            ...live,
            liveStatus: {
              ...(chat?.turnStartedAt !== undefined ? { turnStartedAtMs: chat.turnStartedAt } : {}),
              ...(chat?.activity ? { activity: chat.activity } : {}),
              ...(queued.length > 0 ? { queued } : {}),
            },
          }
        : live;
    const model = record(state.model);
    const provider = string(model.provider);
    const id = string(model.id);
    const usage = record(state.contextUsage);
    const thinking = string(state.configuredThinkingLevel, state.thinkingLevel);
    const todo = todoPhases(state.todoPhases);
    const liveStatus: SessionLiveStatus = {
      ...(chat?.turnStartedAt !== undefined ? { turnStartedAtMs: chat.turnStartedAt } : {}),
      ...(chat?.activity ? { activity: chat.activity } : {}),
      ...(todo.length > 0 ? { todo } : {}),
      ...(typeof usage.percent === "number" && Number.isFinite(usage.percent) ? { contextPercent: usage.percent } : {}),
      ...(typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? { contextTokens: usage.tokens } : {}),
      ...(typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? { contextWindow: usage.contextWindow } : {}),
      ...(queued.length > 0 ? { queued } : {}),
      modes: runtimeModes(state, chat?.autoRetry),
    };
    return {
      ...live,
      liveStatus,
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
      ...(record.parentId ? { parentId: record.parentId } : {}),
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

/**
 * Identity of a prompt both the live RPC turn and the session file carry. omp gives the
 * two sides different row ids (`msg-N` while it streams, the entry id once written), so
 * ids cannot tell that they are the same request; the minute it was sent and its text can.
 */
function promptKey(item: TranscriptItem): string | undefined {
  if (item.kind !== "message" || item.role !== "user") return undefined;
  return `${item.createdAt}\u0000${item.content}`;
}

/** omp's todo phases (`get_state.todoPhases`) as the status line's checklist. */
function todoPhases(value: unknown): TodoSnapshotPhase[] {
  return (Array.isArray(value) ? value.map(record) : []).flatMap((phase) => {
    const raw = Array.isArray(phase.tasks) ? phase.tasks : Array.isArray(phase.items) ? phase.items : [];
    const tasks = raw.flatMap((task) => {
      if (typeof task === "string") return [{ content: task, status: "pending" }];
      const entry = record(task);
      const content = string(entry.content, entry.text, entry.title);
      return content ? [{ content, ...(string(entry.status) ? { status: string(entry.status)! } : {}) }] : [];
    });
    const name = string(phase.name, phase.phase, phase.title);
    return tasks.length > 0 ? [{ ...(name ? { name } : {}), tasks }] : [];
  });
}

/** How much of an entry the tree shows. */
const TREE_PREVIEW_CHARS = 140;

/**
 * omp's `get_tree` (`SessionTreeNode`: an entry and its children) as the tree view's rows, in
 * reading order: messages, compactions and branch summaries, each with how many branches deep it
 * lies, whether it is on the branch from the root to `leafId`, and which entry that is. omp's
 * bookkeeping entries (model changes, custom records) are left out; their children are not.
 */
export function flattenSessionTree(value: unknown, leafId: string | undefined, branchable?: ReadonlySet<string>): SessionTreeEntry[] {
  const parents = new Map<string, string | undefined>();
  const visit = (nodes: unknown, parent: string | undefined): void => {
    for (const node of Array.isArray(nodes) ? nodes.map(record) : []) {
      const id = string(record(node.entry).id);
      if (id) parents.set(id, parent);
      visit(node.children, id ?? parent);
    }
  };
  visit(value, undefined);
  const path = new Set<string>();
  for (let id = leafId; id !== undefined && !path.has(id); id = parents.get(id)) path.add(id);
  const preview = (text: string) => {
    const line = text.replace(/\s+/gu, " ").trim();
    return line.length > TREE_PREVIEW_CHARS ? `${line.slice(0, TREE_PREVIEW_CHARS)}…` : line;
  };
  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content.map(record) : [])
          .filter((block) => block.type === "text")
          .map((block) => string(block.text) ?? "")
          .join(" ");
  const rows: SessionTreeEntry[] = [];
  const walk = (nodes: unknown, depth: number): void => {
    const list = Array.isArray(nodes) ? nodes.map(record) : [];
    // the branch the conversation is on reads first; the others indent under the fork point
    const ordered = [...list].sort((left, right) => Number(path.has(string(record(right.entry).id) ?? "")) - Number(path.has(string(record(left.entry).id) ?? "")));
    ordered.forEach((node, index) => {
      const entry = record(node.entry);
      const id = string(entry.id);
      const childDepth = depth + (list.length > 1 && index > 0 ? 1 : 0);
      const message = record(entry.message);
      let row: Omit<SessionTreeEntry, "depth" | "onPath" | "current" | "id"> | undefined;
      if (entry.type === "message" && message.role === "user") row = { role: "user", text: preview(textOf(message.content)) };
      else if (entry.type === "message" && message.role === "assistant") {
        const text = preview(textOf(message.content));
        const tools = (Array.isArray(message.content) ? message.content.map(record) : []).filter((block) => block.type === "toolCall").map((block) => string(block.name) ?? "tool");
        row = text ? { role: "assistant", text } : tools.length > 0 ? { role: "tool", text: tools.join(", ") } : undefined;
      } else if (entry.type === "compaction") row = { role: "compaction", text: preview(string(entry.summary) ?? "") };
      else if (entry.type === "branch_summary") row = { role: "branch_summary", text: preview(string(entry.summary) ?? "") };
      if (row && id)
        rows.push({
          id,
          ...row,
          depth: childDepth,
          onPath: path.has(id),
          ...(row.role === "user" && branchable?.has(id) ? { rewritable: true } : {}),
          current: id === leafId,
          ...(string(node.label) ? { label: string(node.label)! } : {}),
        });
      walk(node.children, childDepth);
    });
  };
  walk(value, 0);
  // the leaf is often a bookkeeping entry: mark the last shown entry on the path as where the chat is
  if (!rows.some((row) => row.current)) {
    const last = [...rows].reverse().find((row) => row.onPath);
    if (last) last.current = true;
  }
  return rows;
}

/** omp's switches as `get_state` reports them; auto-retry is not in it (omp's default is on). */
function runtimeModes(state: Record<string, unknown>, autoRetry: boolean | undefined): RuntimeModeState[] {
  const fast = state.fastModeEnabled === true;
  return [
    { id: "fast", enabled: fast, ...(fast && state.fastModeActive === false ? { inactive: true } : {}) },
    ...(state.slowModeSupported === true ? [{ id: "slow" as const, enabled: state.slowModeEnabled === true }] : []),
    { id: "autoCompaction", enabled: state.autoCompactionEnabled !== false },
    { id: "autoRetry", enabled: autoRetry ?? true, ...(autoRetry === undefined ? { assumed: true } : {}) },
  ];
}

/** omp's queue (`queue_update`) as the window lists it: steering first, then follow-ups. */
function queuedMessages(queue: { steering: string[]; followUp: string[] }): QueuedMessage[] {
  return [
    ...queue.steering.map((text, index): QueuedMessage => ({ id: `steer-${index}`, text, mode: "steer", label: text })),
    ...queue.followUp.map((text, index): QueuedMessage => ({ id: `follow-${index}`, text, mode: "followUp", label: text })),
  ];
}

/** How much of one message the subagents panel shows. */
const SUBAGENT_MESSAGE_CHARS = 2000;

/** omp's `AgentMessage`s (`get_subagent_messages`) as the panel's rows: text, tool calls and results. */
export function subagentMessages(value: unknown): SubagentMessage[] {
  const cut = (text: string) => (text.length > SUBAGENT_MESSAGE_CHARS ? `${text.slice(0, SUBAGENT_MESSAGE_CHARS)}…` : text);
  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content.map(record) : [])
          .filter((block) => block.type === "text")
          .map((block) => string(block.text) ?? "")
          .join("\n");
  return (Array.isArray(value) ? value.map(record) : []).flatMap((message): SubagentMessage[] => {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      return text ? [{ role: "user", text: cut(text) }] : [];
    }
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
      return blocks.flatMap((block): SubagentMessage[] => {
        if (block.type === "text" && string(block.text)?.trim()) return [{ role: "assistant", text: cut(string(block.text)!.trim()) }];
        if (block.type === "toolCall" && string(block.name)) {
          const args = record(block.arguments);
          const summary = string(args.command, args.path, args.file_path, args.pattern, args.description, args.url) ?? "";
          return [{ role: "tool", tool: string(block.name)!, text: cut(summary) }];
        }
        return [];
      });
    }
    if (message.role === "toolResult") {
      const text = textOf(message.content).trim();
      return [{ role: "tool", tool: string(message.toolName) ?? "tool", text: cut(text), ...(message.isError === true ? { error: true } : {}) }];
    }
    return [];
  });
}

/** A subagent as the panel lists it, from what omp reported (its snapshot and progress). */
function subagentSnapshot(id: string, entry: Record<string, unknown>): SubagentSnapshot {
  const progress = record(entry.progress);
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (progress[key] !== undefined) return progress[key];
      if (entry[key] !== undefined) return entry[key];
    }
    return undefined;
  };
  const raw = string(pick("status")) ?? "running";
  const status: SubagentSnapshot["status"] =
    raw === "completed" || raw === "done" ? "completed" : raw === "failed" || raw === "aborted" || raw === "error" ? "failed" : raw === "pending" || raw === "parked" || raw === "waiting" ? "waiting" : "running";
  const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const started = number(pick("startedAt", "startTime"));
  const ended = number(pick("endedAt", "endTime", "completedAt"));
  const duration = number(pick("durationMs", "elapsedMs"));
  const tools = pick("recentTools", "tools");
  const recentTool = Array.isArray(tools) ? tools.map((tool) => (typeof tool === "string" ? tool : string(record(tool).name, record(tool).tool))).filter(Boolean).at(-1) : undefined;
  const recent = string(pick("lastActivity", "activity", "currentTool", "lastMessage")) ?? recentTool;
  const model = pick("model");
  return {
    id,
    label: string(pick("agent", "name"), entry.description) ?? id,
    status,
    ...(string(entry.agentSource) ? { role: string(entry.agentSource)! } : {}),
    ...(string(pick("task", "assignment", "description")) ? { objective: string(pick("task", "assignment", "description"))!.slice(0, 400) } : {}),
    ...(typeof model === "string" ? { model } : string(record(model).id) ? { model: string(record(model).id)! } : {}),
    ...(number(pick("cost")) !== undefined ? { costUsd: number(pick("cost"))! } : {}),
    ...(number(pick("contextTokens", "tokens")) !== undefined ? { contextTokens: number(pick("contextTokens", "tokens"))! } : {}),
    ...(number(pick("contextWindow")) !== undefined ? { contextWindow: number(pick("contextWindow"))! } : {}),
    ...(number(pick("toolCount")) !== undefined ? { toolCount: number(pick("toolCount"))! } : {}),
    ...(duration !== undefined ? { elapsedMs: duration } : started !== undefined ? { elapsedMs: Math.max(0, (ended ?? Date.now()) - started) } : {}),
    ...(recent ? { recent: recent.slice(0, 200) } : {}),
    ...(string(entry.sessionFile) ? { sessionFile: string(entry.sessionFile)! } : {}),
  };
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
