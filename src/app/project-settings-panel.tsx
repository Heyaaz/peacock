import { useEffect, useMemo, useState } from "react";
import type { SettingsDesktopBridge } from "../../shared/agent-contract";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettingsEntry } from "../../shared/project-settings";
import { t } from "../i18n";
import { humanErrorMessage, isDeclinedConfirmation } from "./format";
import { Dropdown } from "./primitives";
import { projectNameOf } from "./project-model";
import { draftOf, settingsOfDraft, type Draft } from "./project-settings-draft";
import { SettingsSection } from "./settings-layout";

type Bridge = Pick<SettingsDesktopBridge, "listProjectSettings" | "setProjectSettings">;

/** A project the panel offers, by its main working tree. */
export interface ProjectChoice {
  root: string;
}

/**
 * Settings › 프로젝트: what a project does when a session gets its own worktree. Settings
 * live in the desktop host, next to the other per-project records, so a renderer without
 * that bridge (the remote web client) can neither read nor change them.
 */
export function ProjectSettingsPanel({
  bridge,
  projects,
}: {
  bridge: Bridge | undefined;
  /** The repositories the window knows; a project that has saved settings is offered too. */
  projects: readonly ProjectChoice[];
}) {
  const [entries, setEntries] = useState<ProjectSettingsEntry[] | null>(null);
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge.listProjectSettings().then(
      (next) => {
        if (active) setEntries(next);
      },
      (cause: unknown) => {
        if (active) setError(humanErrorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  const roots = useMemo(() => {
    const all = new Set([...projects.map((project) => project.root), ...(entries ?? []).map((entry) => entry.root)]);
    return [...all].sort((a, b) => projectNameOf(a).localeCompare(projectNameOf(b)) || a.localeCompare(b));
  }, [projects, entries]);

  if (!bridge)
    return (
      <SettingsSection title={t("프로젝트별 설정")}>
        <p className="settings-empty">{t("데스크톱 앱에서 볼 수 있습니다.")}</p>
      </SettingsSection>
    );

  const root = roots.includes(selected) ? selected : (roots[0] ?? "");
  const saved = entries?.find((entry) => entry.root === root)?.settings ?? DEFAULT_PROJECT_SETTINGS;
  const savedDraft = draftOf(saved);
  const draft = drafts[root] ?? savedDraft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

  function edit(patch: Partial<Draft>): void {
    setNote("");
    setError("");
    setDrafts((current) => ({ ...current, [root]: { ...(current[root] ?? savedDraft), ...patch } }));
  }

  async function save(): Promise<void> {
    const result = settingsOfDraft(draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError("");
    setNote("");
    try {
      const next = await bridge!.setProjectSettings(root, result.settings);
      setEntries(next);
      setDrafts((current) => {
        const rest = { ...current };
        delete rest[root];
        return rest;
      });
      setNote(t("저장했습니다."));
    } catch (cause) {
      // declining the host's confirmation of the script is an answer, not a failure
      if (!isDeclinedConfirmation(cause)) setError(humanErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      className="project-settings"
      title={t("프로젝트별 설정")}
      description={t("프로젝트마다, 세션이 자기 worktree에서 시작할 때 하는 일입니다. 같은 저장소의 모든 worktree가 한 설정을 씁니다.")}
    >
      {roots.length === 0 ? (
        <p className="settings-empty">
          {entries === null && !error
            ? t("불러오는 중…")
            : t("프로젝트가 없습니다. Git 저장소에서 세션을 시작하면 여기에 나타납니다.")}
        </p>
      ) : (
        <>
          <div className="settings-toggle-row">
            <span>
              <strong>{t("프로젝트")}</strong>
              <small className="settings-path" title={root}>
                {root}
              </small>
            </span>
            <Dropdown
              value={root}
              ariaLabel={t("프로젝트 고르기")}
              options={roots.map((value) => ({ value, label: projectNameOf(value), description: value }))}
              onChange={setSelected}
            />
          </div>
          <label className="settings-toggle-row">
            <span>
              <strong>{t("새 세션을 새 worktree에서 시작")}</strong>
              <small>{t("⌘T와 새 세션이 이 프로젝트의 별도 worktree에서 시작합니다. 새 세션 창에서는 바꿀 수 있습니다.")}</small>
            </span>
            <input
              type="checkbox"
              checked={draft.newSessionWorktree}
              disabled={saving}
              onChange={(event) => edit({ newSessionWorktree: event.target.checked })}
            />
          </label>
          <div className="project-settings-field">
            <label>
              <strong>{t("setup 스크립트")}</strong>
              <small>
                {t("새 worktree를 만든 직후 그 폴더에서 /bin/sh로 실행합니다. PEACOCK_ROOT_PATH, PEACOCK_WORKTREE_PATH, PEACOCK_WORKTREE_BRANCH를 쓸 수 있고, 실패해도 세션은 열립니다.")}
              </small>
              <textarea
                value={draft.setupScript}
                spellCheck={false}
                disabled={saving}
                placeholder={t("예: npm ci")}
                aria-label={t("setup 스크립트")}
                onChange={(event) => edit({ setupScript: event.target.value })}
              />
            </label>
          </div>
          <div className="project-settings-field">
            <label>
              <strong>{t("복사할 파일")}</strong>
              <small>
                {t("저장소가 추적하지 않는 파일(.env 등)을 프로젝트 폴더에서 새 worktree로 복사합니다. 한 줄에 하나, 프로젝트 폴더 기준 상대 경로입니다. 이미 있거나 Git이 추적하는 파일은 건너뜁니다.")}
              </small>
              <textarea
                value={draft.copyFiles}
                spellCheck={false}
                disabled={saving}
                placeholder={".env\nconfig/local.json"}
                aria-label={t("복사할 파일")}
                onChange={(event) => edit({ copyFiles: event.target.value })}
              />
            </label>
          </div>
          <div className="project-settings-actions">
            {error && (
              <p className="diff-error" role="alert">
                {error}
              </p>
            )}
            {note && !dirty && <small className="project-settings-note">{note}</small>}
            <button type="button" className="button-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? t("저장 중…") : t("저장")}
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
