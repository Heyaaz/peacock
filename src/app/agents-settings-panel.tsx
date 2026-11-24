import { useEffect, useState } from "react";
import { Check, CircleAlert, SquareTerminal } from "lucide-react";
import type {
  AgentKindId,
  AgentPreferences,
  AgentPreferencesMap,
  NewSessionChoice,
  SettingsDesktopBridge,
} from "../../shared/agent-contract";
import { AGENT_CATALOG, agentCatalogEntry } from "../../shared/agent-catalog";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, CODEX_EFFORTS, OMP_APPROVAL_MODES, type AgentLaunchOptions } from "../../shared/agent-launch";
import type { AgentAvailability } from "../../shared/terminal-ipc";
import { t } from "../i18n";
import { BackgroundTerminalsRow } from "./background-terminals-row";
import { Dropdown } from "./primitives";

/** The options an agent's sessions can start with, as the settings offer them. */
const LAUNCH_FIELDS: Partial<Record<AgentKindId, { model: boolean; efforts: readonly string[]; permissionModes: readonly string[] }>> = {
  claude: { model: true, efforts: CLAUDE_EFFORTS, permissionModes: CLAUDE_PERMISSION_MODES },
  omp: { model: true, efforts: [], permissionModes: OMP_APPROVAL_MODES },
  codex: { model: true, efforts: CODEX_EFFORTS, permissionModes: [] },
};

function agentLabel(id: AgentKindId): string {
  return id === "shell" ? t("셸") : agentCatalogEntry(id).name;
}

/** "Claude Code · 터미널": an agent and the screen its new sessions open on. */
function choiceValue(choice: NewSessionChoice): string {
  return `${choice.agentKind}:${choice.surface}`;
}

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

/**
 * The agents Gajae can run (P5): what new sessions open, and for each agent what was
 * found here (path and version, or why not), the executable to use instead, and what
 * its new sessions start with. GJC's own settings, update and sign-in stay in its tab.
 *
 * The edits start from `agents` as mounted: the settings dialog mounts the panel again
 * once the saved preferences are loaded.
 */
