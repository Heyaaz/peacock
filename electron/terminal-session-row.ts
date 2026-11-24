import path from "node:path";
import { agentCatalogEntry } from "../shared/agent-catalog.js";
import type { AgentSession, SessionCapabilities, SessionStatus } from "../shared/agent-contract.js";
import type { TerminalSessionRecord } from "../shared/terminal-ipc.js";
import { recentLabel, timestampMs } from "./gjc-sdk-model.js";

/**
 * A terminal session as a session row, owned and attached by this app. A shell has no status of its
 * own; an agent's comes from what it reports (herdr-core's 7501 records and its hooks).
 */
export function terminalAgentSession(
  record: TerminalSessionRecord,
  live: { status?: SessionStatus; unread?: boolean; runRevision?: number; capabilities?: SessionCapabilities } = {},
): AgentSession {
  const agentKind = record.agentKind ?? "shell";
  const agent = agentCatalogEntry(agentKind);
  const folder = path.basename(record.workspace) || record.workspace;
  return {
    id: record.id,
    title: record.title,
    subtitle: agentKind === "shell" ? folder : `${agent.name} · ${folder}`,
    workspace: record.workspace,
    runtime: "terminal",
    status: agentKind === "shell" ? "idle" : (live.status ?? "idle"),
    ...(live.runRevision !== undefined ? { runRevision: live.runRevision } : {}),
    updatedAt: recentLabel(record.createdAt),
    updatedAtMs: timestampMs(record.createdAt),
    pinned: false,
    unread: live.unread ?? false,
    accent: "#56d4dd",
    ownership: "gajae",
    attachment: "attached",
    agentKind,
    // Claude Code and omp also have a chat screen: their transcript, read as it grows (design §5.5)
    surfaces: [...agent.surfaces],
    ...(live.capabilities ? { capabilities: live.capabilities } : {}),
  };
}
