import type { WorktreeSetupReport } from "../../shared/agent-contract";
import { t } from "../i18n";

const LAST_LINE_LIMIT = 200;

function copyReason(reason: string): string {
  switch (reason) {
    case "invalid":
      return t("경로가 올바르지 않음");
    case "not-a-file":
      return t("파일이 아님");
    case "symlink":
      return t("심볼릭 링크");
    case "outside":
      return t("폴더 밖을 가리킴");
    case "too-large":
      return t("너무 큼");
    case "failed":
      return t("복사하지 못함");
    default:
      return reason;
  }
}

/**
 * What the window says when a new worktree's setup did not go as asked. The session was
 * created either way, and the line says so: the user has to know the worktree may be missing
 * a file or a dependency, not that the session is lost.
 */
export function worktreeSetupMessage(report: WorktreeSetupReport): string {
  const parts = [t("새 worktree를 준비하는 중 문제가 있었습니다. 세션은 그대로 열었습니다.")];
  if (report.copyProblems && report.copyProblems.length > 0)
    parts.push(
      t("복사하지 못한 파일: {0}", {
        0: report.copyProblems.map((problem) => `${problem.path} (${copyReason(problem.reason)})`).join(", "),
      }),
    );
  const setup = report.setup;
  if (setup) {
    if (setup.status === "timeout") parts.push(t("setup 스크립트가 제한 시간 안에 끝나지 않아 중단했습니다."));
    else if (setup.status === "error") parts.push(t("setup 스크립트를 시작하지 못했습니다."));
    else if (setup.exitCode === undefined) parts.push(t("setup 스크립트가 중간에 중단되었습니다."));
    else parts.push(t("setup 스크립트가 종료 코드 {0}(으)로 끝났습니다.", { 0: setup.exitCode }));
    const last = setup.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (last) parts.push(t("마지막 출력: {0}", { 0: last.length > LAST_LINE_LIMIT ? `${last.slice(0, LAST_LINE_LIMIT)}…` : last }));
  }
  return parts.join(" ");
}
