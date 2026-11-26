import { useEffect, useState } from "react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type { AppUpdateStatus } from "../../shared/app-update";
import { t } from "../i18n";

function appUpdateSummary(status: AppUpdateStatus): string {
  switch (status.state) {
    case "unchecked":
      return t`${status.currentVersion} · 아직 확인하지 않았습니다`;
    case "current":
      return t`최신 버전 ${status.currentVersion}`;
    case "available":
      return t`${status.currentVersion} → ${status.latestVersion} 사용 가능`;
    case "unknown":
      return t`${status.currentVersion} · 확인할 수 없음`;
  }
}

/**
 * The Gajae release status in the desktop tab.
 *
 * A failed check is shown as "cannot check" and nothing else: the release may be
 * unpublished or the network down, and neither is something to fix from here.
 */
export function AppUpdateRow({
  bridge,
}: {
  bridge:
    | (Pick<SettingsDesktopBridge, "getAppUpdateStatus" | "checkAppUpdate"> & {
        /** Absent on a host from before in-app updates. */
        installAppUpdate?: SettingsDesktopBridge["installAppUpdate"];
      })
    | undefined;
}) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (typeof bridge?.getAppUpdateStatus !== "function") return;
    let active = true;
    void bridge
      .getAppUpdateStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);

  async function checkNow(): Promise<void> {
    if (!bridge) return;
    setChecking(true);
    try {
      setStatus(await bridge.checkAppUpdate());
    } catch {
      // The previous status stays; a refused check is not news.
    } finally {
      setChecking(false);
    }
  }

  async function installNow(): Promise<void> {
    if (!bridge?.installAppUpdate || status?.state !== "available") return;
    setInstalling(true);
    try {
      await bridge.installAppUpdate();
    } catch {
      // The app stays open and the button returns to its idle label.
      setInstalling(false);
    }
  }

  return (
    <div className="settings-toggle-row">
      <span>
        <strong>{t("Peacock 버전")}</strong>
        <small>{status ? appUpdateSummary(status) : t("업데이트 정보를 확인합니다")}</small>
      </span>
      <span className="settings-row-actions">
        <button
          type="button"
          disabled={!bridge || checking}
          onClick={() => void checkNow()}
        >
          {checking ? t("확인 중…") : t("지금 확인")}
        </button>
        {status?.state === "available" && status.asset && bridge?.installAppUpdate && (
          <button
            type="button"
            className="button-primary"
            disabled={installing}
            onClick={() => void installNow()}
          >
            {installing ? t("업데이트 중…") : t("지금 업데이트")}
          </button>
        )}
        {status?.state === "available" && (
          <button
            type="button"
            onClick={() => window.open(status.releaseUrl, "_blank", "noopener,noreferrer")}
          >
            {t("릴리스 페이지")}
          </button>
        )}
      </span>
    </div>
  );
}
