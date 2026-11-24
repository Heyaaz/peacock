import { randomUUID } from "node:crypto";
import { validDirectory } from "../settings-store.js";
import type {
  AgentEvent,
  AgentSession,
  BackendConnection,
  CreateSessionInput,
  MessageDelivery,
  SessionStatus,
  TranscriptChange,
  TranscriptItem,
  TranscriptPage,
} from "../../shared/agent-contract.js";
import { isAgentKindId } from "../../shared/agent-contract.js";
import { launchOptions } from "../../shared/agent-launch.js";
import type {
  AgentAvailability,
  TerminalSessionCreateInput,
  TerminalSessionRecord,
} from "../../shared/terminal-ipc.js";
import { AgentUnsupportedError, type AgentRuntimeController } from "../agent-host.js";
import type { TerminalSessionStore } from "../terminal-session-store.js";
import { terminalAgentSession } from "../terminal-session-row.js";
import type { HookMessage } from "./agent-hooks.js";
import { planAgentLaunch, type LaunchPlan } from "./agent-launch.js";
import { activityOf, factsOfTerminal, sessionStatusOf, type ActivityCategory, type TerminalFacts } from "./agent-status.js";
import { claudeSessionOfPid, claudeTranscriptPath } from "./claude-session.js";
import type { Channel, HcConnection, HelloInfo } from "./connection.js";
import type { Terminal } from "./hc-api.generated.js";
import { SESSION_LABEL } from "./terminals.js";

/** How long a lost event stream waits before it subscribes again. */
const RESUBSCRIBE_MS = 2000;

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
  private subscription: Channel | undefined;
  private subscribing: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: HerdrAgentControllerOptions) {
    this.log = options.log ?? ((message, error) => console.error(`herdr agents: ${message}`, error ?? ""));
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
    for (const [address, owner] of this.addresses) if (owner === sessionId) this.addresses.delete(address);
  }

  async getTranscript(): Promise<TranscriptItem[]> {
    return [];
  }

  async getTranscriptPage(): Promise<TranscriptPage> {
    return EMPTY_PAGE;
  }

  async getTranscriptChanges(): Promise<TranscriptChange> {
    return { kind: "full", items: [] };
  }

  async getTranscriptRevision(): Promise<string | undefined> {
    return undefined;
  }

  watchTranscripts(): void {}

  async refreshSessionContext(): Promise<void> {}

  async sendMessage(sessionId: string): Promise<MessageDelivery> {
    throw new AgentUnsupportedError("sending messages to a terminal agent (P3)", sessionId);
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
      if (sessionId) this.update(sessionId, factsOfTerminal(data as Partial<Terminal>), true);
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
    this.applyStatus(sessionId, status, activity);
  }

  private applyStatus(sessionId: string, status: SessionStatus, activity?: ActivityCategory): void {
    const record = this.options.store.get(sessionId);
    if (!record) return;
    const changed = this.statuses.get(sessionId) !== status;
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
    });
  }

  private emitUpdated(sessionId: string): void {
    const record = this.options.store.get(sessionId);
    if (process.env.GAJAE_DEBUG_HERDR) console.log(`[herdr status] ${sessionId} ${this.statuses.get(sessionId)}`);
    if (record) this.options.emit({ type: "session.updated", session: this.row(record) });
  }
}
