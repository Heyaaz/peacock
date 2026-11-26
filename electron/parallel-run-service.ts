import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_CATALOG } from "../shared/agent-catalog.js";
import type {
  AgentEvent,
  AgentKindId,
  AgentSession,
  CreateSessionInput,
  MessageDelivery,
} from "../shared/agent-contract.js";
import type { AgentLaunchOptions } from "../shared/agent-launch.js";
import type { AgentAvailability } from "../shared/terminal-ipc.js";
import {
  applyParallelEvent,
  attemptSessionId,
  PARALLEL_AGENT_DEFAULT_MODEL,
  PARALLEL_ATTEMPT_MAX,
  PARALLEL_ATTEMPT_MIN,
  parallelAgentSupport,
  parallelAttemptBranch,
  type ParallelAgentOption,
  type ParallelCleanupItem,
  type ParallelCleanupPlan,
  type ParallelGroup,
  type ParallelGroupEvent,
  ParallelTransitionError,
} from "../shared/parallel-run.js";
import type { ParallelStartInput } from "../shared/parallel-ipc.js";
import type { ResolvedMessageInput } from "./gjc-sdk-controller.js";
import {
  addWorktree,
  discardNewWorktree,
  inspectWorktree,
  listWorktreePaths,
  localBranchExists,
  removeWorktreeLeftovers,
  repositoryRoot,
  runGit,
  type GitRunner,
} from "./worktree-service.js";

export type { GitRunner };

/** The slice of the session controller a parallel run drives. */
export interface ParallelRunHost {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  sendMessage(
    sessionId: string,
    input: ResolvedMessageInput,
  ): Promise<MessageDelivery>;
  hideSession(sessionId: string): void;
  /** The terminal agents found here (P6); without it only GJC runs attempts. */
  listAgents?(): Promise<AgentAvailability[]>;
  /**
   * Starts a terminal agent's session where no window shows it, waits until the agent
   * can take a request (a folder-trust dialog waits for the user), and types it in (P6).
   */
  sendWhenReady?(sessionId: string, text: string): Promise<MessageDelivery>;
}

export interface ParallelGroupStore {
  listParallelGroups(): ParallelGroup[];
  putParallelGroup(group: ParallelGroup): void;
}

export const INTERRUPTED_REASON =
  "앱이 다시 시작되어 이 시도의 생성 결과를 확인하지 못했습니다.";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs Best-of-N groups for the main process.
 *
 * Attempts are created one after another: each creation writes the source
 * repository's `.git` (a new worktree and branch) and the broker's lifecycle
 * ledger, which every attempt shares. Each request is sent as soon as its session
 * exists, so the runs themselves overlap in their own worktrees.
 */
export class ParallelRunService {
  private readonly groups = new Map<string, ParallelGroup>();
  /** Attempt sessions seen working since their request, and those that finished after it. */
  private readonly working = new Set<string>();
  private readonly finished = new Set<string>();
  /** Sessions whose last reported state is working or waiting on the user. */
  private readonly busy = new Set<string>();
  /** Groups whose cleanup is running: no pick may change while Git is deleting. */
  private readonly cleaning = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly git: GitRunner;

  constructor(
    private readonly options: {
      store: ParallelGroupStore;
      host: ParallelRunHost;
      git?: GitRunner;
      notify?: (groups: ParallelGroup[]) => void;
      newId?: () => string;
      now?: () => number;
    },
  ) {
    this.git = options.git ?? runGit;
    for (const group of options.store.listParallelGroups())
      this.groups.set(group.id, group);
    // Creation lived in the process that just ended; an attempt it left half-made
    // has no one to finish it, and a group left in draft could never be decided.
    for (const group of [...this.groups.values()])
      if (group.state.kind === "draft")
        this.apply(group.id, { type: "interrupted", reason: INTERRUPTED_REASON });
  }

