import type { AgentKindId } from "./agent-contract.js";
import type { AgentLaunchOptions } from "./agent-launch.js";
import type { ParallelAgentOption, ParallelGroup } from "./parallel-run.js";

export interface ParallelStartInput {
  title: string;
  workspace: string;
  prompt: string;
  /** Base branch name; each attempt adds its own suffix. */
  branch?: string;
  /**
   * One per attempt, 2-4 of them: a GJC model preset, or for a terminal agent its model
   * (`PARALLEL_AGENT_DEFAULT_MODEL` for the agent's own default).
   */
  presets: string[];
  /** The agent every attempt runs (P6); unset is GJC. */
  agentKind?: AgentKindId;
  /** A terminal agent's other launch options (permission mode, effort), the same for every attempt. */
  launch?: Omit<AgentLaunchOptions, "model">;
}

export const PARALLEL_IPC = {
  list: "agent-control:parallel:list",
  /** Which agents a parallel run can use here, with why not for the others (P6). */
  agents: "agent-control:parallel:agents",
  start: "agent-control:parallel:start",
  adopt: "agent-control:parallel:adopt",
  discard: "agent-control:parallel:discard",
  /** Removes the undecided attempts' worktrees and branches behind a native confirmation. */
  cleanup: "agent-control:parallel:cleanup",
  changed: "agent-control:parallel:changed",
} as const;

export interface ParallelDesktopBridge {
  list(): Promise<ParallelGroup[]>;
  agents(): Promise<ParallelAgentOption[]>;
  start(input: ParallelStartInput): Promise<ParallelGroup>;
  adopt(groupId: string, attemptId: string): Promise<ParallelGroup>;
  discard(groupId: string): Promise<ParallelGroup>;
  cleanup(groupId: string): Promise<ParallelGroup>;
  onChanged(listener: (groups: ParallelGroup[]) => void): () => void;
}
