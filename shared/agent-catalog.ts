/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (shared/agent-catalog.ts, shared/supported-agents.ts): the agent names, the
 * executables that mean an agent is installed, where each installer puts them,
 * and the version flag. See THIRD_PARTY_NOTICES.md.
 */
import type {
  AgentKindId,
  SessionCapabilities,
  SessionSurface,
} from "./agent-contract.js";

/**
 * The agents a session can run, and what Gajae knows about each before asking
 * the machine.
 *
 * Detection (PATH, then the login shell's PATH, then `installDirs`, with the
 * `--version` answer cached) and launching read this list. Nothing in the
 * window reads it yet.
 */
export interface AgentCatalogEntry {
  id: AgentKindId;
  /** The name the window shows. */
  name: string;
  /**
   * The executables that mean it is installed, in the order they are looked
   * for. Empty for the shell, which is the login shell (`SHELL`, then
   * /bin/zsh) and always present.
   */
  binaries: readonly string[];
  /**
   * Where the vendor's installer puts the executable on macOS, looked in when
   * PATH has none: an install often adds its folder to PATH only for terminals
   * opened afterwards, and a Finder launch inherits no user PATH. `~/` is home.
   */
  installDirs: readonly string[];
  /** The arguments that make it print its version and exit. */
  versionArgs: readonly string[];
  /** The screens its sessions can be shown on. */
  surfaces: readonly SessionSurface[];
  /** The screen a new session opens on. */
  defaultSurface: SessionSurface;
  /**
   * The most a session of this agent can offer once its runtime is wired. A
   * running session reports what it offers now (`capabilitiesOf`); this is
   * the ceiling its controller starts from, never more than that.
   */
  capabilities: Readonly<SessionCapabilities>;
}

const none: Readonly<SessionCapabilities> = {
  send: false,
  cancel: false,
  approvals: false,
  questions: false,
  goal: false,
  compact: false,
  sideQuestion: false,
  suggestion: false,
  modelConfig: false,
  thinking: false,
  fork: false,
  git: false,
  attachments: false,
  streaming: false,
};

/**
 * An agent run in a herdr terminal whose transcript Gajae reads into the chat
 * screen. Input goes through the terminal, so nothing is attached; the
 * transcript grows a whole record at a time, so nothing streams; and only the
 * approval hook reaches the agent, so its own features stay in the terminal.
 */
const terminalChat: Readonly<SessionCapabilities> = {
  ...none,
  send: true,
  cancel: true,
  approvals: true,
  git: true,
};

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    installDirs: ["~/.local/bin"],
    versionArgs: ["--version"],
    surfaces: ["terminal", "chat"],
    defaultSurface: "terminal",
    capabilities: terminalChat,
  },
  {
    id: "omp",
    name: "Oh My Pi",
    binaries: ["omp"],
    installDirs: ["~/.local/bin"],
    versionArgs: ["--version"],
    surfaces: ["terminal", "chat"],
    defaultSurface: "terminal",
    capabilities: terminalChat,
  },
  {
    id: "codex",
    name: "Codex",
    binaries: ["codex"],
    installDirs: ["~/.local/bin"],
    versionArgs: ["--version"],
    // No transcript reader is planned for codex, so it has no chat screen.
    surfaces: ["terminal"],
    defaultSurface: "terminal",
    capabilities: none,
  },
  {
    id: "gjc",
    name: "GJC",
    binaries: ["gjc"],
    // electron/runtime-path.ts: GJC's installer default first, then a Bun global.
    installDirs: ["~/.local/bin", "~/.bun/bin"],
    versionArgs: ["--version"],
    surfaces: ["chat"],
    defaultSurface: "chat",
    capabilities: {
      send: true,
      cancel: true,
      approvals: true,
      questions: true,
      goal: true,
      compact: true,
      sideQuestion: true,
      suggestion: true,
      modelConfig: true,
      thinking: true,
      fork: true,
      git: true,
      attachments: true,
      streaming: true,
    },
  },
  {
    id: "shell",
    name: "Shell",
    binaries: [],
    installDirs: [],
    versionArgs: [],
    surfaces: ["terminal"],
    defaultSurface: "terminal",
    capabilities: none,
  },
];

const BY_ID = new Map<AgentKindId, AgentCatalogEntry>(
  AGENT_CATALOG.map((entry) => [entry.id, entry]),
);

/** The catalog entry for an agent kind. Every kind has one. */
export function agentCatalogEntry(id: AgentKindId): AgentCatalogEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown agent kind: ${id}`);
  return entry;
}

/** Whether sessions of this agent can be shown on the given screen. */
export function agentSupportsSurface(
  id: AgentKindId,
  surface: SessionSurface,
): boolean {
  return agentCatalogEntry(id).surfaces.includes(surface);
}