  list(): ParallelGroup[] {
    return [...this.groups.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Every agent with whether a parallel run can use it here, and why not (P6). */
  async agents(): Promise<ParallelAgentOption[]> {
    const found = (await this.options.host.listAgents?.().catch(() => undefined)) ?? [];
    return AGENT_CATALOG.map((entry) => {
      // GJC is GJC's own controller: it is offered as before, whatever the terminal detection says
      if (entry.id === "gjc") return { id: entry.id, name: entry.name, supported: true };
      const agent = found.find((candidate) => candidate.id === entry.id);
      return parallelAgentSupport(agent ?? { id: entry.id, name: entry.name, installed: false, reason: "이 Mac에서 터미널 에이전트를 실행할 수 없습니다" });
    });
  }

  /** Resolves when every creation and send this service started has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  async start(input: ParallelStartInput): Promise<ParallelGroup> {
    if (
      input.presets.length < PARALLEL_ATTEMPT_MIN ||
      input.presets.length > PARALLEL_ATTEMPT_MAX
    )
      throw new Error(
        `병렬 실행은 시도를 ${PARALLEL_ATTEMPT_MIN}-${PARALLEL_ATTEMPT_MAX}개로 나눠야 합니다.`,
      );
    const agentKind = input.agentKind ?? "gjc";
    if (agentKind !== "gjc") {
      const support = (await this.agents()).find((option) => option.id === agentKind);
      if (!support?.supported) throw new Error(support?.reason ?? "이 에이전트는 병렬 실행에 쓸 수 없습니다");
      if (!this.options.host.sendWhenReady) throw new Error("이 Mac에서 터미널 에이전트를 실행할 수 없습니다");
    }
    const root = await this.repositoryRoot(input.workspace);
    const id = this.options.newId?.() ?? randomUUID();
    const base = input.branch ?? `gajae/best-of-${id.slice(0, 8)}`;
    const attempts = input.presets.map((preset, index) => {
      const attemptId = String(index + 1);
      return {
        id: attemptId,
        preset,
        branch: parallelAttemptBranch(base, attemptId),
        state: { kind: "creating" as const },
      };
    });
    // Every attempt branch is new. An existing one would be checked out instead
    // of created, and the cleanup would then offer to delete a branch this group
    // never owned.
    for (const attempt of attempts)
      if (await this.branchExists(root, attempt.branch))
        throw new Error(
          `브랜치 ${attempt.branch}이(가) 이미 있습니다. 다른 브랜치 이름을 쓰세요.`,
        );
    // The Git check above cannot see a branch another start is about to create, and
    // two groups on one branch would let one cleanup delete the other's work. This
    // check and the save below run without an await between them.
    for (const attempt of attempts)
      if (this.branchHeld(attempt.branch))
        throw new Error(
          `브랜치 ${attempt.branch}은(는) 진행 중인 다른 병렬 실행이 쓰고 있습니다. 다른 브랜치 이름을 쓰세요.`,
        );
    const group: ParallelGroup = {
      id,
      title: input.title,
      prompt: input.prompt,
      ...(agentKind !== "gjc" ? { agentKind } : {}),
      workspace: input.workspace,
      createdAt: this.options.now?.() ?? Date.now(),
      attempts,
      state: { kind: "draft" },
    };
    this.save(group);
    this.track(agentKind === "gjc" ? this.run(group) : this.runTerminalAgents(group, root, agentKind, input.launch));
    return group;
  }

  adopt(groupId: string, attemptId: string): ParallelGroup {
    this.rejectWhileCleaning(groupId);
    return this.apply(groupId, { type: "adopt", attemptId });
  }

  discard(groupId: string): ParallelGroup {
    this.rejectWhileCleaning(groupId);
    return this.apply(groupId, { type: "discard" });
  }

  /**
   * After a restart the events that would have finished an attempt are gone. The
   * sessions' current state stands in for them: an attempt whose session is not
   * working has finished its turn.
   */
  restore(sessions: readonly AgentSession[]): void {
    for (const session of sessions) {
      if (!this.isAttemptSession(session.id)) continue;
      const working =
        session.status === "running" ||
        session.status === "starting" ||
        session.phase === "compacting";
      if (working || session.status === "waiting") this.busy.add(session.id);
      if (working) this.working.add(session.id);
      else if (session.status === "idle" || session.status === "failed")
        this.finished.add(session.id);
    }
    this.settle();
  }

  /**
   * What the cleanup would remove, read from Git now rather than from the record:
   * a worktree left by a failed creation, or a branch a previous cleanup did not
   * get to, is found the same way as everything else.
   */
  async cleanupPlan(groupId: string): Promise<ParallelCleanupPlan> {
    const group = this.require(groupId);
    if (group.state.kind !== "adopted" && group.state.kind !== "discarded")
      throw new Error("채택하거나 모두 버린 뒤에만 시도를 정리할 수 있습니다.");
    const root = await this.repositoryRoot(group.workspace);
    const worktrees = await listWorktreePaths(this.git, root);
    const adoptedId = group.state.kind === "adopted" ? group.state.attemptId : undefined;
    const kept = group.attempts.find((attempt) => attempt.id === adoptedId);
    const items: ParallelCleanupItem[] = [];
    for (const attempt of group.attempts) {
      if (attempt === kept || attempt.state.kind === "removed") continue;
      if (kept && attempt.branch === kept.branch)
        throw new Error("채택한 시도의 브랜치는 정리 대상이 될 수 없습니다.");
      const sessionId = attemptSessionId(attempt);
      if (sessionId && this.busy.has(sessionId))
        throw new Error(
          `시도 #${attempt.id}이(가) 아직 실행 중입니다. 멈춘 뒤에 정리하세요.`,
        );
      items.push({
        attemptId: attempt.id,
        ...(await inspectWorktree(this.git, root, attempt.branch, worktrees)),
        ...(sessionId ? { sessionId } : {}),
      });
    }
    return {
      groupId,
      ...(group.agentKind ? { agentKind: group.agentKind } : {}),
      ...(kept ? { keptBranch: kept.branch } : {}),
      items,
    };
  }

  /**
   * Removes exactly what the user confirmed. The plan is read again first: an
   * attempt that gained a commit or an edit after the dialog opened is not removed
   * on the strength of a confirmation that did not mention it.
   */
  async cleanup(
    groupId: string,
    confirmed: ParallelCleanupPlan,
  ): Promise<ParallelGroup> {
    if (this.cleaning.has(groupId))
      throw new Error("이 그룹은 이미 정리하는 중입니다.");
    this.cleaning.add(groupId);
    try {
      const plan = await this.cleanupPlan(groupId);
      if (JSON.stringify(plan) !== JSON.stringify(confirmed))
        throw new Error("확인한 뒤 정리 대상이 바뀌었습니다. 다시 시도하세요.");
      const root = await this.repositoryRoot(this.require(groupId).workspace);
      for (const item of plan.items) {
        this.assertRemovable(groupId, item);
        await removeWorktreeLeftovers(this.git, root, item);
        if (item.sessionId) this.options.host.hideSession(item.sessionId);
        this.apply(groupId, { type: "attempt.removed", attemptId: item.attemptId });
      }
      return this.require(groupId);
    } finally {
      this.cleaning.delete(groupId);
    }
  }

  /** The state this item was planned under, read again right before Git deletes it. */
  private assertRemovable(groupId: string, item: ParallelCleanupItem): void {
    const group = this.require(groupId);
    if (group.state.kind !== "adopted" && group.state.kind !== "discarded")
      throw new Error("그룹이 더 이상 정리할 수 있는 상태가 아닙니다.");
    const attempt = group.attempts.find((entry) => entry.id === item.attemptId);
    if (!attempt || attempt.branch !== item.branch)
      throw new Error(`시도 #${item.attemptId}의 기록이 바뀌었습니다.`);
    if (group.state.kind === "adopted" && group.state.attemptId === attempt.id)
      throw new Error("채택한 시도의 브랜치는 정리 대상이 될 수 없습니다.");
    if (item.sessionId && this.busy.has(item.sessionId))
      throw new Error(
        `시도 #${item.attemptId}이(가) 아직 실행 중입니다. 멈춘 뒤에 정리하세요.`,
      );
  }

  private rejectWhileCleaning(groupId: string): void {
    if (this.cleaning.has(groupId))
      throw new Error("시도를 정리하는 중에는 채택이나 모두 버리기를 할 수 없습니다.");
  }

  /** Whether some group still holds this branch for an attempt it has not cleaned up. */
  private branchHeld(branch: string): boolean {
    for (const group of this.groups.values())
      for (const attempt of group.attempts)
        if (attempt.branch === branch && attempt.state.kind !== "removed") return true;
    return false;
  }

  /** Session events from the controller: the only evidence that an attempt finished. */
  observe(event: AgentEvent): void {
    if (event.type === "session.deleted") {
      this.busy.delete(event.sessionId);
      return;
    }
    if (event.type !== "session.created" && event.type !== "session.updated") return;
    const { id, status, phase } = event.session;
    const working =
      status === "running" || status === "starting" || phase === "compacting";
    if (working || status === "waiting") this.busy.add(id);
    else this.busy.delete(id);
    if (!this.isAttemptSession(id)) return;
    if (working) this.working.add(id);
    else if (this.working.has(id) && (status === "idle" || status === "failed"))
      this.finished.add(id);
    this.settle();
  }

  private async run(group: ParallelGroup): Promise<void> {
    for (const attempt of group.attempts) {
      let session: AgentSession;
      try {
        session = await this.options.host.createSession({
          runtime: "gjc",
          title: `${group.title} · #${attempt.id} ${attempt.preset}`,
          workspace: group.workspace,
          isolation: "worktree",
          worktreeBranch: attempt.branch,
          modelPreset: attempt.preset,
        });
      } catch (error) {
        this.failAttempt(group.id, attempt.id, messageOf(error));
        continue;
      }
      try {
        this.apply(group.id, {
          type: "attempt.created",
          attemptId: attempt.id,
          sessionId: session.id,
          worktreePath: session.worktree?.path ?? session.workspace,
        });
      } catch (error) {
        // Recording failed (a full disk, say). The session exists but the request
        // was never sent, so the attempt is failed rather than left "creating".
        this.failAttempt(group.id, attempt.id, messageOf(error));
        continue;
      }
      this.send(group.id, attempt.id, session.id, group.prompt);
    }
    this.failAttempt(group.id, undefined, INTERRUPTED_REASON);
  }

  /**
   * A terminal agent's attempts (P6). GJC makes its worktree itself; for a terminal agent
   * the run makes it, the same way and in the same place (`<repo>.gajae-worktrees/`), and
   * opens the agent's session there. Each request goes in once the agent can take it.
   */
  private async runTerminalAgents(
    group: ParallelGroup,
    root: string,
    agentKind: AgentKindId,
    launch: Omit<AgentLaunchOptions, "model"> | undefined,
  ): Promise<void> {
    for (const attempt of group.attempts) {
      const worktreePath = path.join(
        path.dirname(root),
        `${path.basename(root)}.gajae-worktrees`,
        `best-of-${group.id.slice(0, 8)}-${attempt.id}`,
      );
      try {
        await addWorktree(this.git, root, worktreePath, attempt.branch, { existingBranch: false });
      } catch (error) {
        this.failAttempt(group.id, attempt.id, messageOf(error));
        continue;
      }
      const model = attempt.preset === PARALLEL_AGENT_DEFAULT_MODEL ? undefined : attempt.preset;
      const options = { ...launch, ...(model ? { model } : {}) };
      let session: AgentSession;
      try {
        session = await this.options.host.createSession({
          runtime: "herdr",
          agentKind,
          title: `${group.title} · #${attempt.id} ${attempt.preset}`,
          workspace: worktreePath,
          isolation: "workspace",
          ...(Object.keys(options).length > 0 ? { launch: options } : {}),
        });
      } catch (error) {
        // nothing ran in the worktree this run just made: it and its branch go with the attempt
        await discardNewWorktree(this.git, root, worktreePath, attempt.branch);
        this.failAttempt(group.id, attempt.id, messageOf(error));
        continue;
      }
      try {
        this.apply(group.id, { type: "attempt.created", attemptId: attempt.id, sessionId: session.id, worktreePath });
      } catch (error) {
        this.failAttempt(group.id, attempt.id, messageOf(error));
        continue;
      }
      this.sendWhenReady(group.id, attempt.id, session.id, group.prompt);
    }
    this.failAttempt(group.id, undefined, INTERRUPTED_REASON);
  }

  /**
   * One request per terminal agent attempt. A refusal (the agent showed a dialog) typed
   * nothing, so the host may try again until the agent takes it; what it finally answers
   * is what the attempt shows.
   */
  private sendWhenReady(groupId: string, attemptId: string, sessionId: string, prompt: string): void {
    const send = this.options.host.sendWhenReady;
    if (!send) return;
    const fail = (reason: string): void => {
      const attempt = this.groups.get(groupId)?.attempts.find((entry) => entry.id === attemptId);
      if (attempt?.state.kind !== "started") return;
      try {
        this.apply(groupId, { type: "attempt.failed", attemptId, reason });
      } catch (error) {
        if (!(error instanceof ParallelTransitionError)) throw error;
      }
    };
    this.track(
      send(sessionId, prompt).then(
        (delivery) => {
          if (typeof delivery === "object") fail(delivery.detail);
        },
        (error: unknown) => fail(messageOf(error)),
      ),
    );
  }

  /** Fails one attempt, or with no id every attempt still being created; never throws. */
  private failAttempt(groupId: string, attemptId: string | undefined, reason: string): void {
    try {
      this.apply(
        groupId,
        attemptId
          ? { type: "attempt.failed", attemptId, reason }
          : { type: "interrupted", reason },
      );
    } catch {
      // The store is unwritable or the group was decided; the in-memory record stands.
    }
  }

  /**
   * One send per attempt, never retried here: the controller gives each prompt a
   * fresh operation reference and never resends one whose outcome is unknown, so a
   * retry from this side is the only way the request could run twice.
   */
  private send(groupId: string, attemptId: string, sessionId: string, prompt: string): void {
    const fail = (reason: string): void => {
      const attempt = this.groups
        .get(groupId)
        ?.attempts.find((entry) => entry.id === attemptId);
      if (attempt?.state.kind !== "started") return;
      try {
        this.apply(groupId, { type: "attempt.failed", attemptId, reason });
      } catch (error) {
        // A decided group keeps the attempt as it was; the session shows the failure.
        if (!(error instanceof ParallelTransitionError)) throw error;
      }
    };
    this.track(
      this.options.host
        .sendMessage(sessionId, { text: prompt, images: [], files: [] })
        .then(
          (delivery) => {
            if (typeof delivery === "object") fail(delivery.detail);
          },
          (error: unknown) => fail(messageOf(error)),
        ),
    );
  }

  private settle(): void {
    for (const group of [...this.groups.values()]) {
      if (group.state.kind !== "running") continue;
      const done = group.attempts.every(
        (attempt) =>
          attempt.state.kind !== "started" ||
          this.finished.has(attempt.state.sessionId),
      );
      if (done) this.apply(group.id, { type: "settled" });
    }
  }

  private isAttemptSession(sessionId: string): boolean {
    for (const group of this.groups.values())
      for (const attempt of group.attempts)
        if (attemptSessionId(attempt) === sessionId) return true;
    return false;
  }

  private apply(groupId: string, event: ParallelGroupEvent): ParallelGroup {
    const next = applyParallelEvent(this.require(groupId), event);
    this.save(next);
    if (next.state.kind === "running") this.settle();
    return this.require(groupId);
  }

  private save(group: ParallelGroup): void {
    this.groups.set(group.id, group);
    this.options.store.putParallelGroup(group);
    this.options.notify?.(this.list());
  }

  private require(groupId: string): ParallelGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown parallel group: ${groupId}`);
    return group;
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
  }

  private async repositoryRoot(workspace: string): Promise<string> {
    const root = await repositoryRoot(this.git, workspace).catch(() => "");
    if (!root) throw new Error("병렬 실행은 Git 저장소에서만 쓸 수 있습니다.");
    return root;
  }

  private branchExists(root: string, branch: string): Promise<boolean> {
    return localBranchExists(this.git, root, branch);
  }
}
