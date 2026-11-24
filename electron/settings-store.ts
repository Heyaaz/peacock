import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AgentControlPreferences,
  AgentKindId,
  AgentPreferences,
  AgentPreferencesMap,
  GjcPermissionHandling,
  NewSessionChoice,
  NotificationPreferences,
  ToolViewMode,
  UiLanguage,
} from '../shared/agent-contract.js'
import {
  AGENT_KIND_IDS,
  DEFAULT_MODEL_PRESET,
  DEFAULT_TOOL_VIEW_MODE,
  isAgentKindId,
  isToolViewMode,
  parseNotificationPreferences,
} from '../shared/agent-contract.js'
import { agentSupportsSurface } from '../shared/agent-catalog.js'
import { launchOptionsFault, launchOptions } from '../shared/agent-launch.js'
import {
  parseDesktopIntegration,
  type DesktopIntegrationPreferences,
} from '../shared/desktop-integration.js'

const PERMISSION_MODES = new Set<GjcPermissionHandling>(['prompt', 'auto', 'always-allow'])

function validModelPreset(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 128
    && !/[\p{Cc}\p{Cf}]/u.test(value)
}

export function validDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value)) return false
  // Electron patches fs so an app.asar archive reports itself as a virtual
  // directory. It is still not a legal process cwd: Node spawn rejects it with
  // ENOTDIR. Reject the archive and every virtual path inside it explicitly.
  if (value.split(path.sep).some((segment) => segment.toLowerCase().endsWith('.asar'))) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function validExecutable(value: unknown): value is string {
  if (value === '') return true
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  try {
    accessSync(value, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A choice of what 새 세션 opens, if it names an agent and a screen that agent has. */
export function parseNewSessionChoice(value: unknown): NewSessionChoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { agentKind, surface } = value as { agentKind?: unknown; surface?: unknown }
  if (!isAgentKindId(agentKind) || (surface !== 'chat' && surface !== 'terminal')) return undefined
  return agentSupportsSurface(agentKind, surface) ? { agentKind, surface } : undefined
}

/** One agent's settings, keeping only what is valid: a stored file may be older or hand-edited. */
function parseAgentPreferences(agentKind: AgentKindId, value: unknown): AgentPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { executable, launch } = value as { executable?: unknown; launch?: unknown }
  const parsed: AgentPreferences = {}
  if (typeof executable === 'string' && executable !== '' && validExecutable(executable)) parsed.executable = executable
  if (launch !== undefined && launchOptionsFault(agentKind, launch) === null) {
    const options = launchOptions(agentKind, launch)
    if (options) parsed.launch = options
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/**
 * Every agent's settings. A file from before P5 kept GJC's executable as
 * `gjcExecutable`; it becomes `agents.gjc.executable` unless that is already set.
 */
function parseAgents(candidate: Record<string, unknown>): AgentPreferencesMap {
  const stored = candidate.agents && typeof candidate.agents === 'object' && !Array.isArray(candidate.agents)
    ? candidate.agents as Record<string, unknown>
    : {}
  const agents: AgentPreferencesMap = {}
  for (const id of AGENT_KIND_IDS) {
    const parsed = parseAgentPreferences(id, stored[id])
    if (parsed) agents[id] = parsed
  }
  const legacy = candidate.gjcExecutable
  if (!agents.gjc?.executable && typeof legacy === 'string' && legacy !== '' && validExecutable(legacy))
    agents.gjc = { ...agents.gjc, executable: legacy }
  return agents
}

/**
 * What 새 세션 opens. A file from before P5 has `newSessionKind` instead: `app` was
 * the GJC chat and `cli` a shell's terminal, and a stored file with neither predates
 * the choice, when every new session was a GJC chat. Only a first run (no file)
 * leaves it unset, for the first installed agent.
 */
function parseNewSession(candidate: Record<string, unknown>, stored: boolean): NewSessionChoice | undefined {
  const chosen = parseNewSessionChoice(candidate.newSession)
  if (chosen) return chosen
  // a file this version wrote says `null` for "not chosen yet"
  if (candidate.newSession === null) return undefined
  if (candidate.newSessionKind === 'cli') return { agentKind: 'shell', surface: 'terminal' }
  if (candidate.newSessionKind === 'app' || (stored && candidate.newSession === undefined)) return { agentKind: 'gjc', surface: 'chat' }
  return undefined
}

export function parsePreferences(value: unknown, defaultWorkspace: string): AgentControlPreferences {
  const stored = Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0)
  const candidate = value && typeof value === 'object'
    ? value as Partial<AgentControlPreferences>
    : {}
  const record = candidate as Record<string, unknown>
  const newSession = parseNewSession(record, stored)
  return {
    workspace: validDirectory(candidate.workspace)
      ? path.resolve(candidate.workspace)
      : validDirectory(defaultWorkspace)
        ? path.resolve(defaultWorkspace)
        : homedir(),
    // The old English default reads as unset, so it follows the current default.
    workspaceLabel: typeof candidate.workspaceLabel === 'string' && candidate.workspaceLabel.trim() &&
      candidate.workspaceLabel.trim() !== 'Private workspace'
      ? candidate.workspaceLabel.trim().slice(0, 60)
      : '내 작업 공간',
    modelPreset: validModelPreset(candidate.modelPreset)
      ? candidate.modelPreset.trim()
      : DEFAULT_MODEL_PRESET,
    permissionHandling: PERMISSION_MODES.has(candidate.permissionHandling as GjcPermissionHandling)
      ? candidate.permissionHandling as GjcPermissionHandling
      : 'prompt',
    agents: parseAgents(record),
    // Junk in a stored file reads as collapsed. Only a stored `true` opens the cards,
    // so a hand-edited or older value cannot leave the preference stuck open.
    thoughtsExpanded: candidate.thoughtsExpanded === true,
    // A file written before the density preference existed carries no key and keeps
    // the previous default. Junk also falls back instead of breaking the settings load.
    toolViewMode: isToolViewMode(candidate.toolViewMode)
      ? candidate.toolViewMode
      : DEFAULT_TOOL_VIEW_MODE,
    notificationPreferences: parseNotificationPreferences(
      candidate.notificationPreferences,
    ),
    desktopIntegration: parseDesktopIntegration(candidate.desktopIntegration),
    language: candidate.language === 'en' ? 'en' : 'ko',
    runningSubmission:
      candidate.runningSubmission === "steer" ? "steer" : "queue",
    ...(newSession ? { newSession } : {}),
  }
}

export class SettingsStore {
  private readonly filePath: string
  private readonly defaultWorkspace: string
  private preferences: AgentControlPreferences

  constructor(userDataDirectory: string, defaultWorkspace: string) {
    this.filePath = path.join(userDataDirectory, 'agent-control-settings.json')
    this.defaultWorkspace = validDirectory(defaultWorkspace) ? path.resolve(defaultWorkspace) : homedir()
    this.preferences = this.read()
  }

  get(): AgentControlPreferences {
    return { ...this.preferences }
  }

  validate(value: unknown): AgentControlPreferences {
    const preferences = parsePreferences(value, this.defaultWorkspace)
    if (!validDirectory((value as Partial<AgentControlPreferences> | null)?.workspace)) {
      throw new Error('Workspace must be an existing absolute directory')
    }
    if (!validModelPreset((value as Partial<AgentControlPreferences> | null)?.modelPreset)) {
      throw new Error('GJC model profile must be a non-empty profile ID of at most 128 characters')
    }
    if (!PERMISSION_MODES.has((value as Partial<AgentControlPreferences> | null)?.permissionHandling as GjcPermissionHandling)) {
      throw new Error('Unsupported GJC permission mode')
    }
    const gjcExecutable = (value as Partial<AgentControlPreferences> | null)?.agents?.gjc?.executable
    if (gjcExecutable !== undefined && !validExecutable(gjcExecutable)) {
      throw new Error('GJC executable must be blank or an executable absolute path')
    }
    // A stored file written before this preference existed has no key at all; only a
    // value that is present and not a boolean is a mistake worth refusing.
    const thoughtsExpanded = (value as Partial<AgentControlPreferences> | null)?.thoughtsExpanded
    if (thoughtsExpanded !== undefined && typeof thoughtsExpanded !== 'boolean') {
      throw new Error('Thought card expansion must be a boolean')
    }
    const toolViewMode = (value as Partial<AgentControlPreferences> | null)?.toolViewMode
    if (toolViewMode !== undefined && !isToolViewMode(toolViewMode)) {
      throw new Error('Tool view mode must be basic, reasoning, or detailed')
    }
    const language = (value as Partial<AgentControlPreferences> | null)?.language
    if (language !== undefined && language !== 'ko' && language !== 'en') {
      throw new Error('UI language must be ko or en')
    }

    return preferences
  }

  /**
   * The runtime settings of a whole-object save. Every other field has its own
   * field-only channel, and the renderer's copy of it can be older than the store
   * (another window toggled it since), so the stored value is kept.
   */
  save(value: unknown): AgentControlPreferences {
    const { workspace, modelPreset, permissionHandling, agents } = this.validate(value)
    // GJC's executable is a runtime setting saved with the rest; other agents keep theirs
    const { gjc: _previous, ...others } = this.preferences.agents
    const gjc = agents.gjc?.executable ? { ...this.preferences.agents.gjc, executable: agents.gjc.executable } : this.withoutExecutable(this.preferences.agents.gjc)
    const preferences = {
      ...this.preferences,
      workspace,
      modelPreset,
      permissionHandling,
      agents: { ...others, ...(gjc ? { gjc } : {}) },
    }
    this.persist(preferences)
    this.preferences = preferences
    return this.get()
  }

  private withoutExecutable(value: AgentPreferences | undefined): AgentPreferences | undefined {
    if (!value) return undefined
    const { executable: _executable, ...rest } = value
    return Object.keys(rest).length > 0 ? rest : undefined
  }

  setWorkspaceLabel(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Workspace name cannot be empty')
    const preferences = { ...this.preferences, workspaceLabel: value.trim().slice(0, 60) }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.workspaceLabel
  }

  setThoughtsExpanded(value: boolean): boolean {
    const preferences = { ...this.preferences, thoughtsExpanded: value }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.thoughtsExpanded
  }

  /** Conversation density, saved without the runtime confirmation. */
  setToolViewMode(value: unknown): ToolViewMode {
    if (!isToolViewMode(value))
      throw new Error('Tool view mode must be basic, reasoning, or detailed')
    const preferences = { ...this.preferences, toolViewMode: value }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.toolViewMode
  }

  /** Enter behavior while a turn runs, saved without the runtime confirmation. */
  setRunningSubmission(value: unknown): "queue" | "steer" {
    if (value !== "queue" && value !== "steer")
      throw new Error("Running submission must be queue or steer")
    const runningSubmission: "queue" | "steer" = value
    const preferences = { ...this.preferences, runningSubmission }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.runningSubmission
  }

  /** What 새 세션 opens, saved without the runtime confirmation; null forgets it. */
  setNewSession(value: unknown): NewSessionChoice | null {
    if (value === null) {
      const { newSession: _forgotten, ...rest } = this.preferences
      this.persist(rest)
      this.preferences = rest
      return null
    }
    const newSession = parseNewSessionChoice(value)
    if (!newSession) throw new Error('New session must name an agent and a screen it has')
    const preferences = { ...this.preferences, newSession }
    this.persist(preferences)
    this.preferences = preferences
    return newSession
  }

  /**
   * One agent's executable and new-session defaults, saved without the runtime
   * confirmation: they change what the next terminal starts, not a running one.
   * GJC's executable is a runtime setting and goes through `save`.
   */
  setAgentPreferences(agentKind: unknown, value: unknown): AgentPreferencesMap {
    if (!isAgentKindId(agentKind)) throw new Error('Unknown agent')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent settings must be an object')
    const { executable, launch } = value as { executable?: unknown; launch?: unknown }
    if (executable !== undefined && executable !== '' && !validExecutable(executable))
      throw new Error('Executable must be blank or an executable absolute path')
    if (agentKind === 'gjc' && executable !== undefined) throw new Error('GJC executable is saved with the GJC settings')
    const fault = launch === undefined ? null : launchOptionsFault(agentKind, launch)
    if (fault) throw new Error(fault)
    const next: AgentPreferences = { ...this.preferences.agents[agentKind] }
    if (executable !== undefined) {
      if (executable === '') delete next.executable
      else next.executable = executable as string
    }
    if (launch !== undefined) {
      const options = launchOptions(agentKind, launch)
      if (options) next.launch = options
      else delete next.launch
    }
    const agents = { ...this.preferences.agents }
    if (Object.keys(next).length > 0) agents[agentKind] = next
    else delete agents[agentKind]
    const preferences = { ...this.preferences, agents }
    this.persist(preferences)
    this.preferences = preferences
    return { ...agents }
  }

  /** Resolved UI language for native host text. */
  setLanguage(value: unknown): UiLanguage {
    if (value !== 'ko' && value !== 'en')
      throw new Error('UI language must be ko or en')
    const language: UiLanguage = value
    const preferences = { ...this.preferences, language }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.language
  }

  /** Display-only notification settings, saved without the runtime confirmation. */
  setNotificationPreferences(value: unknown): NotificationPreferences {
    const preferences = {
      ...this.preferences,
      notificationPreferences: parseNotificationPreferences(value),
    }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.notificationPreferences
  }

  /** Desktop integration settings, saved without the runtime confirmation. */
  setDesktopIntegration(value: unknown): DesktopIntegrationPreferences {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Desktop integration settings must be an object')
    const preferences = {
      ...this.preferences,
      desktopIntegration: parseDesktopIntegration(value),
    }
    this.persist(preferences)
    this.preferences = preferences
    return this.preferences.desktopIntegration
  }

  private persist(preferences: AgentControlPreferences): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    // `newSession: null` tells a first run's file from one written before the choice existed
    writeFileSync(temporaryPath, `${JSON.stringify({ ...preferences, newSession: preferences.newSession ?? null }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }

  private read(): AgentControlPreferences {
    try {
      return parsePreferences(JSON.parse(readFileSync(this.filePath, 'utf8')), this.defaultWorkspace)
    } catch {
      return parsePreferences(undefined, this.defaultWorkspace)
    }
  }
}
