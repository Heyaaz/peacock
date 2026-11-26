import type { PullRequestFailure } from "../../shared/pull-request";
import type { GithubFailureState, RepoCiSummary } from "../../shared/repo-ipc";
import { t } from "../i18n";

/**
 * Words for GitHub's answers, shared by the repository screen and the diff panel's pull request step.
 * They live apart from `repo-view.tsx`, which is loaded on demand, so the panel does not pull it in.
 */

/**
 * Why GitHub could not answer, in words the user can act on.
 *
 * The six causes are six different fixes -- add a remote, move to GitHub, install
 * `gh`, log in, get back online, retry -- so they never share a sentence.
 */
export function githubFailureText(failure: GithubFailureState): string {
  switch (failure) {
    case "no-remote":
      return t("원격 저장소가 없습니다. 이 프로젝트는 로컬에만 있습니다.");
    case "not-github":
      return t("GitHub 저장소가 아닙니다. 이슈와 풀 리퀘스트는 GitHub에서만 조회합니다.");
    case "no-cli":
      return t("GitHub CLI(gh)를 찾을 수 없습니다. 설치하면 이슈와 풀 리퀘스트를 볼 수 있습니다.");
    case "unauthenticated":
      return t("GitHub에 로그인되어 있지 않습니다. 터미널에서 gh auth login을 실행하세요.");
    case "unreachable":
      return t("GitHub에 연결하지 못했습니다. 네트워크 상태를 확인하세요.");
    case "error":
      return t("GitHub에서 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }
}

export function ciLabel(ci: RepoCiSummary): string {
  switch (ci.state) {
    case "passing":
      return t("CI 통과");
    case "failing":
      return ci.total > 0 ? t`CI 실패 ${ci.failing}/${ci.total}` : t("CI 실패");
    case "pending":
      return ci.total > 0 ? t`CI 진행 중 ${ci.pending}/${ci.total}` : t("CI 진행 중");
    case "none":
      return t("CI 없음");
  }
}

/** Why a pull request cannot be looked up or opened, in words that say what to do next. */
export function pullRequestFailureText(failure: PullRequestFailure): string {
  switch (failure.state) {
    case "default-branch":
      return t("기본 브랜치({branch})에서는 Pull request를 만들 수 없습니다. 작업 브랜치에서 만드세요.", {
        branch: failure.branch,
      });
    case "not-pushed":
      return t("Push하지 않은 커밋이 있습니다. 먼저 Push하세요.");
    case "no-branch":
      return t("브랜치가 없는 상태(detached HEAD)라 Pull request를 만들 수 없습니다.");
    default: {
      const text = githubFailureText(failure.state);
      return "detail" in failure && failure.detail ? `${text} (${failure.detail})` : text;
    }
  }
}
