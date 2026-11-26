/**
 * Settings kept per project, in the app's user data rather than in the repository.
 *
 * A project is a repository's main working tree, so every worktree and session of a
 * repository shares one record. The setup script is a command this app runs on the
 * user's behalf, which is why it lives next to the user's own settings: a file a
 * repository carries can never make this app run anything.
 */

export interface ProjectSettings {
  /** A new session starts in a new worktree of this project unless the user picks otherwise. */
  newSessionWorktree: boolean;
  /** Shell script run in a new worktree right after it is created; empty runs nothing. */
  setupScript: string;
  /**
   * Files copied from the project's main working tree into every new worktree: the ones
   * Git does not carry (`.env`, local config). Paths are relative to the project root.
   */
  copyFiles: string[];
}

export const DEFAULT_PROJECT_SETTINGS: Readonly<ProjectSettings> = Object.freeze({
  newSessionWorktree: false,
  setupScript: "",
  copyFiles: [],
});

export const PROJECT_SETTINGS_LIMITS = {
  setupScriptLength: 8000,
  copyFiles: 50,
  copyPathLength: 512,
} as const;

/** One project's saved settings, keyed by its main working tree. */
export interface ProjectSettingsEntry {
  root: string;
  settings: ProjectSettings;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/**
 * A copy path as it is stored: relative to the project root, with single slashes and
 * no `.` segments. Anything that could leave the root (`..`, an absolute or `~` path),
 * name Git's own folder, or mean something other than one file is refused.
 */
export function normalizeCopyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > PROJECT_SETTINGS_LIMITS.copyPathLength) return undefined;
  if (hasControlCharacter(text) || text.includes("\\")) return undefined;
  if (text.startsWith("/") || text.startsWith("~") || text.endsWith("/")) return undefined;
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return undefined;
  // a case-insensitive disk would let `.GIT` reach the repository's own folder
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) return undefined;
  return segments.join("/");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function copyList(value: unknown, onInvalid?: (entry: unknown) => void): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    const normalized = normalizeCopyPath(entry);
    if (!normalized) onInvalid?.(entry);
    else if (!paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function validScript(value: unknown): value is string {
  return typeof value === "string" && value.length <= PROJECT_SETTINGS_LIMITS.setupScriptLength && !value.includes("\0");
}

/** What a stored file or an older build left, keeping only what is valid. */
export function parseProjectSettings(value: unknown): ProjectSettings {
  const record = asRecord(value);
  if (!record) return { ...DEFAULT_PROJECT_SETTINGS, copyFiles: [] };
  return {
    newSessionWorktree: record.newSessionWorktree === true,
    setupScript: validScript(record.setupScript) ? record.setupScript.trim() : "",
    copyFiles: copyList(record.copyFiles).slice(0, PROJECT_SETTINGS_LIMITS.copyFiles),
  };
}

/** Why an input from the window is refused, or null when it can be saved. */
export function projectSettingsFault(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return "Project settings are required";
  if (typeof record.newSessionWorktree !== "boolean") return "Project settings need newSessionWorktree";
  if (!validScript(record.setupScript)) return "Project setup script is invalid";
  if (!Array.isArray(record.copyFiles)) return "Project copy files must be a list";
  if (record.copyFiles.length > PROJECT_SETTINGS_LIMITS.copyFiles) return "Project copy files has too many entries";
  let invalid: unknown;
  copyList(record.copyFiles, (entry) => {
    invalid ??= entry;
  });
  return invalid === undefined ? null : `Project copy path is invalid: ${String(invalid).slice(0, 80)}`;
}

export function isDefaultProjectSettings(settings: ProjectSettings): boolean {
  return !settings.newSessionWorktree && settings.setupScript === "" && settings.copyFiles.length === 0;
}
