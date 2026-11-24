import { useState } from "react";
import { t } from "../i18n";

/**
 * Ends every terminal session shell that keeps running in herdr-core after the app closes.
 * The desktop host asks for confirmation in its own dialog first.
 */
export function BackgroundTerminalsRow() {
  const bridge = window.agentControlDesktop?.terminal;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  if (typeof bridge?.killBackground !== "function") return null;
  const endAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const ended = await bridge.killBackground();
      setResult(
        ended > 0
          ? t`터미널 ${ended}개를 종료했습니다`
          : t("실행 중인 백그라운드 터미널이 없습니다"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult(/cancel/iu.test(message) ? "" : t("터미널을 종료하지 못했습니다"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gjc-update-row" data-background-terminals>
      <span>
        <strong>{t("백그라운드 터미널")}</strong>
        <small>
          {result ||
            t("터미널 세션의 셸은 앱을 닫아도 계속 실행됩니다. 여기서 모두 종료할 수 있습니다.")}
        </small>
      </span>
      <span className="gjc-update-actions">
        <button type="button" disabled={busy} onClick={() => void endAll()}>
          {busy ? t("종료하는 중…") : t("모두 종료")}
        </button>
      </span>
    </div>
  );
}
