import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../shared/agent-contract.js";
import { runRemoteOperation, type RemoteOperationsHost } from "./operations.js";

const row = (id: string, agentKind: AgentSession["agentKind"]) => ({ id, agentKind }) as AgentSession;

describe("remote access and terminal shells", () => {
  const host = {
    getConnection: async () => ({ state: "connected" }),
    listSessions: async () => [row("gjc-1", undefined), row("terminal-shell", "shell"), row("terminal-claude", "claude")],
    getTranscript: vi.fn(async () => []),
    cancelRun: vi.fn(async () => undefined),
    hiddenFromRemote: (sessionId: string) => sessionId === "terminal-shell",
  } as unknown as RemoteOperationsHost;

  it("leaves a shell out of the list a remote device reads", async () => {
    const state = (await runRemoteOperation(host, "state", {}, undefined)) as { sessions: AgentSession[] };
    expect(state.sessions.map((session) => session.id)).toEqual(["gjc-1", "terminal-claude"]);
  });

  it("refuses any operation on a shell, whatever the client asks", async () => {
    await expect(runRemoteOperation(host, "cancel-run", { sessionId: "terminal-shell" }, undefined)).rejects.toThrow(/not available on remote/u);
    await expect(runRemoteOperation(host, "transcript", { sessionId: "terminal-shell" }, undefined)).rejects.toThrow(/not available/u);
    expect(host.cancelRun).not.toHaveBeenCalled();
    await runRemoteOperation(host, "cancel-run", { sessionId: "terminal-claude" }, undefined);
    expect(host.cancelRun).toHaveBeenCalledWith("terminal-claude");
  });
});
