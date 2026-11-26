import { normalizeCopyPath, PROJECT_SETTINGS_LIMITS, type ProjectSettings } from "../../shared/project-settings";
import { t } from "../i18n";

/** What the fields hold: the copy list is the text of a box, one path to a line. */
export interface Draft {
  newSessionWorktree: boolean;
  setupScript: string;
  copyFiles: string;
}

export function draftOf(settings: ProjectSettings): Draft {
  return {
    newSessionWorktree: settings.newSessionWorktree,
    setupScript: settings.setupScript,
    copyFiles: settings.copyFiles.join("\n"),
  };
}

/** The settings a draft would save, or the reason it cannot be saved. */
export function settingsOfDraft(draft: Draft): { settings: ProjectSettings } | { error: string } {
  if (draft.setupScript.length > PROJECT_SETTINGS_LIMITS.setupScriptLength)
    return { error: t("setup 스크립트는 {0}자까지 쓸 수 있습니다.", { 0: PROJECT_SETTINGS_LIMITS.setupScriptLength }) };
  const copyFiles: string[] = [];
  for (const line of draft.copyFiles.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const normalized = normalizeCopyPath(line);
    if (!normalized) return { error: t("복사할 파일 경로가 올바르지 않습니다: {0}", { 0: line.trim() }) };
    if (!copyFiles.includes(normalized)) copyFiles.push(normalized);
  }
  if (copyFiles.length > PROJECT_SETTINGS_LIMITS.copyFiles)
    return { error: t("복사할 파일은 {0}개까지 적을 수 있습니다.", { 0: PROJECT_SETTINGS_LIMITS.copyFiles }) };
  return {
    settings: {
      newSessionWorktree: draft.newSessionWorktree,
      setupScript: draft.setupScript.trim(),
      copyFiles,
    },
  };
}
