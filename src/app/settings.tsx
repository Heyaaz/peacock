import {
  BUILT_IN_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_TOOL_VIEW_MODE,
  NOTIFICATION_SOUNDS,
} from "../../shared/agent-contract";
import type {
  AgentPreferencesMap,
  GjcUpdateStatus,
  ManagementSnapshot,
  NewSessionChoice,
  NotificationCategory,
  NotificationPreferences,
} from "../../shared/agent-contract";
import type { AgentControlPreferences, BackendConnection } from "../backend/types";
import { ArrowLeft, Bot, ChevronRight, FolderGit2, FolderOpen, ShieldCheck, SlidersHorizontal, Smartphone, Wrench, X } from "lucide-react";
import {
  DEFAULT_DESKTOP_INTEGRATION,
  type DesktopIntegrationPreferences,
} from "../../shared/desktop-integration";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { connectionStateLabel } from "./format";
import { gjcVersionWarning } from "../../shared/gjc-version";
import { readStoredTheme, setThemeMode, type ThemeMode } from "../theme";
import { getLanguage, setLanguageMode, t, useLanguageMode } from "../i18n";
import { LazyViewBoundary } from "./lazy-boundary";
import { AutomationPanel, ManagementPanel } from "./panels";
import { Dropdown } from "./primitives";
import { AppUpdateRow } from "./app-update-row";
import { QuickInputShortcutRow } from "./quick-input-shortcut-row";
import { GjcSettingsPanel } from "./gjc-settings-panel";
import { AgentsSettingsPanel } from "./agents-settings-panel";
import { ApprovalSettingsPanel } from "./approval-settings-panel";
import { ProjectSettingsPanel, type ProjectChoice } from "./project-settings-panel";
import { gjcApprovalLabel } from "./settings-model";
import { AdvancedSettingsPanel } from "./advanced-settings-panel";
import { SettingsSection } from "./settings-layout";
import { AGENT_CATALOG } from "../../shared/agent-catalog";
const RemoteAccessPanel = lazy(() =>
  import("./remote-access-panel").then((mod) => ({ default: mod.RemoteAccessPanel })),
);

export interface SettingsDialogProps {
  connection: BackendConnection;
  /**
   * The shell's current reasoning-card preference.
   *
   * The dialog seeds its own object from it so a card toggled moments before opening
   * settings is not clobbered by a draft built from an older read.
   */
  thoughtsExpanded: boolean;
  /** The same toggle the cards use, so the checkbox saves at once through its own channel. */
  onToggleThoughtsExpanded: () => void;
  onClose: () => void;
  onSaved: (preferences: AgentControlPreferences) => void;
  updateStatus: GjcUpdateStatus | null;
  updateBusy: "checking" | "installing" | null;
  updateError: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  /** The page to open on: 일반 by default, 고급 for the launch environment check. */
  initialTab?: SettingsTab;
  /** Opens the AI sign-in flow; absent where the host cannot run GJC's login. */
  onLogin?: () => void;
  /** The repositories the window knows, for the project page. */
  projects?: readonly ProjectChoice[];
}

/** The five pages, and GJC's own pages under 에이전트. */
export type SettingsTab =
  | "general"
  | "agents"
  | "approvals"
  | "projects"
  | "remote"
  | "advanced"
  | "gjcSettings"
  | "mcp"
  | "skills"
  | "usage"
  | "automations";

const GJC_PAGES = ["gjcSettings", "mcp", "skills", "usage", "automations"] as const;
type GjcPage = (typeof GJC_PAGES)[number];
const isGjcPage = (tab: SettingsTab): tab is GjcPage => (GJC_PAGES as readonly string[]).includes(tab);

/**
 * The preferences to show once the first read lands.
 *
 * A draft built from the fallback values is only authoritative for the fields the
 * user actually touched. Keeping the whole draft (the old behavior) saved those
 * fallbacks over every other stored setting -- a custom executable, workspace and
 * permission mode were replaced because one field was edited during the read.
 */
export function mergeInitialPreferences(
  current: AgentControlPreferences,
  loaded: AgentControlPreferences,
  editedFields: readonly (keyof AgentControlPreferences)[],
): { preferences: AgentControlPreferences; original: AgentControlPreferences } {
  if (editedFields.length === 0) return { preferences: loaded, original: loaded };
  const preferences: AgentControlPreferences = { ...loaded };
  for (const field of editedFields) {
    (preferences as Record<keyof AgentControlPreferences, unknown>)[field] =
      current[field];
  }
  return { preferences, original: loaded };
}

