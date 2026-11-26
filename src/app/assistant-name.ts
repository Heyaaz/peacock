import { createContext } from "react";
import type { AgentKindId } from "../../shared/agent-contract";

/** Who answers in this conversation (GJC, Oh My Pi, Claude Code), for the assistant's label. */
export const AssistantNameContext = createContext("");

/** That same agent's kind, for the mark beside its name. */
export const AssistantAgentKindContext = createContext<AgentKindId | null>(null);
