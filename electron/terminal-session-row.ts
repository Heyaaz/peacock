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
    runtime: "herdr",
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
    // A terminal session is its terminal in the window. omp's chat is a session of its own
    // (omp-rpc); the transcript still feeds search and the phone, which reaches no terminal.
    surfaces: agent.chatRuntime ? ["terminal"] : [...agent.surfaces],
    ...(live.capabilities ? { capabilities: live.capabilities } : {}),
    ...(record.worktree ? { worktree: { ...record.worktree } } : {}),
  };
}
