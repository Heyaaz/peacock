import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageInput,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "./types";
import type {
  ArtifactContent,
  DiffSnapshot,
  EffectiveRuntimeState,
  GeneratedFilePreview,
  GitStatusSnapshot,
  GoalOperation,
  GoalSnapshot,
  HistorySession,
  MessageDelivery,
  QueuedMessage,
  QuestionSubmission,
  SubagentSnapshot,
} from "../../shared/agent-contract";
import type {
  ContextBreakdown,
  ForkSessionInput,
  RuntimeModeId,
  SessionTreeEntry,
  SessionUsageStats,
  SubagentMessage,
} from "../../shared/agent-contract";
import type { RemoteAccessBridge } from "../../shared/remote-protocol";

export interface AgentBackend {
  /**
   * Present only on a backend reached through the remote access server. The shell
   * uses it to show remote connection state and to withhold control affordances a
   * view-only device may not use.
   */
  readonly remoteAccess?: RemoteAccessBridge;
  /** Whether this backend can create terminal sessions, which only the desktop app runs. */
  readonly terminalSessions?: boolean;
  getConnection(): Promise<BackendConnection>;
  listSessions(): Promise<AgentSession[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  forkSession(input: ForkSessionInput): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  listHistorySessions(): Promise<HistorySession[]>;
  openHistorySession(sessionId: string): Promise<AgentSession>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Whether the user agrees to delete or hide the session; asked before either starts. */
  confirmSessionRemoval(sessionId: string, action: "delete" | "hide"): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
  hideSession(sessionId: string): Promise<void>;
  getTranscript(sessionId: string): Promise<TranscriptItem[]>;
  getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage>;
  /**
   * Safety-net read that returns changed rows when the caller already has the
   * conversation. Omitted backends still use `getTranscript`.
   */
  getTranscriptChanges?(sessionId: string): Promise<TranscriptChange>;
  /**
   * Cheap revision of the selected transcript. The same value means the body has
   * not changed, so the safety net skips the read. A backend that omits it falls
   * back to reading the body and keeping the previous state when the rows match.
   */
  getTranscriptRevision?(sessionId: string): Promise<string | undefined>;
  /**
   * Sessions a replay gap may reload: the one on screen and any transcript this
   * window already cached. Unset means every session, which is the fallback for a
   * caller that has not reported a cache yet.
   */
  watchTranscripts?(sessionIds: readonly string[]): void;
  /** Loads command/todo context once when a session is opened, never on a poll. */
  refreshSessionContext?(sessionId: string): Promise<void>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void>;
  cycleThinking(sessionId: string): Promise<string | undefined>;
  /**
   * `/btw`, answered from the session's context and kept out of the transcript.
   * A backend without it sends `/btw` as an ordinary command.
   */
  askSideQuestion?(sessionId: string, question: string): Promise<string>;
  /**
   * The user's likely next message for the composer's ghost text, or null. A
   * backend without it never shows a suggestion.
   */
  suggestNextInput?(sessionId: string): Promise<string | null>;
  /** Skips GJC's wait before retrying a failed model call, or stops retrying. */
  controlRetry?(sessionId: string, action: "now" | "abort"): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  /**
   * What fills the context window, by category, or null when the runtime cannot tell.
   * Only omp's chat answers; read it where the session's `contextBreakdown` capability is on.
   */
  getContextBreakdown?(sessionId: string): Promise<ContextBreakdown | null>;
  /** Subagent control, where the session's `subagentControl` capability is on (omp's chat). */
  cancelSubagent?(sessionId: string, subagentId: string): Promise<boolean>;
  steerSubagent?(sessionId: string, subagentId: string, message: string): Promise<void>;
  getSubagentMessages?(sessionId: string, subagentId: string): Promise<SubagentMessage[]>;
  /** The runtime's own queue, where the session's `queueEdit` capability is on (omp's chat). */
  promoteQueuedMessage?(sessionId: string, text: string): Promise<boolean>;
  removeQueuedMessage?(sessionId: string, text: string, mode: QueuedMessage["mode"]): Promise<boolean>;
  /** Runtime switches, where the session's `runtimeModes` capability is on (omp's chat). */
  setRuntimeMode?(sessionId: string, mode: RuntimeModeId, enabled: boolean): Promise<void>;
  /** Cost, tokens and requests so far, shown with the context breakdown (omp's chat). */
  getSessionStats?(sessionId: string): Promise<SessionUsageStats>;
  /** Saves the conversation as HTML through a save dialog; null when cancelled (omp's chat). */
  exportSessionHtml?(sessionId: string): Promise<string | null>;
  /** The conversation's tree and rewriting from an earlier message (`sessionTree` capability, omp's chat). */
  getSessionTree?(sessionId: string): Promise<SessionTreeEntry[]>;
  branchSession?(sessionId: string, entryId: string): Promise<string>;
  queueFollowUp(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]>;
  flushQueuedNow(sessionId: string): Promise<boolean>;
  steerSession(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  sendMessage(sessionId: string, input: MessageInput): Promise<MessageDelivery>;
  cancelRun(sessionId: string): Promise<void>;
  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void>;
  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void>;
  markSessionRead(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<DiffSnapshot>;
  readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent>;
  previewFile(
    sessionId: string,
    filePath: string,
  ): Promise<GeneratedFilePreview>;
  getGoal(sessionId: string): Promise<GoalSnapshot>;
  operateGoal(
    sessionId: string,
    operation: GoalOperation,
  ): Promise<GoalSnapshot>;
  endWorkflow(sessionId: string, skill: string): Promise<GoalSnapshot>;
  listSubagents(sessionId: string): Promise<SubagentSnapshot[]>;
  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState>;
  reconnect(): Promise<BackendConnection>;
  getGitStatus(sessionId: string): Promise<GitStatusSnapshot>;
  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot>;
  commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot>;
  pushChanges(sessionId: string): Promise<GitStatusSnapshot>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  dispose(): void;
}