export function AgentsSettingsPanel({
  bridge,
  agents,
  newSession,
  onAgents,
  onNewSession,
  onOpenGjc,
}: {
  bridge: SettingsDesktopBridge | undefined;
  agents: AgentPreferencesMap;
  newSession: NewSessionChoice | undefined;
  onAgents: (agents: AgentPreferencesMap) => void;
  onNewSession: (choice: NewSessionChoice | undefined) => void;
  onOpenGjc: () => void;
}) {
  const terminalBridge = window.agentControlDesktop?.terminal;
  const [found, setFound] = useState<AgentAvailability[] | null>(null);
  const [drafts, setDrafts] = useState<AgentPreferencesMap>(agents);
  const [saving, setSaving] = useState<AgentKindId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AgentKindId, string>>>({});
  const [choiceError, setChoiceError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (typeof terminalBridge?.listAgents !== "function") return;
    let current = true;
    terminalBridge.listAgents().then(
      (list) => {
        if (current) setFound(list);
      },
      () => {
        if (current) setFound([]);
      },
    );
    return () => {
      current = false;
    };
  }, [terminalBridge, reload]);

  const choices = AGENT_CATALOG.flatMap((entry) =>
    entry.surfaces.map((surface) => ({
      value: choiceValue({ agentKind: entry.id, surface }),
      label: `${agentLabel(entry.id)} · ${surface === "chat" ? t("채팅") : t("터미널")}`,
    })),
  );

  async function saveChoice(value: string): Promise<void> {
    if (!bridge) return;
    setChoiceError("");
    const [agentKind, surface] = value.split(":") as [AgentKindId, "chat" | "terminal"];
    try {
      const saved = await bridge.setNewSession(value === "" ? null : { agentKind, surface });
      onNewSession(saved ?? undefined);
    } catch (cause) {
      setChoiceError(errorText(cause));
    }
  }

  function editDraft(id: AgentKindId, change: (current: AgentPreferences) => AgentPreferences): void {
    setDrafts((current) => ({ ...current, [id]: change(current[id] ?? {}) }));
  }

  function editLaunch(id: AgentKindId, key: keyof AgentLaunchOptions, value: string): void {
    editDraft(id, (current) => {
      const launch: AgentLaunchOptions = { ...current.launch };
      if (value) launch[key] = value;
      else delete launch[key];
      return { ...current, launch };
    });
  }

  async function saveAgent(id: AgentKindId): Promise<void> {
    if (!bridge) return;
    const draft = drafts[id] ?? {};
    setSaving(id);
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      const saved = await bridge.setAgentPreferences(id, {
        ...(id !== "gjc" ? { executable: draft.executable?.trim() ?? "" } : {}),
        launch: draft.launch ?? {},
      });
      onAgents(saved);
      setDrafts((current) => ({ ...current, [id]: saved[id] ?? {} }));
      setReload((value) => value + 1);
    } catch (cause) {
      setErrors((current) => ({ ...current, [id]: errorText(cause) }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="settings-stack agents-settings">
      <div className="settings-panel">
        <label>
          <span>
            <strong>{t("새 세션 기본값")}</strong>
            <small>{t("새 세션을 처음 열 에이전트와 화면입니다. 새 세션 창에서 고르면 그 선택이 다음 기본값이 됩니다.")}</small>
          </span>
          <Dropdown
            ariaLabel={t("새 세션 기본값")}
            value={newSession ? choiceValue(newSession) : ""}
            options={[{ value: "", label: t("자동 (설치된 첫 에이전트)") }, ...choices]}
            onChange={(value) => void saveChoice(value)}
          />
        </label>
        {choiceError && <small className="composer-error" role="alert">{choiceError}</small>}
        <BackgroundTerminalsRow />
      </div>
      {AGENT_CATALOG.map((entry) => {
        const detection = found?.find((agent) => agent.id === entry.id);
        const draft = drafts[entry.id] ?? {};
        const fields = LAUNCH_FIELDS[entry.id];
        return (
          <section key={entry.id} className="settings-panel agent-settings" aria-label={agentLabel(entry.id)}>
            <header className="agent-settings__header">
              <SquareTerminal size={16} aria-hidden="true" />
              <strong>{agentLabel(entry.id)}</strong>
              {detection ? (
                detection.installed ? (
                  <span className="ready-badge ready-badge--connected">
                    <Check size={12} /> {detection.version ?? t("설치됨")}
                  </span>
                ) : (
                  <span className="ready-badge ready-badge--disconnected">
                    <CircleAlert size={12} /> {detection.reason ?? t("사용할 수 없음")}
                  </span>
                )
              ) : (
                <small>{found === null ? t("확인 중…") : ""}</small>
              )}
            </header>
            {detection?.binary && (
              <small className="agent-settings__path" title={detection.binary}>
                {detection.configured ? t`설정한 실행 파일: ${detection.binary}` : t`찾은 위치: ${detection.binary}`}
              </small>
            )}
            {entry.id === "gjc" ? (
              <div className="gjc-update-row">
                <span>
                  <small>{t("GJC의 실행 파일, 모델 프로필, 도구 승인, 업데이트와 AI 로그인은 GJC 탭에 있습니다.")}</small>
                </span>
                <span className="gjc-update-actions">
                  <button type="button" onClick={onOpenGjc}>
                    {t("GJC 설정 열기")}
                  </button>
                </span>
              </div>
            ) : entry.binaries.length > 0 ? (
              <>
                <label className="settings-field-wide">
                  <span>
                    <strong>{t("실행 파일")}</strong>
                    <small>{t("비워 두면 PATH와 설치 위치에서 찾습니다")}</small>
                  </span>
                  <input
                    value={draft.executable ?? ""}
                    placeholder={t("자동으로 찾기")}
                    onChange={(event) => editDraft(entry.id, (current) => ({ ...current, executable: event.target.value }))}
                  />
                </label>
                {fields && (
                  <div className="agent-settings__launch">
                    {fields.model && (
                      <label>
                        <span>
                          <strong>{t("기본 모델")}</strong>
                        </span>
                        <input
                          value={draft.launch?.model ?? ""}
                          placeholder={t("에이전트 설정 따름")}
                          onChange={(event) => editLaunch(entry.id, "model", event.target.value.trim())}
                        />
                      </label>
                    )}
                    {fields.efforts.length > 0 && (
                      <label>
                        <span>
                          <strong>{t("기본 effort")}</strong>
                        </span>
                        <Dropdown
                          ariaLabel={t`${agentLabel(entry.id)} 기본 effort`}
                          value={draft.launch?.effort ?? ""}
                          options={[{ value: "", label: t("에이전트 설정 따름") }, ...fields.efforts.map((effort) => ({ value: effort, label: effort }))]}
                          onChange={(value) => editLaunch(entry.id, "effort", value)}
                        />
                      </label>
                    )}
                    {fields.permissionModes.length > 0 && (
                      <label>
                        <span>
                          <strong>{t("기본 권한 모드")}</strong>
                        </span>
                        <Dropdown
                          ariaLabel={t`${agentLabel(entry.id)} 기본 권한 모드`}
                          value={draft.launch?.permissionMode ?? ""}
                          options={[{ value: "", label: t("에이전트 설정 따름") }, ...fields.permissionModes.map((mode) => ({ value: mode, label: mode }))]}
                          onChange={(value) => editLaunch(entry.id, "permissionMode", value)}
                        />
                      </label>
                    )}
                  </div>
                )}
                {errors[entry.id] && <small className="composer-error" role="alert">{errors[entry.id]}</small>}
                <div className="agent-settings__actions">
                  <button
                    type="button"
                    className="button-primary"
                    disabled={!bridge || saving === entry.id}
                    onClick={() => void saveAgent(entry.id)}
                  >
                    {saving === entry.id ? t("저장 중…") : t("저장")}
                  </button>
                </div>
              </>
            ) : (
              <small>{t("로그인 셸(SHELL)을 엽니다. 따로 설정할 것이 없습니다.")}</small>
            )}
          </section>
        );
      })}
    </div>
  );
}
