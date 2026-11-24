import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
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
import { isAgentKindId } from "../../shared/agent-contract.js";
import { agentCatalogEntry } from "../../shared/agent-catalog.js";
import { launchOptions } from "../../shared/agent-launch.js";
import type {
  AgentAvailability,
  TerminalSessionCreateInput,
  TerminalSessionRecord,
} from "../../shared/terminal-ipc.js";
import { AgentUnsupportedError, type AgentRuntimeController } from "../agent-host.js";
import type { ResolvedMessageInput } from "../gjc-sdk-model.js";
import type { TerminalSessionStore } from "../terminal-session-store.js";
import { terminalAgentSession } from "../terminal-session-row.js";
import type { HookMessage } from "./agent-hooks.js";
import { planAgentLaunch, type LaunchPlan } from "./agent-launch.js";
import { activityOf, factsOfTerminal, sessionStatusOf, type ActivityCategory, type TerminalFacts } from "./agent-status.js";
import { claudeSessionOfPid, claudeTranscriptPath } from "./claude-session.js";
import { HcError, type Channel, type HcConnection, type HelloInfo } from "./connection.js";
import type { Terminal } from "./hc-api.generated.js";
import { newestOmpSession, ompBreadcrumb, ompSessionHeader } from "./omp-session.js";
import { SESSION_LABEL } from "./terminals.js";
import { HerdrTranscripts, type TranscriptLocation } from "./transcript/transcripts.js";

/** How long a lost event stream waits before it subscribes again. */
const RESUBSCRIBE_MS = 2000;
/** How long a message waits for herdr-core to type it into the agent (design §5.5). */
const SEND_TIMEOUT_MS = 30_000;
/** How often an omp session's transcript is looked for again (its breadcrumb, then its folder). */
const OMP_LOCATE_MS = 2000;

export interface HerdrAgentControllerOptions {
  store: TerminalSessionStore;
  core: { connection(): Promise<HcConnection>; readonly core: HelloInfo | undefined; isRunning(): boolean };
  /** Ends a session's terminal (HcSessionTerminals.kill). */
  endTerminal(record: TerminalSessionRecord): Promise<void>;
  detect(id: TerminalSessionRecord["agentKind"] & string): Promise<AgentAvailability>;
  listAgents(): Promise<AgentAvailability[]>;
  /** Claude Code's hook settings, once the hook channel is up. */
  claudeSettingsPath?: () => string | undefined;
  emit(event: AgentEvent): void;
  /** Tells the router this runtime owns a new session. */
  claim?(sessionId: string): void;
  home: string;
  log?(message: string, error?: unknown): void;
  /** Transcript reading (tests shorten the poll). */
  transcripts?: { pollMs?: number; initialBytes?: number };
}

const EMPTY_PAGE: TranscriptPage = { items: [], hasMoreBefore: false, hasMoreAfter: false, requests: [] };

/**
 * Terminal agent sessions (Claude Code, omp, codex, and shells) as a runtime next to GJC.
 *
 * A session is a Gajae id (`terminal-<uuid>`, design §4: one scheme for every terminal session,
 * which the renderer and the terminal IPC already route) with a record of its agent, the agent's own
 * session id and where its terminal runs. Its status comes from herdr-core: every terminal's OSC 7501
 * record and its end arrive on one event stream; hooks fill in the agent's own session (SessionStart)
 * and stand in for a program that does not report. Chat surfaces (transcripts, sending) come in P3.
 */
