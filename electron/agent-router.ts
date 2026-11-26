import type {
  AgentSession,
  ArtifactContent,
  BackendConnection,
  ContextBreakdown,
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
  RuntimeKind,
  RuntimeModeId,
  SessionTreeEntry,
  SessionUsageStats,
  SubagentMessage,
  SubagentSnapshot,
  ToolDecision,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
  WorkspaceFileIndex,
} from "../shared/agent-contract.js";
import {
  AgentUnsupportedError,
  type AgentExtrasFacet,
  type AgentFacets,
  type AgentRuntimeController,
  type FullAgentHost,
  type RoutingAgentHost,
} from "./agent-host.js";
import type { GjcHostProcess } from "./gjc-host-process.js";
import type { DeleteSessionOptions } from "./gjc-sdk-lifecycle.js";
import type { ResolvedMessageInput, SendMessageOptions } from "./gjc-sdk-model.js";

/**
 * The runtimes a controller can register for. GJC is the router's own runtime,
 * and `hermes` exists only in the mock backend, so it never reaches the router.
 */
export type RoutedRuntimeKind = Exclude<RuntimeKind, "gjc" | "hermes">;

function routedRuntime(runtime: RuntimeKind): runtime is RoutedRuntimeKind {
  return runtime !== "gjc" && runtime !== "hermes";
}

/**
 * The one session host the main process hands out.
 *
 * Each call that names a session goes to the controller that owns it. A session
 * no other runtime has claimed belongs to GJC, so until a herdr controller is
 * registered every call reaches `GjcSdkController` unchanged, with the same
 * arguments, and returns what it returns.
 *
 * A facet the owning controller lacks is refused with `AgentUnsupportedError`
 * as a rejected promise, never a synchronous throw, so a caller's `.catch`
 * sees it.
 */
export class AgentRouter implements RoutingAgentHost {
  private readonly runtimes = new Map<RoutedRuntimeKind, AgentRuntimeController>();
  /** Sessions a registered runtime owns. Every other session is GJC's. */
  private readonly owners = new Map<string, RoutedRuntimeKind>();
  private disposed = false;

  constructor(private readonly gjc: FullAgentHost) {}

  /** Puts a controller in charge of a runtime; the returned call takes it back. */
  registerRuntime(
    runtime: RoutedRuntimeKind,
    controller: AgentRuntimeController,
  ): () => void {
    if (this.runtimes.has(runtime))
      throw new Error(`Runtime ${runtime} already has a controller`);
    this.runtimes.set(runtime, controller);
    return () => {
      if (this.runtimes.get(runtime) !== controller) return;
      this.runtimes.delete(runtime);
      for (const [sessionId, owner] of this.owners)
        if (owner === runtime) this.owners.delete(sessionId);
    };
  }

  /** Records that a registered runtime owns a session. */
  claimSession(sessionId: string, runtime: RoutedRuntimeKind): void {
    if (!this.runtimes.has(runtime))
      throw new Error(`Runtime ${runtime} has no controller`);
    this.owners.set(sessionId, runtime);
  }

