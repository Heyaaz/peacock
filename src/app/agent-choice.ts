import type { AgentKindId, NewSessionChoice } from "../../shared/agent-contract";
import type { AgentAvailability } from "../../shared/terminal-ipc";

/** The agents that come first when nothing was chosen yet, in this order. */
export const DEFAULT_AGENT_ORDER: readonly AgentKindId[] = ["claude", "omp", "codex", "gjc"];

/** The agent a new session starts on: the last choice while it is installed, else the first installed. */
export function initialAgent(agents: readonly AgentAvailability[], choice: NewSessionChoice | undefined): AgentKindId {
  const installed = (id: AgentKindId) => agents.some((agent) => agent.id === id && agent.installed);
  if (choice && installed(choice.agentKind)) return choice.agentKind;
  return DEFAULT_AGENT_ORDER.find(installed) ?? (installed("shell") ? "shell" : "gjc");
}