export class HerdrAgentController implements AgentRuntimeController {
  private readonly facts = new Map<string, TerminalFacts>();
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly unread = new Set<string>();
  /** Goes up with every status change, so a list read before it cannot put an older status back. */
  private readonly revisions = new Map<string, number>();
  /** Sessions Gajae itself is ending: their end is no failure to announce. */
  private readonly ending = new Set<string>();
  private readonly addresses = new Map<string, string>();
  /** Each live terminal's process and start, for finding the transcript an omp in it writes. */
  private readonly processes = new Map<string, { pid?: number; createdMs?: number }>();
  /** When Gajae last started each session's terminal. */
  private readonly launchedAt = new Map<string, number>();
  private readonly ompLocations = new Map<string, { location: TranscriptLocation | undefined; at: number }>();
  private readonly transcripts: HerdrTranscripts;
  private subscription: Channel | undefined;
  private subscribing: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: HerdrAgentControllerOptions) {
    this.log = options.log ?? ((message, error) => console.error(`herdr agents: ${message}`, error ?? ""));
    this.transcripts = new HerdrTranscripts({
      locate: (sessionId) => this.locateTranscript(sessionId),
      emit: (event) => options.emit(event),
      ...(options.transcripts?.pollMs !== undefined ? { pollMs: options.transcripts.pollMs } : {}),
      ...(options.transcripts?.initialBytes !== undefined ? { initialBytes: options.transcripts.initialBytes } : {}),
      log: (message, error) => this.log(message, error),
    });
  }

  /** Follows a core that already runs; one that does not is followed once a terminal starts it. */
  start(): void {
    if (this.options.core.isRunning()) void this.watch();
  }

  // ---- AgentHost

  async getConnection(): Promise<BackendConnection> {
    const running = this.options.core.isRunning();
    return {
      state: running ? "connected" : "disconnected",
      backend: "herdr",
      label: "herdr-core",
      detail: this.options.core.core?.version ? `hc ${this.options.core.core.version}` : running ? "Running" : "Not running",
      workspace: "",
    };
  }

  reconnect(): Promise<BackendConnection> {
    this.start();
    return this.getConnection();
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.rows();
  }

  rows(): AgentSession[] {
    return this.options.store.list().map((record) => this.row(record));
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    return this.createTerminalSession({
      title: input.title ?? "",
      workspace: input.workspace,
      agentKind: input.agentKind ?? "shell",
      ...(input.launch ? { launch: input.launch } : {}),
    });
  }

  /** A new terminal session for an agent that is installed here. Its terminal starts on first view. */
  async createTerminalSession(input: TerminalSessionCreateInput): Promise<AgentSession> {
    const agentKind = input.agentKind ?? "shell";
    if (!isAgentKindId(agentKind) || agentKind === "gjc") throw new Error("Terminal agent is invalid");
    if (!validDirectory(input.workspace)) throw new Error("Workspace must be an existing folder");
    const launch = launchOptions(agentKind, input.launch);
    if (agentKind !== "shell") {
      const agent = await this.options.detect(agentKind);
      if (!agent.installed) throw new Error(`${agent.name}: ${agent.reason ?? "not installed"}`);
    }
    const record = this.options.store.create({
      title: input.title.trim() || agentKind,
      workspace: input.workspace,
      agentKind,
      ...(launch ? { launch } : {}),
      ...(agentKind === "claude" ? { agentSessionRef: randomUUID() } : {}),
    });
    this.options.claim?.(record.id);
    const session = this.row(record);
    this.options.emit({ type: "session.created", session });
    return session;
  }

  listAgents(): Promise<AgentAvailability[]> {
    return this.options.listAgents();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.options.store.rename(sessionId, title);
    this.emitUpdated(sessionId);
  }

  sessionTitle(sessionId: string): string | undefined {
    return this.options.store.get(sessionId)?.title;
  }

  /** A terminal session keeps no history apart from its terminal, so hiding one ends it. */
  hideSession(sessionId: string): void {
    void this.deleteSession(sessionId).catch((error: unknown) => this.log(`could not hide ${sessionId}`, error));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const record = this.options.store.get(sessionId);
    if (!record) return;
    this.ending.add(sessionId);
    try {
      await this.options.endTerminal(record);
    } finally {
      this.options.store.delete(sessionId);
      this.forget(sessionId);
    }
    this.options.emit({ type: "session.deleted", sessionId });
  }

  /** Lets go of a deleted session's state. */
  forget(sessionId: string): void {
    this.facts.delete(sessionId);
    this.statuses.delete(sessionId);
    this.revisions.delete(sessionId);
    this.unread.delete(sessionId);
    this.ending.delete(sessionId);
    this.processes.delete(sessionId);
    this.launchedAt.delete(sessionId);
    this.ompLocations.delete(sessionId);
    this.transcripts.forget(sessionId);
    for (const [address, owner] of this.addresses) if (owner === sessionId) this.addresses.delete(address);
  }

  // ---- chat (design §5.5): the agent's own transcript, read as it grows

  async getTranscript(sessionId: string): Promise<TranscriptItem[]> {
    return this.hasChat(sessionId) ? this.transcripts.items(sessionId) : [];
  }

  async getTranscriptPage(sessionId: string, request?: TranscriptPageRequest): Promise<TranscriptPage> {
    return this.hasChat(sessionId) ? this.transcripts.page(sessionId, request) : EMPTY_PAGE;
  }

  async getTranscriptChanges(sessionId: string): Promise<TranscriptChange> {
    return this.hasChat(sessionId) ? this.transcripts.changes(sessionId) : { kind: "full", items: [] };
  }

  async getTranscriptRevision(sessionId: string): Promise<string | undefined> {
    return this.hasChat(sessionId) ? this.transcripts.revision(sessionId) : undefined;
  }

  watchTranscripts(sessionIds: readonly string[]): void {
    this.transcripts.watch(sessionIds.filter((sessionId) => this.hasChat(sessionId)));
  }

  async refreshSessionContext(): Promise<void> {}

  /**
   * Types the message into the agent's terminal through herdr-core (`terminal.send`: a paste and
   * Enter once the user's own typing has paused). herdr-core refuses while the agent shows a
   * dialog, which comes back as not executed with what the agent is asking. Nothing is queued here:
   * the agent takes a message sent while it works the way it takes one typed then.
   */
  async sendMessage(sessionId: string, input: ResolvedMessageInput): Promise<MessageDelivery> {
    const record = this.options.store.get(sessionId);
    if (!record || !this.hasChat(sessionId)) throw new AgentUnsupportedError("sending messages", sessionId);
    if (input.images.length > 0 || input.files.length > 0)
      throw new Error("A terminal agent takes text only: attach files in its terminal");
    const text = input.text.trim();
    if (!text) throw new Error("The message is empty");
    if (!this.capabilities(record).send) throw new AgentUnsupportedError("sending messages until the agent reports its state", sessionId);
    const address = this.addressOf(sessionId);
    if (!address) throw new Error("The agent's terminal is not running: open its terminal first");
    const hc = await this.options.core.connection();
    try {
      await hc.call("terminal.send", { terminal: address, text }, SEND_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof HcError && error.kind === "blocked") {
        const status = this.facts.get(sessionId)?.status;
        return { kind: "not_executed", detail: status?.msg || status?.kind || "blocked" };
      }
      throw error;
    }
    return "prompt";
  }

  /** Presses the agent's stop key (esc for a program that reports status, else ctrl+c). */
  async cancelRun(sessionId: string): Promise<void> {
    const address = this.addressOf(sessionId);
    if (!address) return;
    const hc = await this.options.core.connection();
    await hc.call("terminal.interrupt", { terminal: address });
  }

  async markSessionRead(sessionId: string): Promise<void> {
    if (this.unread.delete(sessionId)) this.emitUpdated(sessionId);
  }

  /** A shell is a command line: a phone may not see or drive one (design §5.7). */
  hiddenFromRemote(sessionId: string): boolean {
    const record = this.options.store.get(sessionId);
    return record !== undefined && (record.agentKind ?? "shell") === "shell";
  }

  dispose(): void {
    this.disposed = true;
    this.transcripts.dispose();
    clearTimeout(this.retry);
    void this.subscription?.close();
    this.subscription = undefined;
  }

  // ---- launching

  /** What a session's terminal runs (HcSessionTerminals asks before it starts one). */
  async launchPlan(record: TerminalSessionRecord): Promise<LaunchPlan> {
    const plan = await planAgentLaunch(record, {
      detect: (id) => this.options.detect(id),
      claudeSettingsPath: this.options.claudeSettingsPath?.(),
      home: this.options.home,
    });
    if (plan.agentSessionRef && plan.agentSessionRef !== record.agentSessionRef)
      this.options.store.reportAgentSession(record.id, { agentSessionRef: plan.agentSessionRef });
    this.launchedAt.set(record.id, Date.now());
    this.ompLocations.delete(record.id);
    this.facts.delete(record.id);
    this.ending.delete(record.id);
    // the core runs now (or is about to): follow its events
    void this.watch();
    return plan;
  }

  // ---- hooks

  onHook(message: HookMessage): void {
    const record = this.recordOfHook(message);
    if (!record) return;
    const payload = message.payload;
    if (message.event === "SessionStart") {
      const ref = typeof payload.session_id === "string" ? payload.session_id : undefined;
      const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : undefined;
      this.options.store.reportAgentSession(record.id, {
        ...(ref ? { agentSessionRef: ref } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
      });
      return;
    }
    // herdr-core's 7501 records are the status of a program that reports them; hooks only stand in
    if (this.facts.get(record.id)?.reported) return;
    if (message.event === "UserPromptSubmit") this.applyStatus(record.id, "running");
    else if (message.event === "Stop") this.applyStatus(record.id, "idle", "completed");
    else if (message.event === "Notification" && payload.notification_type === "permission_prompt")
      this.applyStatus(record.id, "waiting", "permission");
  }

  private recordOfHook(message: HookMessage): TerminalSessionRecord | undefined {
    if (message.session) {
      const record = this.options.store.get(message.session);
      if (record) return record;
    }
    const ref = typeof message.payload.session_id === "string" ? message.payload.session_id : undefined;
    return ref ? this.options.store.list().find((record) => record.agentSessionRef === ref) : undefined;
  }

  // ---- herdr-core events

  private watch(): Promise<void> {
    if (this.disposed || this.subscription) return Promise.resolve();
    this.subscribing ??= this.subscribe()
      .catch((error: unknown) => {
        this.log("could not follow herdr-core events", error);
        this.scheduleResubscribe();
      })
      .finally(() => {
        this.subscribing = undefined;
      });
    return this.subscribing;
  }

  private scheduleResubscribe(): void {
    if (this.disposed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.options.core.isRunning()) void this.watch();
    }, RESUBSCRIBE_MS);
    this.retry.unref?.();
  }

  private async subscribe(): Promise<void> {
    const hc = await this.options.core.connection();
    const decoder = new TextDecoder();
    let pending = "";
    const { result, channel } = await hc.open(
      "events.subscribe",
      {},
      {
        onData: (payload) => {
          pending += decoder.decode(payload, { stream: true });
          let end = pending.indexOf("\n");
          while (end !== -1) {
            const line = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            if (line) this.onEventLine(line);
            end = pending.indexOf("\n");
          }
        },
        onClose: () => {
          if (this.subscription === channel) this.subscription = undefined;
          this.scheduleResubscribe();
        },
      },
    );
    if (this.disposed) {
      void channel.close();
      return;
    }
    this.subscription = channel;
    this.applySnapshot(result.terminals as Terminal[]);
  }

  private applySnapshot(terminals: Terminal[]): void {
    const seen = new Set<string>();
    for (const terminal of terminals) {
      const sessionId = this.sessionOfTerminal(terminal);
      if (!sessionId) continue;
      seen.add(sessionId);
      this.noteProcess(sessionId, terminal);
      // what was already so before this app looked is not news
      this.update(sessionId, factsOfTerminal(terminal), false);
      void this.recoverAgentSession(sessionId, terminal);
    }
    for (const record of this.options.store.list())
      if (!seen.has(record.id) && this.statuses.has(record.id)) this.applyStatus(record.id, "idle");
  }

  private onEventLine(line: string): void {
    if (process.env.GAJAE_DEBUG_HERDR) console.log(`[herdr event] ${line.slice(0, 400)}`);
    let message: { method?: string; params?: { type?: string; terminal?: string; data?: Record<string, unknown> } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== "event" || !message.params?.terminal) return;
    const { type, terminal: address, data = {} } = message.params;
    if (type === "created") {
      const sessionId = this.sessionOfTerminal({ ...(data as Partial<Terminal>), address } as Terminal);
      if (sessionId) {
        this.noteProcess(sessionId, data as Partial<Terminal>);
        this.update(sessionId, factsOfTerminal(data as Partial<Terminal>), true);
      }
      return;
    }
    const sessionId = this.addresses.get(address) ?? this.sessionOfAddress(address);
    if (!sessionId) return;
    const previous = this.facts.get(sessionId) ?? { state: "live", reported: false, status: null };
    if (type === "status") {
      this.update(sessionId, {
        ...previous,
        state: "live",
        reported: data.reported === true,
        status: (data.status as TerminalFacts["status"]) ?? null,
      });
    } else if (type === "finished") {
      this.update(sessionId, {
        ...previous,
        state: "finished",
        exitCode: typeof data.exit_code === "number" ? data.exit_code : null,
        reason: typeof data.reason === "string" ? data.reason : null,
        signal: typeof data.signal === "number" ? data.signal : null,
      });
    } else if (type === "restarted") {
      this.processes.set(sessionId, { createdMs: Date.now() });
      this.noteProcess(sessionId, data as Partial<Terminal>);
      this.ompLocations.delete(sessionId);
      this.update(sessionId, { state: "live", reported: false, status: null });
    } else if (type === "removed") {
      this.addresses.delete(address);
      this.facts.delete(sessionId);
      this.applyStatus(sessionId, "idle");
    }
  }

  private sessionOfTerminal(terminal: Pick<Terminal, "address" | "labels">): string | undefined {
    const sessionId = terminal.labels?.[SESSION_LABEL];
    if (!sessionId || !this.options.store.get(sessionId)) return undefined;
    this.addresses.set(terminal.address, sessionId);
    return sessionId;
  }

  private sessionOfAddress(address: string): string | undefined {
    const coreId = this.options.core.core?.core.id;
    const record = this.options.store
      .list()
      .find((candidate) => candidate.terminalAddress === address && candidate.coreId === coreId);
    if (record) this.addresses.set(address, record.id);
    return record?.id;
  }

  private addressOf(sessionId: string): string | undefined {
    for (const [address, owner] of this.addresses) if (owner === sessionId) return address;
    const record = this.options.store.get(sessionId);
    return record?.coreId === this.options.core.core?.core.id ? record?.terminalAddress : undefined;
  }

  /**
   * Hooks that went unheard while the app was closed leave the record behind a `/clear` or a
   * `/resume`: Claude Code's own file for its process names the session it is in now.
   */
  private async recoverAgentSession(sessionId: string, terminal: Terminal): Promise<void> {
    const record = this.options.store.get(sessionId);
    const pid = terminal.foreground?.pid ?? terminal.pid;
    if (record?.agentKind !== "claude" || terminal.state !== "live" || !pid) return;
    const found = await claudeSessionOfPid(pid, this.options.home);
    if (!found || found.sessionId === record.agentSessionRef) return;
    this.options.store.reportAgentSession(sessionId, {
      agentSessionRef: found.sessionId,
      transcriptPath: claudeTranscriptPath(found.cwd ?? record.workspace, found.sessionId, this.options.home),
    });
  }

  // ---- status

  private update(sessionId: string, next: TerminalFacts, announce = true): void {
    const previous = this.facts.get(sessionId);
    this.facts.set(sessionId, next);
    const status = sessionStatusOf(next, this.statuses.get(sessionId) ?? "idle");
    const activity = announce && !this.ending.has(sessionId) ? activityOf(previous, next) : undefined;
    // the chat may send once the agent reports, and no longer once its terminal ends
    this.applyStatus(sessionId, status, activity, sendable(previous) !== sendable(next));
  }

  private noteProcess(sessionId: string, terminal: Partial<Pick<Terminal, "pid" | "created_ms" | "foreground">>): void {
    const pid = terminal.pid ?? terminal.foreground?.pid ?? undefined;
    const known = this.processes.get(sessionId);
    this.processes.set(sessionId, {
      ...known,
      ...(pid ? { pid } : {}),
      ...(typeof terminal.created_ms === "number" ? { createdMs: terminal.created_ms } : {}),
    });
  }

  // ---- what a session offers, and where its transcript is

  /** Claude Code and omp have a chat screen beside their terminal; shells and codex do not. */
  private hasChat(sessionId: string): boolean {
    const record = this.options.store.get(sessionId);
    return record !== undefined && agentCatalogEntry(record.agentKind ?? "shell").surfaces.includes("chat");
  }

  /**
   * The agent's ceiling (agent-catalog.ts) less what this stage leaves out: sending only while the
   * agent reports its state to herdr-core (design §5.5: herdr-core refuses typing into a dialog only
   * for a program that reports one), and approvals (P4) and the git panel, which no terminal session
   * has yet.
   */
  private capabilities(record: TerminalSessionRecord): SessionCapabilities {
    const ceiling = agentCatalogEntry(record.agentKind ?? "shell").capabilities;
    return {
      ...ceiling,
      send: ceiling.send && sendable(this.facts.get(record.id)),
      approvals: false,
      git: false,
    };
  }

  private async locateTranscript(sessionId: string): Promise<TranscriptLocation | undefined> {
    const record = this.options.store.get(sessionId);
    if (record?.agentKind === "claude") {
      const ref = record.agentSessionRef;
      // the hook's path is the session's own; one left from an earlier session id is not
      const reported = record.transcriptPath && (!ref || path.basename(record.transcriptPath) === `${ref}.jsonl`) ? record.transcriptPath : undefined;
      const file = reported ?? (ref ? claudeTranscriptPath(record.workspace, ref, this.options.home) : undefined);
      return file ? { path: file, format: "claude" } : undefined;
    }
    if (record?.agentKind === "omp") return this.locateOmp(record);
    return undefined;
  }

  /**
   * omp chooses its own session file. Its terminal breadcrumb names the one it writes now (and
   * follows a move to another session); before omp writes one, the newest file in the working
   * folder's store begun since the terminal started is the session's. What is found is kept on the
   * record, so a new terminal resumes it.
   */
  private async locateOmp(record: TerminalSessionRecord): Promise<TranscriptLocation | undefined> {
    const known = this.ompLocations.get(record.id);
    if (known && Date.now() - known.at < OMP_LOCATE_MS) {
      // omp writes its file with the first message: its session id can be read only once it has
      if (known.location && !record.agentSessionRef) {
        const header = await ompSessionHeader(known.location.path);
        if (header) this.options.store.reportAgentSession(record.id, { agentSessionRef: header.id });
      }
      return known.location;
    }
    const running = this.processes.get(record.id);
    const since = running?.createdMs ?? this.launchedAt.get(record.id) ?? Date.parse(record.createdAt);
    const home = this.options.home;
    let file: string | undefined;
    let source = "breadcrumb";
    if (running?.pid && this.facts.get(record.id)?.state === "live")
      file = await ompBreadcrumb(running.pid, { home, cwd: record.workspace, since });
    if (!file && record.transcriptPath && (await exists(record.transcriptPath))) {
      file = record.transcriptPath;
      source = "record";
    }
    if (!file) {
      const followed = new Set(
        this.options.store
          .list()
          .flatMap((other) => (other.id !== record.id && other.transcriptPath ? [other.transcriptPath] : [])),
      );
      file = (await newestOmpSession(record.workspace, { home, since, exclude: followed }))?.path;
      source = "folder";
    }
    // omp writes its file with the first message, so the session's id may come after its path
    if (file && (file !== record.transcriptPath || !record.agentSessionRef)) {
      const header = await ompSessionHeader(file);
      this.options.store.reportAgentSession(record.id, { transcriptPath: file, ...(header ? { agentSessionRef: header.id } : {}) });
    }
    if (process.env.GAJAE_DEBUG_HERDR && file !== known?.location?.path)
      console.log(`[herdr transcript] ${record.id} omp ${file ? `${source} ${file}` : "not found"}`);
    const location: TranscriptLocation | undefined = file ? { path: file, format: "omp" } : undefined;
    this.ompLocations.set(record.id, { location, at: Date.now() });
    return location;
  }

  private applyStatus(sessionId: string, status: SessionStatus, activity?: ActivityCategory, offerChanged = false): void {
    const record = this.options.store.get(sessionId);
    if (!record) return;
    const changed = this.statuses.get(sessionId) !== status || offerChanged;
    this.statuses.set(sessionId, status);
    if (changed) this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
    if (activity) this.unread.add(sessionId);
    if (changed || activity) this.emitUpdated(sessionId);
    if (activity)
      this.options.emit({
        type: "session.activity",
        sessionId,
        title: record.title,
        unread: true,
        category: activity,
      });
  }

  private row(record: TerminalSessionRecord): AgentSession {
    return terminalAgentSession(record, {
      status: this.statuses.get(record.id) ?? "idle",
      unread: this.unread.has(record.id),
      ...(this.revisions.has(record.id) ? { runRevision: this.revisions.get(record.id) } : {}),
      capabilities: this.capabilities(record),
    });
  }

  private emitUpdated(sessionId: string): void {
    const record = this.options.store.get(sessionId);
    if (process.env.GAJAE_DEBUG_HERDR) console.log(`[herdr status] ${sessionId} ${this.statuses.get(sessionId)}`);
    if (record) this.options.emit({ type: "session.updated", session: this.row(record) });
  }
}

/** A terminal whose agent reports its state to herdr-core, and still runs. */
function sendable(facts: TerminalFacts | undefined): boolean {
  return facts?.state === "live" && facts.reported;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
