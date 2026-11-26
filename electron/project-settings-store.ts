import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROJECT_SETTINGS,
  isDefaultProjectSettings,
  parseProjectSettings,
  projectSettingsFault,
  type ProjectSettings,
  type ProjectSettingsEntry,
} from "../shared/project-settings.js";

/**
 * Per-project settings, kept in the app's user data. A record belongs to a project's
 * main working tree, so every worktree and session of that project shares it;
 * `resolveRoot` maps a session's path to that root. A project with nothing set has no
 * record at all.
 */
export class ProjectSettingsStore {
  private readonly filePath: string;
  private projects: Map<string, ProjectSettings>;

  constructor(
    userDataDirectory: string,
    private readonly resolveRoot: (path: string) => Promise<string>,
  ) {
    this.filePath = path.join(userDataDirectory, "project-settings.json");
    this.projects = this.read();
  }

  /** The settings of the project a path belongs to; the defaults when it has none. */
  async get(projectPath: string): Promise<ProjectSettings> {
    return (await this.lookup(projectPath)).settings;
  }

  /** The same, with the project root the path resolved to. */
  async lookup(projectPath: string): Promise<{ root: string; settings: ProjectSettings }> {
    const root = await this.resolveRoot(projectPath);
    return { root, settings: copy(this.projects.get(root) ?? DEFAULT_PROJECT_SETTINGS) };
  }

  /** Validates, then saves what the window sent; settings equal to the defaults are forgotten. */
  async set(projectPath: string, value: unknown): Promise<ProjectSettings> {
    const fault = projectSettingsFault(value);
    if (fault) throw new Error(fault);
    const settings = parseProjectSettings(value);
    const root = await this.resolveRoot(projectPath);
    const next = new Map(this.projects);
    if (isDefaultProjectSettings(settings)) next.delete(root);
    else next.set(root, settings);
    this.commit(next);
    return copy(settings);
  }

  list(): ProjectSettingsEntry[] {
    return [...this.projects].map(([root, settings]) => ({ root, settings: copy(settings) }));
  }

  /** Memory follows disk: a failed write leaves the settings as they were. */
  private commit(next: Map<string, ProjectSettings>): void {
    this.write(next);
    this.projects = next;
  }

  private read(): Map<string, ProjectSettings> {
    const projects = new Map<string, ProjectSettings>();
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return projects;
    }
    const stored = (value as { projects?: unknown } | null)?.projects;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return projects;
    for (const [root, raw] of Object.entries(stored)) {
      if (!root) continue;
      const settings = parseProjectSettings(raw);
      if (!isDefaultProjectSettings(settings)) projects.set(root, settings);
    }
    return projects;
  }

  private write(projects: Map<string, ProjectSettings>): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ projects: Object.fromEntries(projects) }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}

function copy(settings: Readonly<ProjectSettings>): ProjectSettings {
  return { ...settings, copyFiles: [...settings.copyFiles] };
}
