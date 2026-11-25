import { useEffect, useRef, useState } from "react";
import { ChartPie, Shrink, SlidersHorizontal, X } from "lucide-react";
import type {
  ContextBreakdown,
  ContextCategoryId,
  RuntimeModeId,
  RuntimeModeState,
  SessionLiveStatus,
} from "../../shared/agent-contract";
import { t } from "../i18n";

/** 14.4K, 142K, 950K, 1.2M: a decimal only while it still says something. */
function tokenLabel(value: number): string {
  const short = (amount: number) => {
    const fixed = amount < 100 ? amount.toFixed(1) : amount.toFixed(0);
    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  };
  if (value >= 1_000_000) return `${short(value / 1_000_000)}M`;
  if (value >= 1000) return `${short(value / 1000)}K`;
  return String(Math.round(value));
}

function share(part: number, whole: number, digits = 1): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  if (value > 0 && value < 0.05) return "<0.1%";
  return `${value.toFixed(digits)}%`;
}

/** omp's categories as the dialog names them; an unknown one keeps omp's label. */
const CATEGORY_LABELS: Record<Exclude<ContextCategoryId, "other">, string> = {
  systemPrompt: "시스템 프롬프트",
  systemTools: "도구 정의",
  systemContext: "시스템 컨텍스트",
  instructionFiles: "지침 파일",
  skills: "스킬",
  messages: "대화 메시지",
};

function categoryLabel(category: ContextBreakdown["categories"][number]): string {
  return category.id === "other" ? category.label : t(CATEGORY_LABELS[category.id]);
}

function level(percent: number): "normal" | "warning" | "danger" {
  return percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";
}

const MODE_COPY: Record<RuntimeModeId, { label: string; detail: string }> = {
  fast: { label: "빠른 모드", detail: "지원하는 모델에서 우선 처리 등급으로 보냅니다" },
  slow: { label: "느린 모드", detail: "flex·낮은 우선순위 등급으로 싸게 보냅니다" },
  autoCompaction: { label: "자동 압축", detail: "컨텍스트가 차면 대화를 요약합니다" },
  autoRetry: { label: "자동 재시도", detail: "모델 호출이 실패하면 다시 시도합니다" },
};

