import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import type { SystemInfo } from "../../shared/settings-ipc";
import { locale, t } from "../i18n";
import { BackgroundTerminalsRow } from "./background-terminals-row";
import { EnvironmentCheckPanel } from "./environment-check-panel";
import { SettingsSection } from "./settings-layout";

function bytesText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function dateText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings › 고급: herdr-core, where terminal sessions keep running; the data folder and the
 * record of its move from Gajae; and the environment check.
 */
export function AdvancedSettingsPanel({
  bridge,
  onLogin,
}: {
  bridge: SettingsDesktopBridge | undefined;
  onLogin?: () => void;
}) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (typeof bridge?.getSystemInfo !== "function") return;
    let active = true;
    bridge.getSystemInfo().then(
      (next) => {
        if (active) setInfo(next);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  const core = info?.herdrCore;
  return (
    <div className="settings-stack">
      <SettingsSection
        title="herdr-core"
        description={t("터미널 세션이 도는 곳입니다. 앱을 닫아도 셸과 에이전트는 여기서 계속 실행됩니다.")}
      >
        <div className="settings-toggle-row">
          <span>
            <strong>
              {!info
                ? error || t("확인하는 중…")
                : !core
                  ? t("이 Mac에서는 쓰지 않습니다")
                  : core.running
                    ? t("실행 중")
                    : t("실행 중이 아님 · 터미널 세션을 열면 시작합니다")}
            </strong>
            {core && (
              <small>
                {t`세션 ${core.session} · 버전 ${core.version ?? core.bundledVersion}`}
              </small>
            )}
          </span>
        </div>
        <BackgroundTerminalsRow />
      </SettingsSection>
      <SettingsSection
        title={t("데이터 폴더")}
        description={t("설정, 세션 목록, 원격 기기, 첨부 파일이 저장되는 곳입니다.")}
        actions={
          info && typeof bridge?.revealDataFolder === "function" ? (
            <button type="button" className="button-secondary" onClick={() => void bridge.revealDataFolder().catch((cause: unknown) => setError(String(cause)))}>
              <FolderOpen size={13} aria-hidden="true" /> {t("Finder에서 보기")}
            </button>
          ) : undefined
        }
      >
        <div className="settings-toggle-row">
          <span>
            <strong>{t("위치")}</strong>
            <code className="settings-path">{info?.userData ?? "…"}</code>
          </span>
        </div>
        <div className="settings-toggle-row">
          <span>
            <strong>{t("Gajae에서 옮겨 온 기록")}</strong>
            <small>
              {!info
                ? "…"
                : info.migration
                  ? t`${dateText(info.migration.migratedAt)} · 파일 ${info.migration.files.toLocaleString(locale())}개 · ${bytesText(info.migration.bytes)}`
                  : t("없음. 새로 설치했거나 옮길 데이터가 없었습니다.")}
            </small>
            {info?.migration && <code className="settings-path">{info.migration.from}</code>}
            {info?.legacyUserData && (
              <small>{t("옛 폴더는 지우지 않고 그대로 두었습니다. 더 필요 없으면 직접 지워도 됩니다.")}</small>
            )}
          </span>
        </div>
      </SettingsSection>
      <EnvironmentCheckPanel bridge={bridge} onLogin={onLogin} />
    </div>
  );
}
