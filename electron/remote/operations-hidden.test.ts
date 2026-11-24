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
    resolveToolCall: vi.fn(async () => undefined),
    hiddenFromRemote: (sessionId: string) => sessionId === "terminal-shell",
    sessionOfTool: (toolId: string) => /^(terminal-[a-z]+):/u.exec(toolId)?.[1],
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

  it("answers a Claude Code tool approval from a phone, and refuses a shell's by its tool id", async () => {
    const decision = { decision: { optionId: "allow_once" } };
    await runRemoteOperation(host, "resolve-tool-call", { toolId: "terminal-claude:toolu_1" }, decision);
    expect(host.resolveToolCall).toHaveBeenCalledWith("terminal-claude:toolu_1", { optionId: "allow_once" });
    await expect(runRemoteOperation(host, "resolve-tool-call", { toolId: "terminal-shell:toolu_2" }, decision)).rejects.toThrow(/not available/u);
    // GJC's own tool ids name no session and go on as before
    await runRemoteOperation(host, "resolve-tool-call", { toolId: "toolu_3" }, decision);
    expect(host.resolveToolCall).toHaveBeenCalledTimes(2);
  });
});