/**
 * What a completed save may do to the dialog that asked for it.
 *
 * A save is asynchronous and the user can keep editing or close and reopen the
 * dialog while it runs. The response must not replace those newer edits, and a
 * response owned by an unmounted dialog must not close the one now on screen.
 */
export function resolvePreferenceSave(input: {
  mounted: boolean;
  revisionAtSave: number;
  revisionNow: number;
  current: AgentControlPreferences;
  saved: AgentControlPreferences;
}): {
  notify: boolean;
  close: boolean;
  preferences: AgentControlPreferences;
  original: AgentControlPreferences;
} {
  if (!input.mounted) {
    return {
      notify: false,
      close: false,
      preferences: input.current,
      original: input.current,
    };
  }
  const sameDraft = input.revisionAtSave === input.revisionNow;
  return {
    notify: true,
    close: sameDraft,
    // A newer edit is the draft now; adopting the older save response would
    // silently discard it. The saved values still become the compare baseline.
    preferences: sameDraft ? input.saved : input.current,
    original: input.saved,
  };
}

/**
 * Saving is only allowed against a completed read.
 *
 * The fallback-loaded draft is not the stored configuration. Saving it after a
 * failed read would replace every untouched setting with a default, so the dialog
 * waits for the read instead.
 */
export function canSavePreferences(
  dirty: boolean,
  saving: boolean,
  hasBridge: boolean,
  loaded: boolean,
): boolean {
  return dirty && !saving && hasBridge && loaded;
}

export function settingsErrorMessage(error: unknown): string {
  return t(error instanceof Error ? error.message : String(error));
}

const NOTIFICATION_ROWS: ReadonlyArray<{
  key: NotificationCategory;
  label: string;
  detail: string;
}> = [
  { key: "completed", label: "작업 완료", detail: "턴이 끝났을 때" },
  { key: "permission", label: "승인·질문 대기", detail: "도구 승인이나 답을 기다릴 때" },
  { key: "failed", label: "실패", detail: "턴이 오류로 끝났을 때" },
  { key: "message", label: "새 응답", detail: "턴 밖에서 온 메시지와 연결 복구" },
];

const NOTIFICATION_SOUND_LABELS: Record<
  (typeof NOTIFICATION_SOUNDS)[number],
  string
> = {
  default: "기본",
  none: "없음",
  Glass: "Glass",
  Ping: "Ping",
  Pop: "Pop",
  Submarine: "Submarine",
};

/** "Claude Code · 터미널": an agent and the screen its new sessions open on. */
function choiceValue(choice: NewSessionChoice): string {
  return `${choice.agentKind}:${choice.surface}`;
}

