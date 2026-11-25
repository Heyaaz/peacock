import type {
  AgentSession,
  ArtifactContent,
  BackendConnection,
  ContextBreakdown,
  RuntimeModeId,
  SubagentMessage,
  CreateSessionInput,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  MessageDelivery,
  QueuedMessage,
  QuestionActivity,
  QuestionSubmission,
  SubagentSnapshot,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
  WorkspaceFileIndex,
} from "../shared/agent-contract.js";
import type { GjcHostProcess } from "./gjc-host-process.js";
import type { ResolvedMessageInput, SendMessageOptions } from "./gjc-sdk-model.js";
import type { DeleteSessionOptions } from "./gjc-sdk-lifecycle.js";

/**
 * The calls every session runtime answers for its own sessions.
 *
 * The IPC handlers, remote access, parallel runs and productivity search reach
 * sessions through this and the facets below instead of through
 * `GjcSdkController`, so a second runtime can sit next to GJC behind
 * `AgentRouter` (docs/design/agent-runtime-herdr.md section 5.7).
 */
export interface AgentHost {
  getConnection(): Promise<BackendConnection>;
  reconnect(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** The title the session list shows, cut to one readable line. */
  sessionTitle(sessionId: string): string | undefined;
  hideSession(sessionId: string): void;
  deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  getTranscriptPage(
    sessionId: string,
    request?: TranscriptPageRequest,
  ): Promise<TranscriptPage>;
  getTranscriptChanges(sessionId: string): Promise<TranscriptChange>;
  getTranscriptRevision(sessionId: string): Promise<string | undefined>;
  watchTranscripts(sessionIds: readonly string[]): void;
  refreshSessionContext(sessionId: string): Promise<void>;
  sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<MessageDelivery>;
  cancelRun(sessionId: string): Promise<void>;
  markSessionRead(sessionId: string): Promise<void>;
  dispose(): void;
}

/** Messages held for the running turn: steering, follow-ups, and the queue. */
export interface AgentQueueFacet {
  steerSession(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: { echo?: boolean },
  ): Promise<MessageDelivery>;
  queueFollowUp(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery>;
  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
}

/**
 * Tool approval cards. The tool id carries no session id, so a router can only
 * place it once ids are namespaced (design section 5.7).
 */
export interface AgentApprovalFacet {
  toolDecisionInfo(
    toolId: string,
    decision: ToolDecision,
  ): { name: string; requiresConfirmation: boolean };
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
}

/** Questions the agent asks the user. */
export interface AgentQuestionFacet {
  listPendingQuestions(sessionId: string): Promise<QuestionActivity[]>;
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void>;
}

/** Goals and workflows. */
export interface AgentGoalFacet {
  getGoal(sessionId: string): Promise<GoalSnapshot>;
  operateGoal(sessionId: string, operation: GoalOperation): Promise<GoalSnapshot>;
  endWorkflow(sessionId: string, skill: string): Promise<GoalSnapshot>;
}

/** Model, thinking and session configuration, and the state they produce. */
export interface AgentModelFacet {
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  cycleThinking(sessionId: string): Promise<string | undefined>;
  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState>;
}

/** Work the runtime does around the turn: side questions, suggestions, compaction, retries, subagents. */
export interface AgentAssistFacet {
  askSideQuestion(sessionId: string, question: string): Promise<string>;
  suggestNextInput(sessionId: string): Promise<string | null>;
  compactSession(sessionId: string): Promise<void>;
  controlRetry(sessionId: string, action: "now" | "abort"): Promise<void>;
  listSubagents(sessionId: string): Promise<SubagentSnapshot[]>;
}

/** Saved sessions: the history list, reopening, resuming and forking. */
export interface AgentHistoryFacet {
  listHistorySessions(): Promise<HistorySession[]>;
  openHistorySession(sessionId: string): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  forkSession(input: {
    sourceSessionId: string;
    title?: string;
  }): Promise<AgentSession>;
  /** Another process holding the session open, which deleting it would have to stop. */
  sessionHostElsewhere(
    sessionId: string,
    options?: { reuseUnchangedIndex?: boolean },
  ): Promise<GjcHostProcess | undefined>;
}

/** The session's workspace: files, artifacts, the diff and git. */
export interface AgentWorkspaceFacet {
  getDiff(sessionId: string): Promise<DiffSnapshot>;
  readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent>;
  previewFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<GeneratedFilePreview>;
  listWorkspaceFiles(sessionId: string): Promise<WorkspaceFileIndex>;
  resolveWorkspaceFile(sessionId: string, relativePath: string): Promise<string>;
  getGitStatus(sessionId: string): Promise<GitStatusSnapshot>;
  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot>;
  pushChanges(sessionId: string): Promise<GitStatusSnapshot>;
}

/** Every optional facet together. */
export type AgentFacets = AgentQueueFacet &
  AgentApprovalFacet &
  AgentQuestionFacet &
  AgentGoalFacet &
  AgentModelFacet &
  AgentAssistFacet &
  AgentHistoryFacet &
  AgentWorkspaceFacet;

/**
 * A host that answers every facet: what `GjcSdkController` implements, and
 * what `AgentRouter` exposes to IPC and remote access.
 */
export type FullAgentHost = AgentHost & AgentFacets;

/**
 * Calls only some runtimes answer, and GJC none: omp's chat reports what fills its
 * context window. The router refuses them as unsupported for a session whose
 * controller lacks them.
 */
export interface AgentExtrasFacet {
  getContextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
  cancelSubagent(sessionId: string, subagentId: string): Promise<boolean>;
  steerSubagent(sessionId: string, subagentId: string, message: string): Promise<void>;
  getSubagentMessages(sessionId: string, subagentId: string): Promise<SubagentMessage[]>;
  promoteQueuedMessage(sessionId: string, text: string): Promise<boolean>;
  removeQueuedMessage(sessionId: string, text: string, mode: QueuedMessage["mode"]): Promise<boolean>;
  setRuntimeMode(sessionId: string, mode: RuntimeModeId, enabled: boolean): Promise<void>;
}

/** What `AgentRouter` offers: every facet, and the extras it routes to the runtimes that have them. */
export type RoutingAgentHost = FullAgentHost & AgentExtrasFacet;

/**
 * A runtime registered with the router next to GJC: the core calls, and any
 * facet it has. A facet it lacks is refused as unsupported for its sessions.
 */
export type AgentRuntimeController = AgentHost &
  Partial<AgentFacets> &
  Partial<AgentExtrasFacet> & {
    /** A session a remote device may neither see nor drive (a shell, design §5.7). */
    hiddenFromRemote?(sessionId: string): boolean;
    /** The session one of its tool ids names, for a runtime whose tool ids carry it. */
    sessionOfTool?(toolId: string): string | undefined;
  };

/**
 * A call the session's runtime does not offer, such as a GJC goal on a herdr
 * session. `code` lets a caller tell it from a failure of the call itself.
 */
export class AgentUnsupportedError extends Error {
  readonly code = "unsupported";

  constructor(
    readonly operation: string,
    readonly sessionId?: string,
  ) {
    super(
      sessionId
        ? `This session does not support ${operation}`
        : `This runtime does not support ${operation}`,
    );
    this.name = "AgentUnsupportedError";
  }
}
