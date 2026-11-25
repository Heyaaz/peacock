import { X } from "lucide-react";
import type { QueuedMessage } from "../../shared/agent-contract";
import { t } from "../i18n";

/**
 * What the runtime itself holds for the running turn (omp's steering and follow-up queue),
 * with "지금 보내기" for a follow-up and × to take a message out. The composer's own held
 * requests are its queue list; these were already handed to the runtime.
 */
export function RuntimeQueue({
  queued,
  onPromote,
  onRemove,
}: {
  queued: readonly QueuedMessage[];
  onPromote: (message: QueuedMessage) => void;
  onRemove: (message: QueuedMessage) => void;
}) {
  if (queued.length === 0) return null;
  return (
    <div className="composer-queue runtime-queue" aria-label={t("omp가 들고 있는 메시지")}>
      <div className="composer-queue-items">
        {queued.map((message) => (
          <span key={message.id} className={`composer-queue-item composer-queue-item--${message.mode === "steer" ? "steer" : "queue"}`}>
            <em className="runtime-queue-mode">{message.mode === "steer" ? t("다음 단계에 전달") : t("턴 뒤에 전달")}</em>
            <span className="composer-queue-text" title={message.text}>
              {message.label}
            </span>
            <button type="button" className="composer-queue-discard" aria-label={t("대기 항목 버리기")} onClick={() => onRemove(message)}>
              <X size={10} />
            </button>
            {message.mode === "followUp" && (
              <button type="button" className="composer-queue-send" onClick={() => onPromote(message)}>
                {t("지금 보내기")}
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
