import {
  GAJAE_PROGRESS_ROW_HEIGHT,
  QUIET_AFTER_MS,
  ROTATING_WORK_LABELS,
  elapsedTurnMs,
  gajaeEmoticonFor,
  type TurnActivityKind,
  type TurnApproval,
  type TurnClock,
} from "../transcript-utils";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { t, useLanguage } from "../i18n";
import { LoginHintContext } from "./login-hint";
import { formatDuration } from "./format";
import type { SessionRetry } from "../backend/types";


const LABEL_ROTATE_MS = 2400;

/**
 * How long the running turn has worked, when it last produced anything once it has
 * been quiet for a while, and whether a message sent into it is still unread. The
 * one-second tick re-renders only this text.
 */
function WorkingMeta({
  clock,
  activityAt,
  queuedMessage,
}: {
  clock: TurnClock;
  activityAt: number;
  queuedMessage: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const idle = now - activityAt;
  const parts = [formatDuration(elapsedTurnMs(clock, now))];
  if (idle >= QUIET_AFTER_MS) parts.push(t`마지막 활동 ${formatDuration(idle)} 전`);
  if (queuedMessage) parts.push(t("보낸 메시지는 지금 단계가 끝나면 읽힙니다"));
  return <span className="gajae-progress-meta">{parts.join(" · ")}</span>;
}

/**
 * GJC's wait before it sends a failed model call again: which attempt, how long
 * until it fires, and why the last one failed. Either button ends the wait.
 */
function RetryMeta({
  retry,
  onControl,
}: {
  retry: SessionRetry;
  onControl?: (action: "now" | "abort") => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const key = `${retry.attempt}:${retry.retryAt}`;
  const remaining = retry.retryAt - now;
  const parts = [
    retry.maxAttempts === undefined
      ? t`재시도 ${retry.attempt}회째`
      : t`재시도 ${retry.attempt}/${retry.maxAttempts}`,
    remaining >= 1000 ? t`${formatDuration(remaining)} 후` : t("곧 다시 보냄"),
  ];
  const error = retry.error?.split("\n", 1)[0];
  const control = (action: "now" | "abort") => {
    setSent(key);
    onControl?.(action);
  };
  return (
    <>
      <span className="gajae-progress-meta" title={retry.error}>
        {parts.join(" · ")}
        {error && <span className="gajae-progress-error"> · {error}</span>}
      </span>
      {onControl && (
        <span className="gajae-progress-actions">
          <button
            type="button"
            className="gajae-progress-button"
            disabled={sent === key}
            onClick={() => control("abort")}
          >
            {t("재시도 취소")}
          </button>
          <button
            type="button"
            className="gajae-progress-button is-allow"
            disabled={sent === key}
            onClick={() => control("now")}
          >
            {t("지금 재시도")}
          </button>
        </span>
      )}
    </>
  );
}

export interface GajaeProgressRowProps {
  kind: TurnActivityKind;
  label?: string;
  /** The turn's clock. A running row shows its elapsed time. */
  clock?: TurnClock;
  /** When the turn last produced anything. */
  activityAt?: number;
  queuedMessage?: boolean;
  /** GJC is waiting to retry a failed model call. Replaces the elapsed time. */
  retry?: SessionRetry;
  onControlRetry?: (action: "now" | "abort") => void;
  approval?: TurnApproval;
  onResolve?: (toolId: string, optionId: string) => void;
  onRetry?: () => void;
}

/**
 * The current turn's state at the end of the conversation: its phrase, elapsed
 * time and any action it is waiting on. A running phrase shimmers; no mark or
 * sprite animates beside it.
 *
 * Kind and label are the only inputs that come from the transcript. The rotating
 * phrase updates inside this row, so a label swap does not re-render the conversation.
 */
export const GajaeProgressRow = memo(function GajaeProgressRow({
  kind,
  label,
  clock,
  activityAt,
  queuedMessage = false,
  retry,
  onControlRetry,
  approval,
  onResolve,
  onRetry,
}: GajaeProgressRowProps) {
  useLanguage();
  const { needsSignIn, openLogin } = useContext(LoginHintContext);
  // A turn that fails on a Mac with no signed-in provider failed for that reason;
  // GJC's own error says nothing the user can act on.
  const loginCause = kind === "error" && needsSignIn && openLogin !== undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const [labelIndex, setLabelIndex] = useState(0);
  const rotates = (kind === "thinking" || kind === "tool") && label === undefined;
  const emoticon = gajaeEmoticonFor(kind);
  const shimmer = kind === "thinking" || kind === "tool";
  const shownLabel = loginCause
    ? t("로그인한 AI가 없어 실행하지 못했어요")
    : rotates
    ? t(ROTATING_WORK_LABELS[labelIndex] ?? ROTATING_WORK_LABELS[0])
    : (label ?? (kind === "done" ? t("완료") : ""));

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let rotateTimer = 0;
    let onScreen = true;

    const stopTimers = (): void => {
      window.clearInterval(rotateTimer);
      rotateTimer = 0;
    };
    const sync = (): void => {
      const tabHidden = typeof document !== "undefined" && document.hidden;
      const paused = tabHidden || !onScreen;
      root.classList.toggle("is-paused", paused);
      stopTimers();
      if (paused || !rotates) return;
      rotateTimer = window.setInterval(() => {
        setLabelIndex((index) => (index + 1) % ROTATING_WORK_LABELS.length);
      }, LABEL_ROTATE_MS);
    };

    const onVisibility = (): void => sync();
    document.addEventListener("visibilitychange", onVisibility);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries[0]?.isIntersecting ?? true;
            sync();
          });
    observer?.observe(root);
    sync();
    return () => {
      stopTimers();
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [rotates]);

  return (
    <div
      ref={rootRef}
      className={`gajae-progress gajae-progress--${kind}`}
      style={{ height: GAJAE_PROGRESS_ROW_HEIGHT }}
      data-kind={kind}
      data-emoticon={emoticon}
    >
      <div className="gajae-progress-live">
        <span
          className={`gajae-progress-label${shimmer ? " is-shimmer" : ""}`}
          aria-live="polite"
        >
          {shownLabel}
        </span>
        {retry && kind === "thinking" ? (
          <RetryMeta retry={retry} onControl={onControlRetry} />
        ) : (
          clock && activityAt !== undefined && (kind === "thinking" || kind === "tool") && (
            <WorkingMeta clock={clock} activityAt={activityAt} queuedMessage={queuedMessage} />
          )
        )}
        {kind === "approval" && approval && (approval.deny || approval.allow) && (
          <span className="gajae-progress-actions">
            {approval.deny && (
              <button
                type="button"
                className="gajae-progress-button"
                onClick={() => {
                  const deny = approval.deny;
                  if (deny) onResolve?.(approval.toolId, deny.optionId);
                }}
              >
                {t("거절")} </button>
            )}
            {approval.allow && (
              <button
                type="button"
                className="gajae-progress-button is-allow"
                onClick={() => {
                  const allow = approval.allow;
                  if (allow) onResolve?.(approval.toolId, allow.optionId);
                }}
              >
                {t("허용")} </button>
            )}
          </span>
        )}
        {loginCause && (
          <button type="button" className="gajae-progress-button is-allow" onClick={openLogin}>
            {t("AI 로그인")}
          </button>
        )}
        {kind === "error" && onRetry && (
          <button type="button" className="gajae-progress-button" onClick={onRetry}>
            {t("다시 시도")} </button>
        )}
      </div>
    </div>
  );
});