/** omp's switches in a popover off the context bar. */
function RuntimeModes({ modes, onSetMode }: { modes: readonly RuntimeModeState[]; onSetMode: (id: RuntimeModeId, enabled: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const on = modes.filter((mode) => mode.enabled && (mode.id === "fast" || mode.id === "slow"));
  return (
    <span className="runtime-modes" ref={box}>
      <button
        type="button"
        className={`icon-button${on.length > 0 ? " is-active" : ""}`}
        title={t("실행 모드")}
        aria-label={t("실행 모드")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal size={12} />
      </button>
      {open && (
        <span className="runtime-modes-menu" role="dialog" aria-label={t("실행 모드")}>
          {modes.map((mode) => (
            <label key={mode.id} className="runtime-mode">
              <input type="checkbox" checked={mode.enabled} onChange={(event) => onSetMode(mode.id, event.target.checked)} />
              <span className="runtime-mode-copy">
                <strong>{t(MODE_COPY[mode.id].label)}</strong>
                <small>{t(MODE_COPY[mode.id].detail)}</small>
                {mode.inactive && <small className="runtime-mode-note">{t("이 모델에는 적용되지 않습니다")}</small>}
                {mode.assumed && <small className="runtime-mode-note">{t("omp가 상태를 알려주지 않아 기본값으로 보입니다")}</small>}
              </span>
            </label>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * The thin line above the composer: how full the context window is, a way into the
 * breakdown, compaction now, the runtime's switches, and the window's size (omp's chat).
 */
export function ContextBar({
  status,
  onOpen,
  onCompact,
  onSetMode,
}: {
  status: SessionLiveStatus;
  onOpen: () => void;
  onCompact?: () => void;
  onSetMode?: (id: RuntimeModeId, enabled: boolean) => void;
}) {
  const percent = status.contextPercent;
  if (percent === undefined) return null;
  const used =
    status.contextTokens !== undefined && status.contextWindow !== undefined
      ? t`${tokenLabel(status.contextTokens)} / ${tokenLabel(status.contextWindow)} 토큰`
      : undefined;
  return (
    <div className={`context-bar context-bar--${level(percent)}`}>
      <button
        type="button"
        className="context-bar-meter"
        title={used ? t`컨텍스트 ${used} · 눌러서 자세히 보기` : t("컨텍스트 자세히 보기")}
        aria-label={t`컨텍스트 ${Math.round(percent)}% 사용 · 자세히 보기`}
        onClick={onOpen}
      >
        <span className="context-bar-percent">{Math.round(percent)}%</span>
        <span className="context-bar-track" aria-hidden="true">
          <span className="context-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </span>
      </button>
      <span className="context-bar-actions">
        <button
          type="button"
          className="icon-button"
          title={t("카테고리별 컨텍스트 보기")}
          aria-label={t("카테고리별 컨텍스트 보기")}
          onClick={onOpen}
        >
          <ChartPie size={12} />
        </button>
        {onCompact && (
          <button
            type="button"
            className="icon-button"
            title={t("지금 압축: 대화를 요약해 컨텍스트를 비웁니다")}
            aria-label={t("지금 압축")}
            onClick={onCompact}
          >
            <Shrink size={12} />
          </button>
        )}
        {onSetMode && status.modes && status.modes.length > 0 && <RuntimeModes modes={status.modes} onSetMode={onSetMode} />}
        {status.contextWindow !== undefined && (
          <span className="context-bar-window" title={t("모델의 컨텍스트 창 크기")}>
            {tokenLabel(status.contextWindow)}
          </span>
        )}
      </span>
    </div>
  );
}

type Loaded = { state: "loading" } | { state: "ready"; breakdown: ContextBreakdown | null } | { state: "failed"; error: string };

function roomLine(breakdown: ContextBreakdown): string {
  const { autoCompactAtTokens: at, usedTokens: used, contextWindow: window } = breakdown;
  if (at === undefined) return t`${tokenLabel(breakdown.freeTokens)} 남음`;
  if (used >= at) return t`자동 압축 지점(${share(at, window, 0)})을 지났습니다`;
  return t`자동 압축까지 ${tokenLabel(at - used)} 남음 (${share(at, window, 0)})`;
}

function Breakdown({ breakdown }: { breakdown: ContextBreakdown }) {
  const { contextWindow: window, usedTokens: used, autoCompactBufferTokens: buffer, autoCompactAtTokens: at } = breakdown;
  const width = (tokens: number) => `${window > 0 ? (tokens / window) * 100 : 0}%`;
  return (
    <>
      <div className="context-dialog-summary">
        <p className="context-dialog-used">
          <strong>{tokenLabel(used)}</strong>
          <span>{t`/ ${tokenLabel(window)} 토큰 · ${share(used, window, 0)}`}</span>
        </p>
        <p className="context-dialog-room">{roomLine(breakdown)}</p>
      </div>
      <div className="context-dialog-meter" role="img" aria-label={t("카테고리별 컨텍스트 사용량")}>
        {breakdown.categories
          .filter((category) => category.tokens > 0)
          .map((category) => (
            <span
              key={`${category.id}-${category.label}`}
              className={`context-segment context-cat--${category.id}`}
              style={{ width: width(category.tokens) }}
              title={`${categoryLabel(category)} · ${tokenLabel(category.tokens)} (${share(category.tokens, window)})`}
            />
          ))}
        <span className="context-segment context-segment--free" style={{ width: width(breakdown.freeTokens) }} />
        {buffer > 0 && (
          <span
            className="context-segment context-segment--buffer"
            style={{ width: width(buffer) }}
            title={t`자동 압축 여유분 · ${tokenLabel(buffer)} (${share(buffer, window)})`}
          />
        )}
        {at !== undefined && (
          <i
            className="context-dialog-mark"
            style={{ left: width(at) }}
            title={t`자동 압축 시작 ${share(at, window, 0)} · ${tokenLabel(at)} 토큰`}
          />
        )}
      </div>
      <ul className="context-dialog-rows">
        {breakdown.categories.map((category) => (
          <li key={`${category.id}-${category.label}`} className={category.tokens === 0 ? "is-empty" : undefined}>
            <i className={`context-dot context-cat--${category.id}`} aria-hidden="true" />
            <span className="context-dialog-label">{categoryLabel(category)}</span>
            <span className="context-dialog-tokens">{tokenLabel(category.tokens)}</span>
            <span className="context-dialog-share">{share(category.tokens, window)}</span>
          </li>
        ))}
        {buffer > 0 && (
          <li className="context-dialog-reserve">
            <i className="context-dot context-segment--buffer" aria-hidden="true" />
            <span className="context-dialog-label">{t("자동 압축 여유분")}</span>
            <span className="context-dialog-tokens">{tokenLabel(buffer)}</span>
            <span className="context-dialog-share">{share(buffer, window)}</span>
          </li>
        )}
        <li className="context-dialog-reserve">
          <i className="context-dot context-segment--free" aria-hidden="true" />
          <span className="context-dialog-label">{t("남은 공간")}</span>
          <span className="context-dialog-tokens">{tokenLabel(breakdown.freeTokens)}</span>
          <span className="context-dialog-share">{share(breakdown.freeTokens, window)}</span>
        </li>
      </ul>
      <p className="context-dialog-note">
        {t("토큰 수는 omp가 추정한 값입니다. 대화 메시지를 사용자·어시스턴트·생각·도구별로 나눈 값은 omp가 RPC로 알려주지 않습니다.")}
      </p>
      {breakdown.notes.length > 0 && <pre className="context-dialog-omp-notes">{breakdown.notes.join("\n")}</pre>}
    </>
  );
}

/** "컨텍스트": what fills the window by category, as omp counts it, read when the dialog opens. */
export function ContextDialog({
  load,
  onClose,
  onCompact,
}: {
  load: () => Promise<ContextBreakdown | null>;
  onClose: () => void;
  onCompact?: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let current = true;
    load().then(
      (breakdown) => current && setLoaded({ state: "ready", breakdown }),
      (error: unknown) => current && setLoaded({ state: "failed", error: error instanceof Error ? error.message : String(error) }),
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
  const breakdown = loaded.state === "ready" ? loaded.breakdown : null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="context-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("컨텍스트")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{t("컨텍스트")}</strong>
          {breakdown?.model && <code title={t("이 컨텍스트 창의 모델")}>{breakdown.model}</code>}
          <button type="button" className="icon-button" aria-label={t("닫기")} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="context-dialog-body">
          {loaded.state === "loading" && (
            <div className="context-dialog-status">
              <span className="mini-spinner" />
              <small>{t("omp에 컨텍스트를 묻는 중…")}</small>
            </div>
          )}
          {loaded.state === "failed" && <p className="diff-error">{loaded.error}</p>}
          {loaded.state === "ready" && !breakdown && (
            <p className="context-dialog-status">{t("omp가 이 대화의 컨텍스트를 알려주지 않았습니다. 선택된 모델이 없을 수 있습니다.")}</p>
          )}
          {breakdown && <Breakdown breakdown={breakdown} />}
        </div>
        <footer>
          {onCompact && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                onCompact();
                onClose();
              }}
            >
              <Shrink size={13} />
              {t("지금 압축")}
            </button>
          )}
          <button type="button" className="button-primary" onClick={onClose}>
            {t("닫기")}
          </button>
        </footer>
      </section>
    </div>
  );
}
