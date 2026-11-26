import type { TurnDiffState } from "../../shared/turn-diff";
import { locale, t } from "../i18n";

/** Why the latest turn cannot be read alone, in words that say what to do about it. */
export function turnDiffReasonText(state: Extract<TurnDiffState, { state: "unavailable" }>): string {
  switch (state.reason) {
    case "no-turn":
      return t("아직 이 세션의 턴이 시작되는 것을 보지 못했습니다. 다음 요청부터 그 시점을 기록합니다.");
    case "unsupported":
      return t("이 에이전트는 턴이 시작되는 때를 알려 주지 않아 이번 턴만 볼 수 없습니다.");
    case "not-git":
      return t("Git 저장소가 아닌 폴더라 이번 턴만 볼 수 없습니다.");
    case "too-large":
      return t("저장소가 커서 이번 턴만 보는 기능을 껐습니다.");
    case "lost":
      return t("기록해 둔 시점의 파일 상태를 Git에서 찾지 못했습니다. 다음 요청부터 다시 기록합니다.");
    case "failed": {
      const text = t("이번 턴이 시작된 시점을 기록하지 못했습니다.");
      return state.detail ? `${text} (${state.detail})` : text;
    }
  }
}

/** Which turn a diff is of, by when it began. */
export function turnStartLabel(startedAt: string): string {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return t("이번 턴의 변경");
  const time = started.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return t("{time}에 시작한 턴의 변경", { time });
}
