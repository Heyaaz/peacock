import { useEffect, useState, type ReactNode } from "react";
import { Bot, Check, CircleAlert, LoaderCircle } from "lucide-react";
import type {
  AgentKindId,
  AgentPreferences,
  AgentPreferencesMap,
  SettingsDesktopBridge,
} from "../../shared/agent-contract";
import { agentCatalogEntry } from "../../shared/agent-catalog";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, CODEX_EFFORTS, OMP_APPROVAL_MODES, type AgentLaunchOptions } from "../../shared/agent-launch";
import type { AgentAvailability } from "../../shared/terminal-ipc";
import { t } from "../i18n";
import { OmpAccountsSection } from "./omp-accounts-section";
import { Dropdown } from "./primitives";
import { SETTINGS_AGENTS, type SettingsAgent } from "./settings-model";


/** The options an agent's sessions can start with, as the settings offer them. */
const LAUNCH_FIELDS: Record<Exclude<SettingsAgent, "gjc">, { efforts: readonly string[]; permissionModes: readonly string[] }> = {
  claude: { efforts: CLAUDE_EFFORTS, permissionModes: CLAUDE_PERMISSION_MODES },
  omp: { efforts: [], permissionModes: OMP_APPROVAL_MODES },
  codex: { efforts: CODEX_EFFORTS, permissionModes: [] },
};

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

/** Where an agent's sign-in lives, for the agents that keep it to themselves. */
function signInNote(id: SettingsAgent): string {
  if (id === "claude") return t("Claude Code가 직접 관리합니다. 터미널 세션에서 /login을 실행하세요.");
  if (id === "codex") return t("Codex가 직접 관리합니다. 터미널에서 codex login을 실행하세요.");
  return t("omp를 설치하면 여기서 계정을 관리할 수 있습니다.");
}

/** The header every agent card shares: name, where it was found, and whether it can run. */
function AgentCardHead({ id, detection, checking, status }: { id: SettingsAgent; detection?: AgentAvailability; checking: boolean; status?: ReactNode }) {
  const where = detection?.binary
    ? detection.configured
      ? t`설정한 경로 · ${detection.binary}`
      : detection.binary
    : detection && !detection.installed
      ? (detection.reason ?? t("이 Mac에서 찾지 못했습니다"))
      : "";
  return (
    <header className="agent-card__head">
      <span className="agent-card__icon" aria-hidden="true">
        <Bot size={17} />
      </span>
      <span className="agent-card__title">
        <strong>{agentCatalogEntry(id).name}</strong>
        {where && (
          <small className={detection?.binary ? "agent-card__path" : "agent-card__reason"} title={where}>
            {where}
          </small>
        )}
        {status}
      </span>
      {checking ? (
        <span className="agent-card__state agent-card__state--checking">
          <LoaderCircle size={12} aria-hidden="true" /> {t("확인 중")}
        </span>
      ) : detection?.installed ? (
        <span className="agent-card__state agent-card__state--ready">
          <Check size={12} aria-hidden="true" /> {detection.version ?? t("설치됨")}
        </span>
      ) : (
        <span className="agent-card__state agent-card__state--missing">
          <CircleAlert size={12} aria-hidden="true" /> {t("설치 안 됨")}
        </span>
      )}
    </header>
  );
}