  /** Forgets a claim; the session is GJC's again. */
  releaseSession(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  /** The runtime that answers for a session. */
  runtimeOf(sessionId: string): RuntimeKind {
    const runtime = this.owners.get(sessionId);
    return runtime && this.runtimes.has(runtime) ? runtime : "gjc";
  }

  /** The controller that answers for a session. */
  controllerFor(sessionId: string): AgentRuntimeController {
    const runtime = this.owners.get(sessionId);
    return (runtime && this.runtimes.get(runtime)) || this.gjc;
  }

  private runtimeOfController(
    controller: AgentRuntimeController,
  ): RoutedRuntimeKind | undefined {
    for (const [runtime, candidate] of this.runtimes)
      if (candidate === controller) return runtime;
    return undefined;
  }

  /** Claims a session a controller just produced, when that controller is not GJC. */
  private adopt(
    controller: AgentRuntimeController,
    session: Promise<AgentSession>,
  ): Promise<AgentSession> {
    if (controller === this.gjc) return session;
    return session.then((created) => {
      const runtime = this.runtimeOfController(controller);
      if (runtime) this.owners.set(created.id, runtime);
      return created;
    });
  }

  /** The owning controller's implementation of a facet call, or a refusal. */
  private facet<K extends keyof (AgentFacets & AgentExtrasFacet)>(
    sessionId: string,
    method: K,
  ): (AgentFacets & AgentExtrasFacet)[K] {
    const controller = this.controllerFor(sessionId);
    const implementation = controller[method] as
      | ((...args: never[]) => unknown)
      | undefined;
    if (typeof implementation === "function")
      return implementation.bind(controller) as (AgentFacets & AgentExtrasFacet)[K];
    const refusal = () =>
      Promise.reject(new AgentUnsupportedError(method, sessionId));
    return refusal as unknown as (AgentFacets & AgentExtrasFacet)[K];
  }

  // Runtime-wide calls. Only GJC has a connection, saved history or tool ids
  // the router can place until the herdr controller arrives.

  getConnection(): Promise<BackendConnection> {
    return this.gjc.getConnection();
  }

  reconnect(): Promise<BackendConnection> {
    return this.gjc.reconnect();
  }

  listSessions(): Promise<AgentSession[]> {
    if (this.runtimes.size === 0) return this.gjc.listSessions();
    // A runtime that cannot list its sessions hides only its own rows; GJC's
    // failure still fails the list, as it did before the router.
    const others = [...this.runtimes].map(([runtime, controller]) =>
      controller.listSessions().then(
        (sessions) => {
          if (this.runtimes.get(runtime) === controller)
            for (const session of sessions) this.owners.set(session.id, runtime);
          return sessions;
        },
        (error: unknown) => {
          console.error(`Sessions of runtime ${runtime} could not be listed`, error);
          return [] as AgentSession[];
        },
      ),
    );
    return Promise.all([this.gjc.listSessions(), ...others]).then((lists) =>
      lists.flat(),
    );
  }

  createSession(input: CreateSessionInput): Promise<AgentSession> {
    if (!routedRuntime(input.runtime)) return this.gjc.createSession(input);
    const controller = this.runtimes.get(input.runtime);
    if (!controller)
      return Promise.reject(
        new AgentUnsupportedError(`creating ${input.runtime} sessions`),
      );
    return this.adopt(controller, controller.createSession(input));
  }

  listHistorySessions(): Promise<HistorySession[]> {
    return this.gjc.listHistorySessions();
  }

  /**
   * The session a tool id names. GJC's ids are its own and carry none; another runtime's start
   * with their session's id (`<sessionId>:<call id>`, or `<sessionId>/<id>`, design §5.7), which is
   * how a decision from the window or a phone, which names only the tool, reaches its runtime.
   */
  sessionOfTool(toolId: string): string | undefined {
    for (const sessionId of this.owners.keys())
      if (toolId.startsWith(`${sessionId}:`) || toolId.startsWith(`${sessionId}/`)) return sessionId;
    for (const controller of this.runtimes.values()) {
      const sessionId = controller.sessionOfTool?.(toolId);
      if (sessionId !== undefined) return sessionId;
    }
    return undefined;
  }

  toolDecisionInfo(
    toolId: string,
    decision: ToolDecision,
  ): { name: string; requiresConfirmation: boolean } {
    const sessionId = this.sessionOfTool(toolId);
    if (sessionId === undefined) return this.gjc.toolDecisionInfo(toolId, decision);
    const controller = this.controllerFor(sessionId);
    if (!controller.toolDecisionInfo) throw new AgentUnsupportedError("tool approvals", sessionId);
    return controller.toolDecisionInfo(toolId, decision);
  }

  resolveToolCall(toolId: string, decision: ToolDecision): Promise<void> {
    const sessionId = this.sessionOfTool(toolId);
    if (sessionId === undefined) return this.gjc.resolveToolCall(toolId, decision);
    return this.facet(sessionId, "resolveToolCall")(toolId, decision);
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    if (this.runtimes.size === 0) return this.gjc.watchTranscripts(sessionIds);
    // Each controller replaces its own watched set, so every one hears the
    // call, with an empty list when none of its sessions is watched.
    const watched = new Map<AgentRuntimeController, string[]>([[this.gjc, []]]);
    for (const controller of this.runtimes.values()) watched.set(controller, []);
    for (const sessionId of sessionIds)
      watched.get(this.controllerFor(sessionId))?.push(sessionId);
    for (const [controller, ids] of watched) controller.watchTranscripts(ids);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.gjc.dispose();
    } finally {
      for (const [runtime, controller] of this.runtimes) {
        try {
          controller.dispose();
        } catch (error) {
          console.error(`Runtime ${runtime} did not shut down cleanly`, error);
        }
      }
      this.runtimes.clear();
      this.owners.clear();
    }
  }

