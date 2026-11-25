import { useEffect, useState } from "react";
import { CornerDownRight, GitFork, ListTree, PencilLine, X } from "lucide-react";
import type { SessionTreeEntry } from "../../shared/agent-contract";
import { t } from "../i18n";

const ROLE_LABEL: Record<SessionTreeEntry["role"], string> = {
  user: "나",
  assistant: "응답",
  tool: "도구",
  compaction: "압축 요약",
  branch_summary: "갈래 요약",
};

type Loaded = { state: "loading" } | { state: "ready"; entries: SessionTreeEntry[] } | { state: "failed"; error: string };

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

/**
 * "대화 트리": the conversation's entries as omp keeps them, branches indented under the point
 * they left, the current branch marked. Any entry: move the conversation there, in the same file
 * (the chat then shows that branch only). A message of yours: rewrite it (the conversation moves to
 * before it, its text in the composer), or fork a new chat that ends there.
 */
export function SessionTreeDialog({
  load,
  onFork,
  onNavigate,
  onClose,
}: {
  load: () => Promise<SessionTreeEntry[]>;
  onFork?: (entry: SessionTreeEntry) => Promise<unknown>;
  /** Moves the conversation to the entry; a user message's text goes to the composer. */
  onNavigate?: (entry: SessionTreeEntry) => Promise<unknown>;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    load().then(
      (entries) => current && setLoaded({ state: "ready", entries }),
      (failure: unknown) => current && setLoaded({ state: "failed", error: errorText(failure) }),
    );
    return () => {
      current = false;
    };
  }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const act = async (entry: SessionTreeEntry, work: (entry: SessionTreeEntry) => Promise<unknown>) => {
    setBusy(entry.id);
    setError("");
    try {
      await work(entry);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="session-tree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("대화 트리")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <ListTree size={15} aria-hidden="true" />
          <strong>{t("대화 트리")}</strong>
          <button type="button" className="icon-button" aria-label={t("닫기")} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="session-tree-body">
          {loaded.state === "loading" && (
            <div className="context-dialog-status">
              <span className="mini-spinner" />
              <small>{t("omp에 대화 트리를 묻는 중…")}</small>
            </div>
          )}
          {loaded.state === "failed" && <p className="diff-error">{loaded.error}</p>}
          {loaded.state === "ready" && loaded.entries.length === 0 && (
            <p className="context-dialog-status">{t("아직 대화가 없습니다")}</p>
          )}
          {loaded.state === "ready" && loaded.entries.length > 0 && (
            <ol className="session-tree-list">
              {loaded.entries.map((entry) => (
                <li
                  key={entry.id}
                  className={`session-tree-entry session-tree-entry--${entry.role}${entry.onPath ? " is-on-path" : ""}${entry.current ? " is-current" : ""}`}
                  style={{ paddingLeft: `${10 + entry.depth * 16}px` }}
                >
                  <span className="session-tree-role">{t(ROLE_LABEL[entry.role])}</span>
                  <span className="session-tree-text" title={entry.text}>
                    {entry.label && <em>{entry.label}</em>}
                    {entry.text || "…"}
                  </span>
                  {entry.current && <span className="session-tree-here">{t("지금 여기")}</span>}
                  {(onFork || onNavigate) && (entry.role === "user" || !entry.current) && (
                    <span className="session-tree-actions">
                      {onNavigate && entry.role === "user" && entry.rewritable && (
                        <button type="button" disabled={busy !== null} title={t("이 메시지 전으로 대화를 옮기고 내용을 입력창에 넣습니다")} onClick={() => void act(entry, onNavigate)}>
                          <PencilLine size={12} aria-hidden="true" /> {t("여기서 다시 쓰기")}
                        </button>
                      )}
                      {onNavigate && entry.role !== "user" && !entry.current && (
                        <button type="button" disabled={busy !== null} title={t("대화를 이 지점으로 옮깁니다 (같은 세션 파일 안에서)")} onClick={() => void act(entry, onNavigate)}>
                          <CornerDownRight size={12} aria-hidden="true" /> {t("여기로 이동")}
                        </button>
                      )}
                      {onFork && entry.role === "user" && (
                        <button type="button" disabled={busy !== null} title={t("이 메시지까지를 새 채팅으로 복사합니다")} onClick={() => void act(entry, onFork)}>
                          <GitFork size={12} aria-hidden="true" /> {t("여기까지 포크")}
                        </button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {error && <p className="diff-error">{error}</p>}
        </div>
      </section>
    </div>
  );
}
