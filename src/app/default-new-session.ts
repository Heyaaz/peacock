import type { NewSessionChoice } from "../../shared/agent-contract";
import type { AgentLaunchOptions } from "../../shared/agent-launch";
import { DEFAULT_SESSION_TITLE } from "../../shared/session-title";
import type { NewSessionInput } from "./dialogs";

/**
 * A branch for a worktree made without asking: `peacock/<time>-<random>`, so two sessions
 * started in the same second still get branches of their own.
 */
export function autoWorktreeBranch(now: number = Date.now(), random: () => number = Math.random): string {
  const salt = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `peacock/${now.toString(36)}-${salt}`;
}

/**
 * What ⌘T creates: the agent the user last chose, in `workspace`, started as the chat or terminal
 * of that choice. A project that starts new sessions in a worktree by default (`worktreeRoot`
 * is its main working tree) has the session made in a new worktree of it, on an automatic branch.
 */
export function defaultSessionInput(input: {
  choice: NewSessionChoice;
  /** The agent's launch defaults from the settings. */
  launch?: AgentLaunchOptions;
  workspace: string;
  worktreeRoot?: string;
  branch?: () => string;
}): NewSessionInput {
  const place = input.worktreeRoot
    ? {
        workspace: input.worktreeRoot,
        isolation: "worktree" as const,
        worktreeBranch: (input.branch ?? autoWorktreeBranch)(),
      }
    : { workspace: input.workspace };
  const { agentKind, surface } = input.choice;
  if (agentKind === "gjc") return { title: DEFAULT_SESSION_TITLE, ...place };
  return {
    title: DEFAULT_SESSION_TITLE,
    ...place,
    kind: "terminal",
    ...(agentKind !== "shell" ? { agentKind } : {}),
    surface,
    ...(input.launch ? { launch: input.launch } : {}),
  };
}