  // Core calls for one session.

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.controllerFor(sessionId).renameSession(sessionId, title);
  }

  sessionTitle(sessionId: string): string | undefined {
    return this.controllerFor(sessionId).sessionTitle(sessionId);
  }

  hideSession(sessionId: string): void {
    const controller = this.controllerFor(sessionId);
    controller.hideSession(sessionId);
    if (controller !== this.gjc) this.releaseSession(sessionId);
  }

  deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<void> {
    const controller = this.controllerFor(sessionId);
    const deleted = controller.deleteSession(sessionId, options);
    if (controller === this.gjc) return deleted;
    return deleted.then(() => this.releaseSession(sessionId));
  }

  getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.controllerFor(sessionId).getTranscript(sessionId);
  }

  getTranscriptPage(
    sessionId: string,
    request?: TranscriptPageRequest,
  ): Promise<TranscriptPage> {
    return this.controllerFor(sessionId).getTranscriptPage(sessionId, request);
  }

  getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    return this.controllerFor(sessionId).getTranscriptChanges(sessionId);
  }

  getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return this.controllerFor(sessionId).getTranscriptRevision(sessionId);
  }

  refreshSessionContext(sessionId: string): Promise<void> {
    return this.controllerFor(sessionId).refreshSessionContext(sessionId);
  }

  sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: SendMessageOptions,
  ): Promise<MessageDelivery> {
    return this.controllerFor(sessionId).sendMessage(sessionId, input, options);
  }

  cancelRun(sessionId: string): Promise<void> {
    return this.controllerFor(sessionId).cancelRun(sessionId);
  }

  markSessionRead(sessionId: string): Promise<void> {
    return this.controllerFor(sessionId).markSessionRead(sessionId);
  }

  // Facet calls for one session.

  steerSession(
    sessionId: string,
    input: ResolvedMessageInput,
    options?: { echo?: boolean },
  ): Promise<MessageDelivery> {
    return this.facet(sessionId, "steerSession")(sessionId, input, options);
  }

  queueFollowUp(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery> {
    return this.facet(sessionId, "queueFollowUp")(sessionId, input);
  }

  listQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
    return this.facet(sessionId, "listQueuedMessages")(sessionId);
  }

  flushQueuedNow(sessionId: string): Promise<boolean> {
    return this.facet(sessionId, "flushQueuedNow")(sessionId);
  }

  listPendingQuestions(sessionId: string): Promise<QuestionActivity[]> {
    return this.facet(sessionId, "listPendingQuestions")(sessionId);
  }

  answerQuestion(
    sessionId: string,
    gateId: string,
    submission: QuestionSubmission,
    idempotencyKey: string,
  ): Promise<void> {
    return this.facet(sessionId, "answerQuestion")(
      sessionId,
      gateId,
      submission,
      idempotencyKey,
    );
  }

  getGoal(sessionId: string): Promise<GoalSnapshot> {
    return this.facet(sessionId, "getGoal")(sessionId);
  }

  operateGoal(sessionId: string, operation: GoalOperation): Promise<GoalSnapshot> {
    return this.facet(sessionId, "operateGoal")(sessionId, operation);
  }

  endWorkflow(sessionId: string, skill: string): Promise<GoalSnapshot> {
    return this.facet(sessionId, "endWorkflow")(sessionId, skill);
  }

  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    return this.facet(sessionId, "setSessionConfig")(sessionId, configId, value);
  }

  cycleThinking(sessionId: string): Promise<string | undefined> {
    return this.facet(sessionId, "cycleThinking")(sessionId);
  }

  refreshRuntimeState(sessionId: string): Promise<EffectiveRuntimeState> {
    return this.facet(sessionId, "refreshRuntimeState")(sessionId);
  }

  askSideQuestion(sessionId: string, question: string): Promise<string> {
    return this.facet(sessionId, "askSideQuestion")(sessionId, question);
  }

  suggestNextInput(sessionId: string): Promise<string | null> {
    return this.facet(sessionId, "suggestNextInput")(sessionId);
  }

  compactSession(sessionId: string): Promise<void> {
    return this.facet(sessionId, "compactSession")(sessionId);
  }

  controlRetry(sessionId: string, action: "now" | "abort"): Promise<void> {
    return this.facet(sessionId, "controlRetry")(sessionId, action);
  }

  listSubagents(sessionId: string): Promise<SubagentSnapshot[]> {
    return this.facet(sessionId, "listSubagents")(sessionId);
  }

  // Extras: GJC has none of them, so a GJC session's call is refused.

  getContextBreakdown(sessionId: string): Promise<ContextBreakdown | null> {
    return this.facet(sessionId, "getContextBreakdown")(sessionId);
  }

  cancelSubagent(sessionId: string, subagentId: string): Promise<boolean> {
    return this.facet(sessionId, "cancelSubagent")(sessionId, subagentId);
  }

  steerSubagent(sessionId: string, subagentId: string, message: string): Promise<void> {
    return this.facet(sessionId, "steerSubagent")(sessionId, subagentId, message);
  }

  getSubagentMessages(sessionId: string, subagentId: string): Promise<SubagentMessage[]> {
    return this.facet(sessionId, "getSubagentMessages")(sessionId, subagentId);
  }

  promoteQueuedMessage(sessionId: string, text: string): Promise<boolean> {
    return this.facet(sessionId, "promoteQueuedMessage")(sessionId, text);
  }

  removeQueuedMessage(sessionId: string, text: string, mode: QueuedMessage["mode"]): Promise<boolean> {
    return this.facet(sessionId, "removeQueuedMessage")(sessionId, text, mode);
  }

  setRuntimeMode(sessionId: string, mode: RuntimeModeId, enabled: boolean): Promise<void> {
    return this.facet(sessionId, "setRuntimeMode")(sessionId, mode, enabled);
  }

  getSessionStats(sessionId: string): Promise<SessionUsageStats> {
    return this.facet(sessionId, "getSessionStats")(sessionId);
  }

  exportSessionHtml(sessionId: string, outputPath: string): Promise<string> {
    return this.facet(sessionId, "exportSessionHtml")(sessionId, outputPath);
  }

  getSessionTree(sessionId: string): Promise<SessionTreeEntry[]> {
    return this.facet(sessionId, "getSessionTree")(sessionId);
  }

  navigateSessionTree(sessionId: string, entryId: string): Promise<string> {
    return this.facet(sessionId, "navigateSessionTree")(sessionId, entryId);
  }

  abortUserShell(sessionId: string): Promise<void> {
    return this.facet(sessionId, "abortUserShell")(sessionId);
  }

  openHistorySession(sessionId: string): Promise<AgentSession> {
    return this.adopt(
      this.controllerFor(sessionId),
      this.facet(sessionId, "openHistorySession")(sessionId),
    );
  }

  resumeSession(sessionId: string): Promise<AgentSession> {
    return this.adopt(
      this.controllerFor(sessionId),
      this.facet(sessionId, "resumeSession")(sessionId),
    );
  }

  forkSession(input: {
    sourceSessionId: string;
    title?: string;
    entryId?: string;
  }): Promise<AgentSession> {
    return this.adopt(
      this.controllerFor(input.sourceSessionId),
      this.facet(input.sourceSessionId, "forkSession")(input),
    );
  }

  /** Whether remote devices must not see or drive a session; only a runtime that says so hides one. */
  hiddenFromRemote(sessionId: string): boolean {
    return this.controllerFor(sessionId).hiddenFromRemote?.(sessionId) ?? false;
  }

  /** A runtime without other hosts has none holding the session, so delete stops nothing. */
  sessionHostElsewhere(
    sessionId: string,
    options?: { reuseUnchangedIndex?: boolean },
  ): Promise<GjcHostProcess | undefined> {
    const controller = this.controllerFor(sessionId);
    if (typeof controller.sessionHostElsewhere !== "function")
      return Promise.resolve(undefined);
    return controller.sessionHostElsewhere(sessionId, options);
  }

  getDiff(sessionId: string): Promise<DiffSnapshot> {
    return this.facet(sessionId, "getDiff")(sessionId);
  }

  readArtifact(sessionId: string, artifactId: string): Promise<ArtifactContent> {
    return this.facet(sessionId, "readArtifact")(sessionId, artifactId);
  }

  previewFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<GeneratedFilePreview> {
    return this.facet(sessionId, "previewFile")(sessionId, requestedPath);
  }

  listWorkspaceFiles(sessionId: string): Promise<WorkspaceFileIndex> {
    return this.facet(sessionId, "listWorkspaceFiles")(sessionId);
  }

  resolveWorkspaceFile(sessionId: string, relativePath: string): Promise<string> {
    return this.facet(sessionId, "resolveWorkspaceFile")(sessionId, relativePath);
  }

  getGitStatus(sessionId: string): Promise<GitStatusSnapshot> {
    return this.facet(sessionId, "getGitStatus")(sessionId);
  }

  stageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return this.facet(sessionId, "stageFiles")(sessionId, paths);
  }

  unstageFiles(sessionId: string, paths: string[]): Promise<GitStatusSnapshot> {
    return this.facet(sessionId, "unstageFiles")(sessionId, paths);
  }

  commitChanges(sessionId: string, message: string): Promise<GitStatusSnapshot> {
    return this.facet(sessionId, "commitChanges")(sessionId, message);
  }

  pushChanges(sessionId: string): Promise<GitStatusSnapshot> {
    return this.facet(sessionId, "pushChanges")(sessionId);
  }

  sessionWorktreePath(sessionId: string): Promise<string | undefined> {
    return this.facet(sessionId, "sessionWorktreePath")(sessionId);
  }
}
