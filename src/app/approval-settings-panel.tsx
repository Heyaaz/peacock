import { useEffect, useState } from "react";
import { ChevronRight, ShieldAlert, Smartphone } from "lucide-react";
import type { AgentPreferencesMap, SettingsDesktopBridge } from "../../shared/agent-contract";
import { agentCatalogEntry } from "../../shared/agent-catalog";
import type { RemoteAccessState } from "../../shared/remote-protocol";
import type { AgentControlPreferences } from "../backend/types";
import { t } from "../i18n";
import { CommandRulesPanel } from "./command-rules-panel";
import { SettingsSection } from "./settings-layout";
import { gjcApprovalLabel, SETTINGS_AGENTS } from "./settings-model";

/** Modes that let an agent act without asking at all. */
const UNGUARDED = new Set(["bypassPermissions", "yolo", "always-allow"]);


/**
 * Settings › 승인 규칙: what goes through without asking, and where an approval can be given.
 * Each agent's approval mode is set on its card in 에이전트; this page shows them side by side,
 * with the saved command rules and the phones that can answer approval cards.
 */
export function ApprovalSettingsPanel({
  bridge,
  agents,
  permissionHandling,
  onOpenAgent,
  onOpenRemote,
}: {
  bridge: SettingsDesktopBridge | undefined;
  agents: AgentPreferencesMap;
  permissionHandling: AgentControlPreferences["permissionHandling"];
  onOpenAgent: (id: (typeof SETTINGS_AGENTS)[number]) => void;
  onOpenRemote: () => void;
}) {
  const remoteBridge = window.agentControlDesktop?.remote;
  const [remote, setRemote] = useState<RemoteAccessState | null>(null);
  useEffect(() => {
    if (typeof remoteBridge?.getState !== "function") return;
    let active = true;
    remoteBridge.getState().then(
      (state) => {
        if (active) setRemote(state);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [remoteBridge]);

  const modeOf = (id: (typeof SETTINGS_AGENTS)[number]): string | undefined =>
    id === "gjc" ? permissionHandling : agents[id]?.launch?.permissionMode;
  const shown = (id: (typeof SETTINGS_AGENTS)[number]): string => {
    if (id === "gjc") return gjcApprovalLabel(permissionHandling);
    if (id === "codex") return t("Codex 설정을 따릅니다");
    return agents[id]?.launch?.permissionMode ?? t("에이전트 기본값");
  };
  const controllers = remote?.devices.filter((device) => device.permission === "control") ?? [];

  return (
    <div className="settings-stack">
      <SettingsSection
        title={t("에이전트별 승인 방식")}
        description={t("새 세션이 처음에 쓰는 방식입니다. 바꾸려면 에이전트 카드를 여세요.")}
      >
        {SETTINGS_AGENTS.map((id) => {
          const unguarded = UNGUARDED.has(modeOf(id) ?? "");
          return (
            <div className="settings-toggle-row approval-mode-row" key={id}>
              <span>
                <strong>{agentCatalogEntry(id).name}</strong>
                <small className={unguarded ? "approval-mode--unguarded" : undefined}>
                  {unguarded && <ShieldAlert size={12} aria-hidden="true" />}
                  {shown(id)}
                  {unguarded && ` · ${t("묻지 않고 실행합니다")}`}
                </small>
              </span>
              <button type="button" className="settings-link" onClick={() => onOpenAgent(id)}>
                {t("바꾸기")} <ChevronRight size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </SettingsSection>
      <CommandRulesPanel bridge={bridge} />
      <SettingsSection
        title={t("휴대폰에서 승인")}
        description={t("‘조작 가능’으로 연결한 기기는 승인 카드에 답할 수 있습니다. 보기 전용 기기는 볼 수만 있습니다.")}
      >
        <div className="settings-toggle-row">
          <span>
            <strong>
              <Smartphone size={13} aria-hidden="true" />{" "}
              {!remote
                ? t("원격 접속 상태를 확인하는 중")
                : !remote.enabled
                  ? t("원격 접속이 꺼져 있습니다")
                  : controllers.length > 0
                    ? t`승인할 수 있는 기기 ${controllers.length}대`
                    : t("승인할 수 있는 기기가 없습니다")}
            </strong>
            {controllers.length > 0 && <small>{controllers.map((device) => device.name).join(", ")}</small>}
          </span>
          <button type="button" className="settings-link" onClick={onOpenRemote}>
            {t("원격·폰 설정")} <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>
      </SettingsSection>
    </div>
  );
}
