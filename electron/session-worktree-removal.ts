import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import type { AgentSession, ManagedWorktree, WorktreeRemovalOutcome } from "../shared/agent-contract.js";
import type { ConfirmContent } from "./confirm-overlay.js";
import { hostFormat, hostText } from "./host-text.js";
import {
  planWorktreeRemoval,
  removeSessionWorktree,
  runGit,
  type GitRunner,
  type WorktreeRemovalPlan,
} from "./worktree-service.js";

/**
 * What happens to the worktree this app made for a session when the user deletes the session.
 *
 * The user is asked, with every loss named, only when the worktree is this app's to remove
 * and no other session is using it. What they agreed to is read again after the session is gone
 * (its agent has stopped writing by then) and carried out only if it is exactly what they were
 * shown. Nothing here can remove a folder that is not a worktree this app made, the
 * repository's own working tree, or a branch this app did not make.
 */

/** What the user agreed to remove with a session. */
export interface SessionWorktreeDecision {
  sessionId: string;
  worktree: ManagedWorktree;
  plan: WorktreeRemovalPlan;
}

/** How long an answer waits for the delete it belongs to. */
const ANSWER_TTL_MS = 2 * 60_000;

/** Whether a session works in a worktree: its folder is the worktree or inside it, or it was recorded in it. */
export function usesWorktree(session: Pick<AgentSession, "workspace" | "worktree">, worktreePath: string): boolean {
  const target = path.resolve(worktreePath);
  if (session.worktree && path.resolve(session.worktree.path) === target) return true;
  const workspace = path.resolve(session.workspace);
  return workspace === target || workspace.startsWith(`${target}${path.sep}`);
}

/** The question: every loss the removal causes is in it. */
export function worktreeRemovalConfirmation(plan: WorktreeRemovalPlan): ConfirmContent {
  const lines: string[] = [];
  if (plan.worktreeMissing)
    lines.push(hostFormat("worktree 폴더가 이미 없어 Git의 기록만 정리합니다: {0}", [plan.worktreePath]));
  else if (plan.uncommittedFiles > 0)
    lines.push(
      hostFormat("worktree 삭제: {0} (커밋하지 않은 변경 {1}개가 사라집니다)", [plan.worktreePath, plan.uncommittedFiles]),
    );
  else lines.push(hostFormat("worktree 삭제: {0}", [plan.worktreePath]));
  if (plan.detachedCommits > 0)
    lines.push(hostFormat("브랜치에 속하지 않은 커밋 {0}개가 사라집니다", [plan.detachedCommits]));
  if (plan.branch)
    lines.push(
      plan.branch.unpushedCommits > 0
        ? hostFormat("브랜치 삭제: {0} (push하지 않은 커밋 {1}개가 사라집니다)", [plan.branch.name, plan.branch.unpushedCommits])
        : hostFormat("브랜치 삭제: {0}", [plan.branch.name]),
    );
  if (plan.keptBranch) lines.push(hostFormat("브랜치 {0}은(는) 그대로 둡니다", [plan.keptBranch]));
  lines.push("", hostText("세션은 지우기로 했습니다. 남겨 두기를 고르면 worktree와 브랜치는 그대로 둡니다."));
  return {
    message: "이 세션의 worktree도 지울까요?",
    detail: lines.join("\n"),
    confirmLabel: "worktree도 지우기",
    cancelLabel: "남겨 두기",
    danger: true,
  };
}

type Assessment = { kind: "none" } | { kind: "shared" } | { kind: "removable"; plan: WorktreeRemovalPlan };

export class SessionWorktreeRemoval {
  private readonly answers = new Map<string, { decision: SessionWorktreeDecision | undefined; expires: number }>();
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      /** Every session the app lists, whatever runtime runs it. */
      listSessions(): Promise<readonly AgentSession[]>;
      confirm(event: IpcMainInvokeEvent, content: ConfirmContent): Promise<boolean>;
      git?: GitRunner;
      now?: () => number;
    },
  ) {
    this.git = options.git ?? runGit;
    this.now = options.now ?? Date.now;
  }

  /**
   * Asks now, for the delete that follows: the window confirms a removal before it drops the
   * row, and the delete then uses that answer instead of asking again. Never rejects.
   */
  async remember(event: IpcMainInvokeEvent, sessionId: string): Promise<void> {
    const decision = await this.offer(event, sessionId);
    this.answers.set(this.key(event, sessionId), { decision, expires: this.now() + ANSWER_TTL_MS });
  }

  /** The answer given ahead, or a new question when there was none. Never rejects. */
  async decide(event: IpcMainInvokeEvent, sessionId: string): Promise<SessionWorktreeDecision | undefined> {
    const key = this.key(event, sessionId);
    const given = this.answers.get(key);
    this.answers.delete(key);
    if (given && given.expires >= this.now()) return given.decision;
    return this.offer(event, sessionId);
  }

  /**
   * Removes what the user agreed to, now that the session and its agent are gone. The worktree is
   * read once more: another session in it, or any change to what the user was shown, keeps it.
   */
  async run(decision: SessionWorktreeDecision): Promise<WorktreeRemovalOutcome> {
    let sessions: readonly AgentSession[];
    try {
      sessions = await this.options.listSessions();
    } catch (error) {
      return { status: "kept", reason: "failed", detail: message(error) };
    }
    const assessment = await this.assess(decision.worktree, decision.sessionId, sessions);
    if (assessment.kind === "shared") return { status: "kept", reason: "shared" };
    if (assessment.kind === "none" || JSON.stringify(assessment.plan) !== JSON.stringify(decision.plan))
      return { status: "kept", reason: "changed" };
    try {
      const result = await removeSessionWorktree(this.git, assessment.plan);
      return {
        status: "removed",
        ...(result.branchKept ? { branchKept: result.branchKept } : {}),
        ...(result.branchError ? { detail: result.branchError } : {}),
      };
    } catch (error) {
      return { status: "kept", reason: "failed", detail: message(error) };
    }
  }

  private key(event: IpcMainInvokeEvent, sessionId: string): string {
    return `${event.sender.id}:${sessionId}`;
  }

  private async offer(event: IpcMainInvokeEvent, sessionId: string): Promise<SessionWorktreeDecision | undefined> {
    try {
      const sessions = await this.options.listSessions();
      const worktree = sessions.find((session) => session.id === sessionId)?.worktree;
      if (!worktree?.managed) return undefined;
      const assessment = await this.assess(worktree, sessionId, sessions);
      if (assessment.kind !== "removable") return undefined;
      const agreed = await this.options.confirm(event, worktreeRemovalConfirmation(assessment.plan));
      return agreed ? { sessionId, worktree, plan: assessment.plan } : undefined;
    } catch {
      // not being able to ask is not a reason to keep the user from deleting the session
      return undefined;
    }
  }

  private async assess(
    worktree: ManagedWorktree,
    sessionId: string,
    sessions: readonly AgentSession[],
  ): Promise<Assessment> {
    if (sessions.some((session) => session.id !== sessionId && usesWorktree(session, worktree.path)))
      return { kind: "shared" };
    const plan = await planWorktreeRemoval(this.git, worktree);
    return plan ? { kind: "removable", plan } : { kind: "none" };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
