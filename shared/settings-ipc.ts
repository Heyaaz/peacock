import type { ImageAttachment, SessionWorkLink, WorktreePull } from "./agent-contract.js";

export const SETTINGS_IPC = {
  getPreferences: "agent-control:settings:get-preferences",
  chooseWorkspace: "agent-control:settings:choose-workspace",
  inspectWorkspace: "agent-control:settings:inspect-workspace",
  prepareImages: "agent-control:settings:prepare-images",
  prepareFiles: "agent-control:settings:prepare-files",
  discardAttachments: "agent-control:settings:discard-attachments",
  setWorkspaceLabel: "agent-control:settings:set-workspace-label",
  setThoughtsExpanded: "agent-control:settings:set-thoughts-expanded",
  setToolViewMode: "agent-control:settings:set-tool-view-mode",
  setNotificationPreferences:
    "agent-control:settings:set-notification-preferences",
  setDesktopIntegration: "agent-control:settings:set-desktop-integration",
  setLanguage: "agent-control:settings:set-language",
  setRunningSubmission: "agent-control:settings:set-running-submission",
  setNewSession: "agent-control:settings:set-new-session",
  setAgentPreferences: "agent-control:settings:set-agent-preferences",
  setViewedSession: "agent-control:settings:set-viewed-session",
  savePreferences: "agent-control:settings:save-preferences",
  checkGjcUpdate: "agent-control:settings:check-gjc-update",
  installGjcUpdate: "agent-control:settings:install-gjc-update",
  listGjcSettings: "agent-control:settings:list-gjc-settings",
  applyGjcSettings: "agent-control:settings:apply-gjc-settings",
  listCommandRules: "agent-control:settings:list-command-rules",
  removeCommandRule: "agent-control:settings:remove-command-rule",
  listProjectSettings: "agent-control:settings:list-project-settings",
  setProjectSettings: "agent-control:settings:set-project-settings",
  confirm: "agent-control:settings:confirm",
  getAppUpdateStatus: "agent-control:settings:get-app-update-status",
  checkAppUpdate: "agent-control:settings:check-app-update",
  installAppUpdate: "agent-control:settings:install-app-update",
  checkEnvironment: "agent-control:settings:check-environment",
  environmentCheckDue: "agent-control:settings:environment-check-due",
  quickInputShortcutStatus: "agent-control:settings:quick-input-shortcut-status",
  getSystemInfo: "agent-control:settings:get-system-info",
  revealDataFolder: "agent-control:settings:reveal-data-folder",
} as const;

/** What Settings › 고급 shows about this installation: the data folder, its move, herdr-core. */
export interface SystemInfo {
  appVersion: string;
  /** The data folder this run uses (`~/Library/Application Support/Peacock`). */
  userData: string;
  /** The record the first launch wrote when it copied Gajae's folder (design §11). */
  migration?: { from: string; migratedAt: string; files: number; bytes: number };
  /** Gajae's folder, still there when it was not deleted by hand. */
  legacyUserData?: string;
  /** herdr-core, where terminal sessions run; absent off macOS. */
  herdrCore?: { session: string; running: boolean; bundledVersion: string; version?: string };
}

/** What the new-session dialog needs to know about the folder it is about to start in. */
export interface WorkspaceInspection {
  /** A folder holding far more than one project: home, Documents, Desktop, Downloads, or the root. */
  broad: boolean;
  /** Whether the folder is inside a git repository. */
  git: boolean;
}

export const DESKTOP_IPC = {
  cycleEffort: "gajae:shortcut:cycle-effort",
  abortRun: "gajae:shortcut:abort-run",
  sessionShortcut: "gajae:shortcut:session",
} as const;

/** Values the new-session dialog opens with. The prompt is only ever placed in the composer, never sent. */
export type NewSessionPrefill = {
  workspace?: string;
  title?: string;
  prompt?: string;
  isolation?: "workspace" | "worktree";
  worktreeBranch?: string;
  worktreeBranchExisting?: boolean;
  worktreePull?: WorktreePull;
  /** `workspace` is the repository's main checkout, where the user's own uncommitted work lives. */
  mainCheckout?: true;
  workLink?: SessionWorkLink;
  /** Already issued to the receiving window, so its composer can send them as its own. */
  images?: ImageAttachment[];
};

/** Why a gajae:// link was refused. `session` also covers an id the window does not know. */
export type InvalidLinkReason =
  | { kind: "path"; path: string }
  | { kind: "prompt"; limit: number }
  | { kind: "session" };

/**
 * `new` without a prefill creates a session at once (⌘T). With a prefill it opens
 * the dialog instead, so text that arrived from outside waits for the user.
 */
export type SessionShortcut =
  | { type: "new"; prefill?: NewSessionPrefill }
  | { type: "open"; sessionId: string }
  | { type: "invalidLink"; reason: InvalidLinkReason }
  | { type: "select"; index: number }
  | { type: "abort" };

export function sessionShortcutForInput(input: {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}): SessionShortcut | undefined {
  if (input.type !== "keyDown") return undefined;
  if (
    !input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    isEscapeKey(input.key)
  ) {
    return { type: "abort" };
  }
  if (!input.meta || input.control || input.alt || input.shift)
    return undefined;
  if (input.key.toLowerCase() === "t") return { type: "new" };
  if (/^[1-9]$/u.test(input.key))
    return { type: "select", index: Number(input.key) - 1 };
  return undefined;
}

export function isEscapeKey(key: string): boolean {
  return key === "Escape" || key === "Esc";
}
