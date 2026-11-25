import { useEffect, useState } from "react";
import { Bot, SquareTerminal } from "lucide-react";
import type { AgentKindId } from "../../shared/agent-contract";
import type { AgentAvailability } from "../../shared/terminal-ipc";
import { t } from "../i18n";

/**
 * The agents installed here, one chip each, for the empty workspace: a click opens the
 * new-session dialog on that agent. Nothing renders until the host answers, or where it
 * cannot list agents (a remote device, the sample data).
 */
export function EmptyWorkspaceAgents({ onPick }: { onPick: (agentKind: AgentKindId) => void }) {
  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  useEffect(() => {
    const listAgents = window.agentControlDesktop?.terminal?.listAgents;
    if (typeof listAgents !== "function") return;
    let current = true;
    listAgents().then(
      (found) => {
        if (current) setAgents(found.filter((agent) => agent.installed));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  if (agents.length === 0) return null;
  return (
    <ul className="workspace-empty__agents" aria-label={t("에이전트로 새 세션 시작")}>
      {agents.map((agent) => (
        <li key={agent.id}>
          <button type="button" onClick={() => onPick(agent.id)}>
            {agent.id === "shell" ? <SquareTerminal size={13} aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />}
            {agent.id === "shell" ? t("셸") : agent.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