/** One labelled field in an agent card's grid. */
function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`agent-field${wide ? " agent-field--wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Settings › 에이전트: one card per agent, the same parts in the same order. What was found
 * here (path and version), the executable to use instead, what its new sessions start with
 * (model, effort, approval mode), and where its sign-in lives. GJC's card carries GJC's own
 * settings, which the dialog renders and saves (`gjc`).
 *
 * The edits start from `agents` as mounted: the settings dialog mounts the panel again
 * once the saved preferences are loaded.
 */
export function AgentsSettingsPanel({
  bridge,
  agents,
  onAgents,
  gjc,
}: {
  bridge: SettingsDesktopBridge | undefined;
  agents: AgentPreferencesMap;
  onAgents: (agents: AgentPreferencesMap) => void;
  /** GJC's card body and the connection line under its name. */
  gjc: { status?: ReactNode; body: ReactNode };
}) {
  const terminalBridge = window.agentControlDesktop?.terminal;
  const ompAccountsBridge = window.agentControlDesktop?.ompAccounts;
  const canList = typeof terminalBridge?.listAgents === "function";
  const [found, setFound] = useState<AgentAvailability[] | null>(null);
  const [drafts, setDrafts] = useState<AgentPreferencesMap>(agents);
  const [saving, setSaving] = useState<AgentKindId | null>(null);
  const [saved, setSaved] = useState<AgentKindId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AgentKindId, string>>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!canList) return;
    let current = true;
    terminalBridge!.listAgents().then(
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
  }, [canList, terminalBridge, reload]);

  function editDraft(id: AgentKindId, change: (current: AgentPreferences) => AgentPreferences): void {
    setSaved(null);
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
      const next = await bridge.setAgentPreferences(id, {
        executable: draft.executable?.trim() ?? "",
        launch: draft.launch ?? {},
      });
      onAgents(next);
      setDrafts((current) => ({ ...current, [id]: next[id] ?? {} }));
      setSaved(id);
      setReload((value) => value + 1);
    } catch (cause) {
      setErrors((current) => ({ ...current, [id]: errorText(cause) }));
    } finally {
      setSaving(null);
    }
  }

  const follow = t("에이전트 기본값");
  return (
    <div className="agents-settings">
      {SETTINGS_AGENTS.map((id) => {
        const detection = found?.find((agent) => agent.id === id);
        const checking = canList && found === null;
        if (id === "gjc")
          return (
            <section key={id} id="agent-card-gjc" className="agent-card" aria-label="GJC">
              <AgentCardHead id={id} detection={detection} checking={checking} status={gjc.status} />
              {gjc.body}
            </section>
          );
        const draft = drafts[id] ?? {};
        const fields = LAUNCH_FIELDS[id];
        const label = agentCatalogEntry(id).name;
        return (
          <section key={id} id={`agent-card-${id}`} className="agent-card" aria-label={label}>
            <AgentCardHead id={id} detection={detection} checking={checking} />
            <div className="agent-card__grid">
              <Field label={t("실행 파일")} wide>
                <input
                  value={draft.executable ?? ""}
                  placeholder={t("비워 두면 PATH에서 찾습니다")}
                  aria-label={t`${label} 실행 파일`}
                  onChange={(event) => editDraft(id, (current) => ({ ...current, executable: event.target.value }))}
                />
              </Field>
              <Field label={t("기본 모델")}>
                <input
                  value={draft.launch?.model ?? ""}
                  placeholder={follow}
                  aria-label={t`${label} 기본 모델`}
                  onChange={(event) => editLaunch(id, "model", event.target.value.trim())}
                />
              </Field>
              {fields.efforts.length > 0 && (
                <Field label={t("기본 effort")}>
                  <Dropdown
                    ariaLabel={t`${label} 기본 effort`}
                    value={draft.launch?.effort ?? ""}
                    options={[{ value: "", label: follow }, ...fields.efforts.map((effort) => ({ value: effort, label: effort }))]}
                    onChange={(value) => editLaunch(id, "effort", value)}
                  />
                </Field>
              )}
              <Field label={t("기본 승인 방식")}>
                {fields.permissionModes.length > 0 ? (
                  <Dropdown
                    ariaLabel={t`${label} 기본 승인 방식`}
                    value={draft.launch?.permissionMode ?? ""}
                    options={[{ value: "", label: follow }, ...fields.permissionModes.map((mode) => ({ value: mode, label: mode }))]}
                    onChange={(value) => editLaunch(id, "permissionMode", value)}
                  />
                ) : (
                  <em className="agent-field__static">{t("Codex 설정을 따릅니다")}</em>
                )}
              </Field>
            </div>
            <div className="agent-card__signin">
              <span className="agent-card__label">{t("로그인")}</span>
              {id === "omp" && detection?.installed && ompAccountsBridge ? (
                <OmpAccountsSection bridge={ompAccountsBridge} />
              ) : (
                <small>{signInNote(id)}</small>
              )}
            </div>
            <footer className="agent-card__foot">
              {errors[id] ? (
                <small className="composer-error" role="alert">{errors[id]}</small>
              ) : (
                <small>{saved === id ? t("저장했습니다. 다음 새 세션부터 적용됩니다.") : t("다음 새 세션부터 적용됩니다.")}</small>
              )}
              <button
                type="button"
                className="button-primary"
                disabled={!bridge || saving === id}
                onClick={() => void saveAgent(id)}
              >
                {saving === id ? t("저장 중…") : t("저장")}
              </button>
            </footer>
          </section>
        );
      })}
    </div>
  );
}