/** One labelled field of an agent card (the same parts the agents panel uses). */
function CardField({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`agent-field${wide ? " agent-field--wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SettingsDialog({
  connection,
  thoughtsExpanded,
  onToggleThoughtsExpanded,
  onClose,
  onSaved,
  updateStatus,
  updateBusy,
  updateError,
  onCheckUpdate,
  onInstallUpdate,
  initialTab = "general",
  onLogin,
  projects = [],
}: SettingsDialogProps) {
  const detectedPreset = connection.modelPreset ?? DEFAULT_MODEL_PRESET;
  const fallbackPreferences: AgentControlPreferences = {
    workspace: connection.workspace,
    workspaceLabel: t("내 작업 공간"),
    modelPreset: detectedPreset,
    permissionHandling: "prompt",
    agents: {},
    thoughtsExpanded,
    toolViewMode: DEFAULT_TOOL_VIEW_MODE,
    notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
    desktopIntegration: DEFAULT_DESKTOP_INTEGRATION,
    language: getLanguage(),
    runningSubmission: "queue",
  };
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readStoredTheme());
  const languageMode = useLanguageMode();
  const [management, setManagement] = useState<ManagementSnapshot | null>(null);
  const [managementError, setManagementError] = useState("");
  const [managementLoading, setManagementLoading] = useState(false);
  const [preferences, setPreferences] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [original, setOriginal] =
    useState<AgentControlPreferences>(fallbackPreferences);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [choiceError, setChoiceError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editedBeforeLoad = useRef(new Set<keyof AgentControlPreferences>());
  const editRevision = useRef(0);
  const mounted = useRef(true);
  const onCloseRef = useRef(onClose);
  const originalRef = useRef(original);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    originalRef.current = original;
  }, [original]);
  // Read while rendering: child autoFocus effects run before this component's own.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  useEffect(() => {
    // The same path as the X button, so staged GJC edits are treated alike.
    function closeWithEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onCloseRef.current();
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("keydown", closeWithEscape);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);
  const preferencesRef = useRef(preferences);
  const settingsBridge = window.agentControlDesktop?.settings;
  const managementBridge = window.agentControlDesktop?.management;
  const runtimeDirty =
    preferences.modelPreset !== original.modelPreset ||
    preferences.permissionHandling !== original.permissionHandling ||
    (preferences.agents?.gjc?.executable ?? "") !== (original.agents?.gjc?.executable ?? "");
  const page: Exclude<SettingsTab, GjcPage> = isGjcPage(tab) ? "agents" : tab;
  const pageTitle: Record<SettingsTab, string> = {
    general: t("일반"),
    agents: t("에이전트"),
    approvals: t("승인 규칙"),
    projects: t("프로젝트"),
    remote: t("원격·폰"),
    advanced: t("고급"),
    gjcSettings: t("GJC 세부 설정"),
    mcp: t("MCP 서버"),
    skills: t("스킬·플러그인"),
    usage: t("사용량"),
    automations: t("자동화"),
  };
  const pageDescription: Record<SettingsTab, string> = {
    general: t("모양, 새 세션, 알림, 데스크톱 동작"),
    agents: t("이 Mac의 에이전트와, 새 세션이 시작할 때 쓰는 설정"),
    approvals: t("묻지 않고 넘어가는 것과 승인할 수 있는 곳"),
    projects: t("프로젝트별 worktree 기본값, setup 스크립트, 복사할 파일"),
    remote: t("휴대폰에서 이 Mac의 세션을 보고 조작합니다"),
    advanced: t("herdr-core, 데이터 폴더, 진단"),
    gjcSettings: t("터미널의 GJC와 함께 쓰는 설정입니다"),
    mcp: t("GJC가 불러오는 MCP 서버"),
    skills: t("GJC가 찾은 스킬과 설치한 플러그인"),
    usage: t("GJC 세션의 모델별 토큰, 캐시, 비용"),
    automations: t("앱이 닫혀 있어도 정한 시간에 GJC 작업을 실행합니다"),
  };
  const navItems: { id: Exclude<SettingsTab, GjcPage>; label: string; icon: ReactNode }[] = [
    { id: "general", label: pageTitle.general, icon: <SlidersHorizontal size={16} aria-hidden="true" /> },
    { id: "agents", label: pageTitle.agents, icon: <Bot size={16} aria-hidden="true" /> },
    { id: "approvals", label: pageTitle.approvals, icon: <ShieldCheck size={16} aria-hidden="true" /> },
    { id: "projects", label: pageTitle.projects, icon: <FolderGit2 size={16} aria-hidden="true" /> },
    { id: "remote", label: pageTitle.remote, icon: <Smartphone size={16} aria-hidden="true" /> },
    { id: "advanced", label: pageTitle.advanced, icon: <Wrench size={16} aria-hidden="true" /> },
  ];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // a new page starts at its top
  useEffect(() => {
    contentRef.current?.scrollTo?.({ top: 0 });
  }, [tab]);

  useEffect(() => {
    if (!settingsBridge) return;
    let active = true;
    void settingsBridge
      .getPreferences()
      .then((loaded) => {
        if (!active) return;
        const result = mergeInitialPreferences(
          preferencesRef.current,
          loaded,
          [...editedBeforeLoad.current],
        );
        preferencesRef.current = result.preferences;
        setPreferences(result.preferences);
        setOriginal(result.original);
        setLoadError("");
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(settingsErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, settingsBridge]);

  async function persistRunningSubmission(
    value: "queue" | "steer",
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.runningSubmission;
    const optimistic = { ...preferencesRef.current, runningSubmission: value };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setRunningSubmission(value);
      const current = { ...preferencesRef.current, runningSubmission: saved };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((original) => ({
        ...original,
        runningSubmission: saved,
      }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        runningSubmission: previous,
      };
      preferencesRef.current = restored;
      setPreferences(restored);
      setSaveError(settingsErrorMessage(error));
    }
  }

  /** A field saved on its own channel: the dialog's copy and its baseline follow it. */
  function adoptSaved(change: { agents?: AgentPreferencesMap; newSession?: NewSessionChoice | null }): void {
    const apply = (value: AgentControlPreferences): AgentControlPreferences => {
      const next = { ...value };
      if (change.agents) {
        // GJC's executable is still the dialog's own edit until saved with the GJC settings
        const gjcExecutable = value.agents?.gjc?.executable;
        next.agents = { ...change.agents, ...(gjcExecutable ? { gjc: { ...change.agents.gjc, executable: gjcExecutable } } : {}) };
      }
      if (change.newSession !== undefined) {
        if (change.newSession) next.newSession = change.newSession;
        else delete next.newSession;
      }
      return next;
    };
    preferencesRef.current = apply(preferencesRef.current);
    setPreferences(preferencesRef.current);
    setOriginal((current) => apply(current));
  }

  async function saveNewSessionChoice(value: string): Promise<void> {
    if (!settingsBridge) return;
    setChoiceError("");
    const [agentKind, surface] = value.split(":") as [NewSessionChoice["agentKind"], NewSessionChoice["surface"]];
    try {
      const saved = await settingsBridge.setNewSession(value === "" ? null : { agentKind, surface });
      adoptSaved({ newSession: saved ?? null });
    } catch (error) {
      setChoiceError(settingsErrorMessage(error));
    }
  }

  async function persistDesktopIntegration(
    next: DesktopIntegrationPreferences,
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.desktopIntegration;
    const optimistic = { ...preferencesRef.current, desktopIntegration: next };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setDesktopIntegration(next);
      const current = { ...preferencesRef.current, desktopIntegration: saved };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((value) => ({ ...value, desktopIntegration: saved }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        desktopIntegration: previous,
      };
      preferencesRef.current = restored;
      setPreferences(restored);
      setSaveError(settingsErrorMessage(error));
    }
  }

  async function persistNotifications(
    next: NotificationPreferences,
  ): Promise<void> {
    if (!settingsBridge) return;
    const previous = preferencesRef.current.notificationPreferences;
    const optimistic = {
      ...preferencesRef.current,
      notificationPreferences: next,
    };
    preferencesRef.current = optimistic;
    setPreferences(optimistic);
    setSaveError("");
    try {
      const saved = await settingsBridge.setNotificationPreferences(next);
      const current = {
        ...preferencesRef.current,
        notificationPreferences: saved,
      };
      preferencesRef.current = current;
      setPreferences(current);
      setOriginal((value) => ({
        ...value,
        notificationPreferences: saved,
      }));
    } catch (error) {
      const restored = {
        ...preferencesRef.current,
        notificationPreferences: previous,
      };
      preferencesRef.current = restored;
      setPreferences(restored);
      setSaveError(settingsErrorMessage(error));
    }
  }

  function editPreferences(
    update: (current: AgentControlPreferences) => AgentControlPreferences,
  ): void {
    editRevision.current += 1;
    const current = preferencesRef.current;
    const next = update(current);
    if (!loaded) {
      for (const field of Object.keys(next) as (keyof AgentControlPreferences)[]) {
        if (next[field] !== current[field]) editedBeforeLoad.current.add(field);
      }
    }
    preferencesRef.current = next;
    setPreferences(next);
    setSaveError("");
    setSavedNote("");
  }

  useEffect(() => {
    if (
      !managementBridge ||
      management ||
      !["mcp", "skills", "usage"].includes(tab)
    )
      return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setManagementLoading(true);
      setManagementError("");
      void managementBridge
        .getSnapshot(preferences.workspace)
        .then((snapshot) => {
          if (active) setManagement(snapshot);
        })
        .catch((error) => {
          if (active)
            setManagementError(
              error instanceof Error ? error.message : String(error),
            );
        })
        .finally(() => {
          if (active) setManagementLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [management, managementBridge, preferences.workspace, tab]);

  /** Saves the whole preferences object (GJC's settings, the default folder); the dialog stays open. */
  async function saveSettings(): Promise<void> {
    const dirty = JSON.stringify(preferencesRef.current) !== JSON.stringify(originalRef.current);
    if (!settingsBridge || !canSavePreferences(dirty, saving, true, loaded)) return;
    const revisionAtSave = editRevision.current;
    setSaving(true);
    setSaveError("");
    setSavedNote("");
    try {
      const saved = await settingsBridge.savePreferences(preferencesRef.current);
      const outcome = resolvePreferenceSave({
        mounted: mounted.current,
        revisionAtSave,
        revisionNow: editRevision.current,
        current: preferencesRef.current,
        saved: saved.preferences,
      });
      if (!outcome.notify) return;
      preferencesRef.current = outcome.preferences;
      setPreferences(outcome.preferences);
      setOriginal(outcome.original);
      originalRef.current = outcome.original;
      onSaved(outcome.original);
      setSavedNote(saved.runtimeReconnected ? t("저장하고 GJC를 다시 연결했습니다.") : t("저장했습니다."));
    } catch (error) {
      if (mounted.current) {
        const message = settingsErrorMessage(error);
        // the host's own confirmation, declined: nothing to report
        if (!/cancel/iu.test(message)) setSaveError(message);
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (!settingsBridge) return;
    setWorkspaceError("");
    try {
      const selected = await settingsBridge.chooseWorkspace(
        preferences.workspace,
      );
      if (selected && selected !== preferencesRef.current.workspace) {
        editPreferences((current) => ({ ...current, workspace: selected }));
        setManagement(null);
        await saveSettings();
      }
    } catch (error) {
      setWorkspaceError(settingsErrorMessage(error));
    }
  }

  const newSessionChoices = AGENT_CATALOG.flatMap((entry) =>
    entry.surfaces.map((surface) => ({
      value: choiceValue({ agentKind: entry.id, surface }),
      label: `${entry.id === "shell" ? t("셸") : entry.name} · ${surface === "chat" ? t("채팅") : t("터미널")}`,
    })),
  );
  const versionWarning = gjcVersionWarning(connection.version);
  const gjcLinks: { id: GjcPage; label: string }[] = [
    { id: "gjcSettings", label: t("세부 설정") },
    { id: "mcp", label: "MCP" },
    { id: "skills", label: t("스킬·플러그인") },
    { id: "usage", label: t("사용량") },
    { id: "automations", label: t("자동화") },
  ];
  const openAgentCard = (id: string): void => {
    setTab("agents");
    // after the page renders: bring the card into view
    requestAnimationFrame(() => document.getElementById(`agent-card-${id}`)?.scrollIntoView?.({ block: "start" }));
  };

  const gjcStatus = (
    <small className={`agent-card__connection agent-card__connection--${connection.state}`}>
      {connectionStateLabel(connection.state)}
      {connection.detail && connection.state !== "connected" ? ` · ${connection.detail}` : ""}
    </small>
  );
  const gjcBody = (
    <>
      {versionWarning && (
        <div className="gjc-version-warning" role="alert">
          {versionWarning}
        </div>
      )}
      <div className="agent-card__grid">
        <CardField label={t("실행 파일")} wide>
          <input
            aria-label={t("GJC 실행 파일")}
            value={preferences.agents?.gjc?.executable ?? ""}
            placeholder={t("비워 두면 PATH에서 찾습니다")}
            onChange={(event) =>
              editPreferences((current) => {
                const { executable: _previous, ...gjc } = current.agents?.gjc ?? {};
                const executable = event.target.value;
                return {
                  ...current,
                  agents: { ...current.agents, gjc: { ...gjc, ...(executable ? { executable } : {}) } },
                };
              })
            }
          />
        </CardField>
        <CardField label={t("모델 프로필")}>
          <input
            list="gjc-model-profiles"
            aria-label={t("모델 프로필")}
            value={preferences.modelPreset}
            onChange={(event) =>
              editPreferences((current) => ({
                ...current,
                modelPreset: event.target.value,
              }))
            }
            placeholder="codex-medium"
          />
          <datalist id="gjc-model-profiles">
            {BUILT_IN_MODEL_PRESETS.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
        </CardField>
        <CardField label={t("기본 승인 방식")}>
          <Dropdown
            value={preferences.permissionHandling}
            ariaLabel={t("GJC 기본 승인 방식")}
            options={(["prompt", "auto", "always-allow"] as const).map((value) => ({ value, label: gjcApprovalLabel(value) }))}
            onChange={(value) =>
              editPreferences((current) => ({
                ...current,
                permissionHandling:
                  value as AgentControlPreferences["permissionHandling"],
              }))
            }
          />
        </CardField>
      </div>
      <div className="agent-card__signin">
        <span className="agent-card__label">{t("로그인")}</span>
        <small>
          {onLogin
            ? t("ChatGPT·Claude 구독이나 API 키로 로그인합니다. 다른 AI를 더할 때도 여기서 합니다.")
            : t("데스크톱 앱에서 로그인할 수 있습니다.")}
        </small>
        {onLogin && (
          <button type="button" className="button-secondary" onClick={onLogin}>
            {t("AI 로그인")}
          </button>
        )}
      </div>
      <div className="agent-card__signin">
        <span className="agent-card__label">{t("업데이트")}</span>
        <small>
          {updateError ||
            (updateStatus
              ? updateStatus.updateAvailable
                ? t`${updateStatus.currentVersion} → ${updateStatus.latestVersion} 사용 가능`
                : t`최신 버전 ${updateStatus.currentVersion}`
              : t("아직 확인하지 않았습니다"))}
        </small>
        <span className="agent-card__actions">
          <button type="button" className="button-secondary" disabled={Boolean(updateBusy)} onClick={onCheckUpdate}>
            {updateBusy === "checking" ? t("확인 중…") : t("다시 확인")}
          </button>
          {updateStatus?.updateAvailable && (
            <button type="button" className="button-primary" disabled={Boolean(updateBusy)} onClick={onInstallUpdate}>
              {updateBusy === "installing" ? t("업데이트 중…") : t("업데이트")}
            </button>
          )}
        </span>
      </div>
      <nav className="agent-card__links" aria-label={t("GJC 설정 더 보기")}>
        {gjcLinks.map((link) => (
          <button type="button" key={link.id} onClick={() => setTab(link.id)}>
            {link.label} <ChevronRight size={12} aria-hidden="true" />
          </button>
        ))}
      </nav>
      <footer className="agent-card__foot">
        {saveError ? (
          <small className="composer-error" role="alert">{saveError}</small>
        ) : (
          <small>
            {!loaded
              ? t("설정을 불러온 뒤 저장할 수 있습니다.")
              : savedNote || (runtimeDirty ? t("저장하면 GJC를 다시 연결합니다.") : t("바꾼 내용이 없습니다."))}
          </small>
        )}
        <button
          type="button"
          className="button-primary"
          disabled={!canSavePreferences(runtimeDirty, saving, Boolean(settingsBridge), loaded)}
          onClick={() => void saveSettings()}
        >
          {saving ? t("저장 중…") : t("저장")}
        </button>
      </footer>
    </>
  );

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("설정")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav aria-label={t("설정")}>
          <h2>{t("설정")}</h2>
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={page === item.id ? "is-active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={contentRef}>
          <header>
            <div>
              {isGjcPage(tab) && (
                <button type="button" className="settings-back" onClick={() => openAgentCard("gjc")}>
                  <ArrowLeft size={13} aria-hidden="true" /> {t("에이전트")} · GJC
                </button>
              )}
              <h2>{pageTitle[tab]}</h2>
              <p>{pageDescription[tab]}</p>
            </div>
            <button className="icon-button" type="button" aria-label={t("닫기")} onClick={onClose}>
              <X size={19} />
            </button>
          </header>

          {loadError && (
            <p className="diff-error" role="alert">
              {t("설정을 불러오지 못했습니다:")} {loadError}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t("다시 시도")}
              </button>
            </p>
          )}
          {saveError && page !== "agents" && (
            <p className="diff-error" role="alert">
              {t("설정을 저장하지 못했습니다:")} {saveError}
            </p>
          )}

          {tab === "general" && (
            <div className="settings-stack settings-general">
              <SettingsSection title={t("모양")}>
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("테마")}</strong>
                    <small>{t("‘시스템’은 macOS 화면 모드를 따릅니다.")}</small>
                  </span>
                  <Dropdown
                    ariaLabel={t("테마")}
                    value={themeMode}
                    options={[
                      { value: "light", label: t("라이트") },
                      { value: "dark", label: t("다크") },
                      { value: "system", label: t("시스템") },
                    ]}
                    onChange={(value) => {
                      const mode = value as ThemeMode;
                      setThemeMode(mode);
                      setThemeModeState(mode);
                    }}
                  />
                </div>
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("언어")}</strong>
                    <small>{t("바꾸면 바로 적용됩니다.")}</small>
                  </span>
                  <Dropdown
                    ariaLabel={t("언어")}
                    value={languageMode}
                    options={[
                      { value: "ko", label: "한국어" },
                      { value: "en", label: "English" },
                      { value: "system", label: t("시스템") },
                    ]}
                    onChange={(value) => {
                      const resolved = setLanguageMode(value as typeof languageMode);
                      const next = {
                        ...preferencesRef.current,
                        language: resolved,
                      };
                      preferencesRef.current = next;
                      setPreferences(next);
                      setOriginal((original) => ({ ...original, language: resolved }));
                      setSaveError("");
                      if (settingsBridge) {
                        void settingsBridge
                          .setLanguage(resolved)
                          .catch((error: unknown) =>
                            setSaveError(settingsErrorMessage(error)),
                          );
                      }
                    }}
                  />
                </div>
              </SettingsSection>

              <SettingsSection title={t("새 세션")}>
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("기본 에이전트")}</strong>
                    <small>{t("⌘T로 여는 세션과 새 세션 창이 처음 고르는 에이전트·화면입니다. 창에서 다른 것을 고르면 그게 다음 기본값이 됩니다.")}</small>
                    {choiceError && <small className="composer-error" role="alert">{choiceError}</small>}
                  </span>
                  <Dropdown
                    ariaLabel={t("기본 에이전트")}
                    value={preferences.newSession ? choiceValue(preferences.newSession) : ""}
                    options={[{ value: "", label: t("자동 (설치된 첫 에이전트)") }, ...newSessionChoices]}
                    onChange={(value) => void saveNewSessionChoice(value)}
                  />
                </div>
                <div className="settings-toggle-row workspace-card">
                  <span>
                    <strong>{t("기본 폴더")}</strong>
                    <small>{t("새 세션 창이 처음 여는 폴더입니다.")}</small>
                    <code className="settings-path" title={preferences.workspace}>{preferences.workspace}</code>
                    {workspaceError && <small className="composer-error" role="alert">{t("폴더를 고르지 못했습니다:")} {workspaceError}</small>}
                  </span>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!settingsBridge || !loaded || saving}
                    onClick={() => void chooseWorkspace()}
                  >
                    <FolderOpen size={13} aria-hidden="true" /> {t("바꾸기…")}
                  </button>
                </div>
              </SettingsSection>

              <SettingsSection title={t("대화")}>
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("작업 중에 Enter를 누르면")}</strong>
                    <small>{t("/queue와 /steer는 이 설정과 상관없이 그대로 동작합니다.")}</small>
                  </span>
                  <Dropdown
                    value={preferences.runningSubmission}
                    ariaLabel={t("실행 중 Enter 동작")}
                    options={[
                      { value: "queue", label: t("턴이 끝나면 보내기 (Queue)") },
                      { value: "steer", label: t("지금 끼어들기 (Steer)") },
                    ]}
                    onChange={(value) =>
                      void persistRunningSubmission(value as "queue" | "steer")
                    }
                  />
                </div>
                <label className="settings-toggle-row">
                  <span>
                    <strong>{t("추론 카드 펼쳐 두기")}</strong>
                    <small>{t("모든 세션에서 추론(thinking) 내용을 펼친 채로 보여 줍니다.")}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={thoughtsExpanded}
                    onChange={onToggleThoughtsExpanded}
                  />
                </label>
              </SettingsSection>

              <SettingsSection
                title={t("알림")}
                description={t("지금 보고 있는 세션은 알리지 않습니다. 원격 PWA는 같은 기준으로 앱 배지를 붙입니다.")}
              >
                {NOTIFICATION_ROWS.map((row) => {
                  const preference =
                    preferences.notificationPreferences[row.key];
                  const label = t(row.label);
                  return (
                    <div className="settings-toggle-row" key={row.key}>
                      <span>
                        <strong>{label}</strong>
                        <small>{t(row.detail)}</small>
                      </span>
                      <span className="notification-controls">
                        <Dropdown
                          value={preference.sound}
                          ariaLabel={t`${label} 알림 소리`}
                          options={NOTIFICATION_SOUNDS.map((sound) => ({
                            value: sound,
                            label: t(NOTIFICATION_SOUND_LABELS[sound]),
                          }))}
                          onChange={(sound) =>
                            void persistNotifications({
                              ...preferencesRef.current
                                .notificationPreferences,
                              [row.key]: {
                                ...preference,
                                sound: sound as (typeof NOTIFICATION_SOUNDS)[number],
                              },
                            })
                          }
                        />
                        <input
                          type="checkbox"
                          aria-label={t`${label} 알림`}
                          checked={preference.enabled}
                          disabled={!settingsBridge}
                          onChange={(event) =>
                            void persistNotifications({
                              ...preferencesRef.current
                                .notificationPreferences,
                              [row.key]: {
                                ...preference,
                                enabled: event.target.checked,
                              },
                            })
                          }
                        />
                      </span>
                    </div>
                  );
                })}
              </SettingsSection>

              <SettingsSection title={t("데스크톱")}>
                {(
                  [
                    {
                      key: "preventSleep",
                      label: t("작업 중 잠자기 막기"),
                      detail: t("세션이 일하는 동안만 Mac이 잠들지 않게 합니다."),
                    },
                    {
                      key: "menuBarStatus",
                      label: t("메뉴바에 상태 표시"),
                      detail: t("일하는 세션과 확인이 필요한 세션 수를 메뉴바에 보여 줍니다."),
                    },
                    {
                      key: "dockBadge",
                      label: t("Dock 배지"),
                      detail: t("승인 대기, 실패, 읽지 않은 완료 세션 수를 Dock 아이콘에 붙입니다."),
                    },
                  ] as const
                ).map((row) => (
                  <div className="settings-toggle-row" key={row.key}>
                    <span>
                      <strong>{row.label}</strong>
                      <small>{row.detail}</small>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={row.label}
                      checked={preferences.desktopIntegration[row.key]}
                      disabled={!settingsBridge}
                      onChange={(event) =>
                        void persistDesktopIntegration({
                          ...preferencesRef.current.desktopIntegration,
                          [row.key]: event.target.checked,
                        })
                      }
                    />
                  </div>
                ))}
                <QuickInputShortcutRow
                  bridge={settingsBridge}
                  value={preferences.desktopIntegration.quickInputShortcut}
                  onChange={(quickInputShortcut) =>
                    persistDesktopIntegration({
                      ...preferencesRef.current.desktopIntegration,
                      quickInputShortcut,
                    })
                  }
                />
              </SettingsSection>

              <SettingsSection title={t("업데이트")}>
                <AppUpdateRow bridge={settingsBridge} />
                <div className="settings-toggle-row">
                  <span>
                    <strong>{t("새 버전 알림")}</strong>
                    <small>{t("하루에 한 번 GitHub 릴리스를 확인하고, 새 버전마다 한 번만 알립니다. 내려받지는 않습니다.")}</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={t("새 버전 알림")}
                    checked={preferences.desktopIntegration.checkAppUpdates}
                    disabled={!settingsBridge}
                    onChange={(event) =>
                      void persistDesktopIntegration({
                        ...preferencesRef.current.desktopIntegration,
                        checkAppUpdates: event.target.checked,
                      })
                    }
                  />
                </div>
              </SettingsSection>
            </div>
          )}

          {tab === "agents" && (
            <AgentsSettingsPanel
              key={loaded ? "loaded" : "fallback"}
              bridge={settingsBridge}
              agents={preferences.agents ?? {}}
              onAgents={(agents) => adoptSaved({ agents })}
              gjc={{ status: gjcStatus, body: gjcBody }}
            />
          )}

          {tab === "approvals" && (
            <ApprovalSettingsPanel
              bridge={settingsBridge}
              agents={preferences.agents ?? {}}
              permissionHandling={preferences.permissionHandling}
              onOpenAgent={openAgentCard}
              onOpenRemote={() => setTab("remote")}
            />
          )}

          {tab === "projects" && <ProjectSettingsPanel bridge={settingsBridge} projects={projects} />}

          {tab === "remote" && (
            <LazyViewBoundary>
              <Suspense fallback={null}>
                <RemoteAccessPanel />
              </Suspense>
            </LazyViewBoundary>
          )}

          {tab === "advanced" && <AdvancedSettingsPanel bridge={settingsBridge} onLogin={onLogin} />}

          {tab === "gjcSettings" && <GjcSettingsPanel bridge={settingsBridge} />}
          {(tab === "mcp" || tab === "skills" || tab === "usage") && (
            <div className="settings-stack">
              {managementLoading && (
                <p className="settings-empty">{t("불러오는 중…")}</p>
              )}
              {managementError && (
                <p className="diff-error">{managementError}</p>
              )}
              {!managementLoading &&
                !managementError &&
                management &&
                managementBridge && (
                  <ManagementPanel
                    tab={tab}
                    snapshot={management}
                    workspace={preferences.workspace}
                    bridge={managementBridge}
                    onSnapshot={setManagement}
                    onError={setManagementError}
                  />
                )}
              {!managementLoading && !managementError && !management && (
                <p className="settings-empty">{managementBridge ? t("불러오는 중…") : t("데스크톱 앱에서 볼 수 있습니다.")}</p>
              )}
            </div>
          )}
          {tab === "automations" && (
            <AutomationPanel
              defaultWorkspace={preferences.workspace}
              defaultModel={preferences.modelPreset}
            />
          )}
        </div>
      </section>
    </div>
  );
}
