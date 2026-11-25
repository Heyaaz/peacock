import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runsInTerminal, type AgentEvent } from "../../shared/agent-contract.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { OmpRpcController, sessionOfOmpToolId } from "./controller.js";
import { OmpRpcSessionStore } from "./session-store.js";

function setup(options: { installed?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-rpc-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "gajae-omp-ws-"));
  const store = new OmpRpcSessionStore(directory);
  const events: AgentEvent[] = [];
  const claim = vi.fn();
  const detect = vi.fn(async (): Promise<AgentAvailability> =>
    options.installed === false
      ? { id: "omp", name: "Oh My Pi", installed: false, reason: "설치되어 있지 않습니다" }
      : { id: "omp", name: "Oh My Pi", installed: true, binary: "/bin/omp", version: "19.1.1" },
  );
  const controller = new OmpRpcController({
    store,
    detect,
    environment: async () => ({ PATH: "/usr/bin" }),
    emit: (event) => events.push(event),
    claim,
    log: () => undefined,
  });
  return { directory, workspace, store, events, claim, detect, controller };
}

describe("OmpRpcController", () => {
  it("creates an omp chat row that is a conversation, not a terminal, and claims it", async () => {
    const { controller, workspace, events, claim } = setup();
    const session = await controller.createSession({
      runtime: "omp-rpc",
      workspace,
      isolation: "workspace",
      agentKind: "omp",
      launch: { permissionMode: "always-ask" },
    });
    expect(session).toMatchObject({
      runtime: "omp-rpc",
      agentKind: "omp",
      surfaces: ["chat"],
      status: "idle",
      title: path.basename(workspace),
      subtitle: `Oh My Pi · ${path.basename(workspace)}`,
    });
    expect(session.id).toMatch(/^omp-[0-9a-f-]{36}$/u);
    expect(runsInTerminal(session)).toBe(false);
    expect(session.capabilities).toMatchObject({ send: true, approvals: true, questions: true, streaming: true, goal: false, fork: false, git: false });
    expect(claim).toHaveBeenCalledWith(session.id);
    expect(events).toEqual([{ type: "session.created", session }]);
    expect(await controller.listSessions()).toEqual([session]);
  });

  it("refuses an omp that is not installed, another agent, and a folder that is not there", async () => {
    const missing = setup({ installed: false });
    await expect(
      missing.controller.createSession({ runtime: "omp-rpc", workspace: missing.workspace, isolation: "workspace" }),
    ).rejects.toThrow("Oh My Pi: 설치되어 있지 않습니다");
    const { controller, workspace } = setup();
    await expect(controller.createSession({ runtime: "omp-rpc", workspace, isolation: "workspace", agentKind: "claude" })).rejects.toThrow(
      "An RPC chat runs omp",
    );
    await expect(controller.createSession({ runtime: "omp-rpc", workspace: path.join(workspace, "nope"), isolation: "workspace" })).rejects.toThrow(
      "Workspace must be an existing folder",
    );
  });

  it("renames and deletes, and reads the chat from omp's session file with the file's own ids", async () => {
    const { controller, workspace, store, events } = setup();
    const session = await controller.createSession({ runtime: "omp-rpc", workspace, isolation: "workspace", title: "chat" });
    await controller.renameSession(session.id, "renamed");
    expect(controller.sessionTitle(session.id)).toBe("renamed");
    expect(events.at(-1)).toMatchObject({ type: "session.updated", session: { title: "renamed" } });

    expect((await controller.getTranscriptPage(session.id)).items).toEqual([]);
    const file = path.join(workspace, "session.jsonl");
    copyFileSync(new URL("./fixtures/session-approval-parallel.jsonl", import.meta.url), file);
    store.reportSession(session.id, { sessionFile: file });
    const page = await controller.getTranscriptPage(session.id);
    expect(page.items.map((item) => `${item.kind}:${item.id.slice(session.id.length + 1)}`)).toEqual([
      expect.stringMatching(/^message:[0-9a-f]{8}$/u),
      "tool:call_b845f691543f4b94855c0463",
      "tool:call_903914bc123b4cc68899cb31",
      expect.stringMatching(/^message:[0-9a-f]{8}:0$/u),
    ]);
    expect(page.items[1]).toMatchObject({ kind: "tool", name: "bash", status: "completed" });
    expect(await controller.getTranscriptRevision(session.id)).toMatch(/session\.jsonl/u);
    expect(controller.sessionOfTool(`${session.id}:call_b845f691543f4b94855c0463`)).toBe(session.id);

    await controller.deleteSession(session.id);
    expect(events.at(-1)).toEqual({ type: "session.deleted", sessionId: session.id });
    expect(await controller.listSessions()).toEqual([]);
    expect(controller.sessionOfTool(`${session.id}:call_b845f691543f4b94855c0463`)).toBeUndefined();
  });

  it("names the session of a tool id only for its own ids", () => {
    expect(sessionOfOmpToolId("omp-0f8fad5b-d9cb-469f-a165-70867728950e:call_1")).toBe("omp-0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(sessionOfOmpToolId("terminal-0f8fad5b-d9cb-469f-a165-70867728950e:call_1")).toBeUndefined();
    expect(sessionOfOmpToolId("call_1")).toBeUndefined();
  });
});
