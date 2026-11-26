import type { WorktreeRemovalOutcome } from "../../shared/agent-contract";
import { t } from "../i18n";

/**
 * What the window says about a session's worktree after the user asked for it to be removed
 * with the session, when it did not all go as asked; undefined when the worktree is gone.
 * The session is deleted either way, and the line says only what is still on disk.
 */
export function worktreeRemovalMessage(outcome: WorktreeRemovalOutcome): string | undefined {
  const detail = outcome.detail ? ` ${outcome.detail}` : "";
  if (outcome.status === "removed")
    return outcome.branchKept
      ? t("worktree는 지웠지만 브랜치 {0}은(는) 지우지 못했습니다.{1}", { 0: outcome.branchKept, 1: detail })
      : undefined;
  switch (outcome.reason) {
    case "shared":
      return t("다른 세션이 이 worktree를 쓰고 있어 지우지 않았습니다. 세션만 지웠습니다.");
    case "changed":
      return t("확인한 뒤 worktree의 내용이 바뀌어 지우지 않았습니다. 세션만 지웠습니다. 저장소 화면에서 확인할 수 있습니다.");
    default:
      return t("worktree를 지우지 못했습니다. 세션만 지웠습니다.{0}", { 0: detail });
  }
}
