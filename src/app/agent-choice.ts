import type { AgentKindId, NewSessionChoice } from "../../shared/agent-contract";
import { agentCatalogEntry } from "../../shared/agent-catalog";
import type { AgentAvailability } from "../../shared/terminal-ipc";

/** The agents that come first when nothing was chosen yet, in this order. */
export const DEFAULT_AGENT_ORDER: readonly AgentKindId[] = ["claude", "omp", "codex", "gjc"];

/** The agent a new session starts on: the last choice while it is installed, else the first installed. */
export function initialAgent(agents: readonly AgentAvailability[], choice: NewSessionChoice | undefined): AgentKindId {
  const installed = (id: AgentKindId) => agents.some((agent) => agent.id === id && agent.installed);
  if (choice && installed(choice.agentKind)) return choice.agentKind;
  return DEFAULT_AGENT_ORDER.find(installed) ?? (installed("shell") ? "shell" : "gjc");
}

/** The agent and screen a new session opens on: the remembered screen while its agent is installed, else the agent's default screen. */
export function initialChoice(agents: readonly AgentAvailability[], choice: NewSessionChoice | undefined): NewSessionChoice {
  const agentKind = initialAgent(agents, choice);
  const entry = agentCatalogEntry(agentKind);
  return {
    agentKind,
    surface:
      choice?.agentKind === agentKind && entry.surfaces.includes(choice.surface)
        ? choice.surface
        : entry.defaultSurface,
  };
}
