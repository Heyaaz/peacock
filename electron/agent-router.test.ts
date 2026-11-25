import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, CreateSessionInput } from "../shared/agent-contract.js";
import {
  AgentUnsupportedError,
  type AgentRuntimeController,
  type FullAgentHost,
} from "./agent-host.js";
import { AgentRouter } from "./agent-router.js";
import { GjcSdkController } from "./gjc-sdk-controller.js";

const input = { text: "hello", images: [], files: [] };

/** Every call the router answers, with arguments a caller could pass. */
const CALLS: [keyof FullAgentHost, unknown[]][] = [
  ["getConnection", []],
  ["reconnect", []],
  ["listSessions", []],
  ["createSession", [{ workspace: "/repo", runtime: "gjc", isolation: "workspace" }]],
  ["renameSession", ["s1", "Title"]],
  ["sessionTitle", ["s1"]],
  ["hideSession", ["s1"]],
  ["deleteSession", ["s1", { stopHost: 42 }]],
  ["getTranscript", ["s1"]],
  ["getTranscriptPage", ["s1", { beforeId: "m1" }]],
  ["getTranscriptChanges", ["s1"]],
  ["getTranscriptRevision", ["s1"]],
  ["watchTranscripts", [["s1", "s2"]]],
  ["refreshSessionContext", ["s1"]],
  ["sendMessage", ["s1", input, { allowDestructive: true }]],
  ["cancelRun", ["s1"]],
  ["markSessionRead", ["s1"]],
  ["steerSession", ["s1", input, { echo: false }]],
  ["queueFollowUp", ["s1", input]],
  ["listQueuedMessages", ["s1"]],
  ["flushQueuedNow", ["s1"]],
  ["toolDecisionInfo", ["tool-1", "allow"]],
  ["resolveToolCall", ["tool-1", "reject"]],
  ["listPendingQuestions", ["s1"]],
  ["answerQuestion", ["s1", "gate-1", { selected: ["a"] }, "key-1"]],
  ["getGoal", ["s1"]],
  ["operateGoal", ["s1", "pause"]],
  ["endWorkflow", ["s1", "ralph"]],
  ["setSessionConfig", ["s1", "model", "x"]],
  ["cycleThinking", ["s1"]],
  ["refreshRuntimeState", ["s1"]],
  ["askSideQuestion", ["s1", "why?"]],
  ["suggestNextInput", ["s1"]],
  ["compactSession", ["s1"]],
  ["controlRetry", ["s1", "now"]],
  ["listSubagents", ["s1"]],
  ["listHistorySessions", []],
  ["openHistorySession", ["s1"]],
  ["resumeSession", ["s1"]],
  ["forkSession", [{ sourceSessionId: "s1", title: "fork" }]],
  ["sessionHostElsewhere", ["s1", { reuseUnchangedIndex: true }]],
  ["getDiff", ["s1"]],
  ["readArtifact", ["s1", "artifact-1"]],
  ["previewFile", ["s1", "/repo/out.txt"]],
  ["listWorkspaceFiles", ["s1"]],
  ["resolveWorkspaceFile", ["s1", "src/a.ts"]],
  ["getGitStatus", ["s1"]],
  ["stageFiles", ["s1", ["a.ts"]]],
  ["unstageFiles", ["s1", ["a.ts"]]],
  ["commitChanges", ["s1", "message"]],
  ["pushChanges", ["s1"]],
  ["dispose", []],
];

/** Router members that place calls rather than forward them. */
const ROUTING_MEMBERS = new Set([
  "constructor",
  "registerRuntime",
  "claimSession",
  "releaseSession",
  "runtimeOf",
  "controllerFor",
  "runtimeOfController",
  "adopt",
  "facet",
  "hiddenFromRemote",
  "sessionOfTool",
]);

type Mocked<T> = { [K in keyof T]: ReturnType<typeof vi.fn> };

function fakeHost(): FullAgentHost & Mocked<FullAgentHost> {
  const host: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const [name] of CALLS) host[name] = vi.fn(() => ({ answeredBy: "gjc", name }));
  return host as unknown as FullAgentHost & Mocked<FullAgentHost>;
}

const row = (id: string, runtime: AgentSession["runtime"] = "gjc"): AgentSession => ({
  id,
  title: id,
  subtitle: "",
  workspace: "/repo",
  runtime,
  status: "idle",
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#000000",
  ownership: "gajae",
  attachment: "attached",
});

/** A herdr stand-in with only the core calls, plus whatever a test adds. */
function fakeRuntime(
  extra: Partial<AgentRuntimeController> = {},
): AgentRuntimeController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getConnection: vi.fn(),
    reconnect: vi.fn(),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => row("h-new", "herdr")),
    renameSession: vi.fn(async () => undefined),
    sessionTitle: vi.fn(() => "herdr title"),
    hideSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    getTranscript: vi.fn(async () => []),
    getTranscriptPage: vi.fn(),
    getTranscriptChanges: vi.fn(),
    getTranscriptRevision: vi.fn(),
    watchTranscripts: vi.fn(),
    refreshSessionContext: vi.fn(),
    sendMessage: vi.fn(async () => ({ outcome: "sent" })),
    cancelRun: vi.fn(async () => undefined),
    markSessionRead: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...extra,
  } as unknown as AgentRuntimeController & Record<string, ReturnType<typeof vi.fn>>;
}

const herdrInput: CreateSessionInput = {
  workspace: "/repo",
  runtime: "herdr",
  isolation: "workspace",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentRouter with GJC alone", () => {
  it("forwards every call the GJC controller has and nothing else", () => {
    const forwarded = Object.getOwnPropertyNames(AgentRouter.prototype).filter(
      (name) => !ROUTING_MEMBERS.has(name),
    );
    expect(forwarded.sort()).toEqual(CALLS.map(([name]) => name).sort());
    const controller = GjcSdkController.prototype as unknown as Record<string, unknown>;
    for (const [name] of CALLS) expect(typeof controller[name]).toBe("function");
  });

  it.each(CALLS)("hands %s to GJC with the same arguments and returns its answer", (name, args) => {
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    const result = (router as unknown as Record<string, (...values: unknown[]) => unknown>)[name](
      ...args,
    );
    expect(gjc[name]).toHaveBeenCalledTimes(1);
    expect(gjc[name]).toHaveBeenCalledWith(...args);
    if (name === "hideSession" || name === "dispose") expect(result).toBeUndefined();
    // The very object GJC answered: nothing is wrapped, re-timed or copied.
    else expect(result).toBe(gjc[name].mock.results[0]!.value);
  });

  it("calls a GJC method with the controller as this", async () => {
    const seen: unknown[] = [];
    const gjc = fakeHost();
    gjc.getGoal.mockImplementation(function (this: unknown) {
      seen.push(this);
      return Promise.resolve({});
    });
    await new AgentRouter(gjc).getGoal("s1");
    expect(seen).toEqual([gjc]);
  });

  it("keeps sessions of every runtime but herdr on GJC, as before", async () => {
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    const mock = { ...herdrInput, runtime: "hermes" as const };
    router.createSession(mock);
    expect(gjc.createSession).toHaveBeenCalledWith(mock);
    expect(router.runtimeOf("anything")).toBe("gjc");
    expect(router.controllerFor("anything")).toBe(gjc);
  });

  it("refuses a herdr session while no herdr controller is registered", async () => {
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    await expect(router.createSession(herdrInput)).rejects.toBeInstanceOf(AgentUnsupportedError);
    expect(gjc.createSession).not.toHaveBeenCalled();
  });
});

describe("AgentRouter with a second runtime", () => {
  it("creates a herdr session on its controller and sends that session's calls there", async () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);

    await expect(router.createSession(herdrInput)).resolves.toMatchObject({ id: "h-new" });
    expect(router.runtimeOf("h-new")).toBe("herdr");

    await router.getTranscript("h-new");
    await router.sendMessage("h-new", input);
    expect(router.sessionTitle("h-new")).toBe("herdr title");
    expect(herdr.getTranscript).toHaveBeenCalledWith("h-new");
    expect(herdr.sendMessage).toHaveBeenCalledWith("h-new", input, undefined);
    expect(gjc.getTranscript).not.toHaveBeenCalled();
    expect(gjc.sendMessage).not.toHaveBeenCalled();

    router.getTranscript("g1");
    expect(gjc.getTranscript).toHaveBeenCalledWith("g1");
  });

  it("keeps herdr and omp chat sessions apart, each on its own controller (design §10)", async () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime();
    const ompRpc = fakeRuntime({ createSession: vi.fn(async () => ({ id: "omp-new" }) as AgentSession) } as unknown as Partial<AgentRuntimeController>);
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    router.registerRuntime("omp-rpc", ompRpc);

    await expect(
      router.createSession({ runtime: "omp-rpc", workspace: "/repo", isolation: "workspace", agentKind: "omp" }),
    ).resolves.toMatchObject({ id: "omp-new" });
    expect(router.runtimeOf("omp-new")).toBe("omp-rpc");
    await router.sendMessage("omp-new", input);
    expect(ompRpc.sendMessage).toHaveBeenCalledWith("omp-new", input, undefined);
    expect(herdr.sendMessage).not.toHaveBeenCalled();
    expect(gjc.sendMessage).not.toHaveBeenCalled();
    expect(router.sessionOfTool("omp-new:call_1")).toBe("omp-new");
  });

  it("refuses a facet the owner lacks as a rejected promise, not a throw", async () => {
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", fakeRuntime());
    router.claimSession("h1", "herdr");

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = router.getGoal("h1");
    }).not.toThrow();
    await expect(pending).rejects.toMatchObject({
      name: "AgentUnsupportedError",
      code: "unsupported",
      operation: "getGoal",
      sessionId: "h1",
    });
    await expect(router.compactSession("h1")).rejects.toBeInstanceOf(AgentUnsupportedError);
    await expect(router.forkSession({ sourceSessionId: "h1" })).rejects.toBeInstanceOf(
      AgentUnsupportedError,
    );
    expect(gjc.getGoal).not.toHaveBeenCalled();
    expect(gjc.compactSession).not.toHaveBeenCalled();
    expect(gjc.forkSession).not.toHaveBeenCalled();
  });

  it("uses a facet the owner has, bound to the owner", async () => {
    const seen: unknown[] = [];
    const getGitStatus = vi.fn(function (this: unknown) {
      seen.push(this);
      return Promise.resolve({ branch: "main" });
    });
    const herdr = fakeRuntime({ getGitStatus } as unknown as Partial<AgentRuntimeController>);
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    router.claimSession("h1", "herdr");
    await expect(router.getGitStatus("h1")).resolves.toEqual({ branch: "main" });
    expect(getGitStatus).toHaveBeenCalledWith("h1");
    expect(seen).toEqual([herdr]);
    expect(gjc.getGitStatus).not.toHaveBeenCalled();
  });

  it("reports no other holder when the owner cannot tell", async () => {
    const gjc = fakeHost();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", fakeRuntime());
    router.claimSession("h1", "herdr");
    await expect(router.sessionHostElsewhere("h1")).resolves.toBeUndefined();
    expect(gjc.sessionHostElsewhere).not.toHaveBeenCalled();
  });

  it("lists every runtime's sessions and claims the other runtime's rows", async () => {
    const gjc = fakeHost();
    gjc.listSessions.mockResolvedValue([row("g1")]);
    const herdr = fakeRuntime({ listSessions: vi.fn(async () => [row("h1", "herdr")]) });
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    const sessions = await router.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["g1", "h1"]);
    expect(router.runtimeOf("h1")).toBe("herdr");
    expect(router.runtimeOf("g1")).toBe("gjc");
  });

  it("keeps GJC's rows when another runtime cannot list, and fails with GJC", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gjc = fakeHost();
    gjc.listSessions.mockResolvedValue([row("g1")]);
    const herdr = fakeRuntime({
      listSessions: vi.fn(async () => {
        throw new Error("core is down");
      }),
    });
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    await expect(router.listSessions()).resolves.toEqual([row("g1")]);

    gjc.listSessions.mockRejectedValue(new Error("broker is down"));
    await expect(router.listSessions()).rejects.toThrow("broker is down");
  });

  it("tells every controller which of its own transcripts are watched", () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    router.claimSession("h1", "herdr");

    router.watchTranscripts(["g1", "h1", "g2"]);
    expect(gjc.watchTranscripts).toHaveBeenLastCalledWith(["g1", "g2"]);
    expect(herdr.watchTranscripts).toHaveBeenLastCalledWith(["h1"]);

    router.watchTranscripts([]);
    expect(gjc.watchTranscripts).toHaveBeenLastCalledWith([]);
    expect(herdr.watchTranscripts).toHaveBeenLastCalledWith([]);
  });

  it("forgets the owner of a deleted or hidden session", async () => {
    const herdr = fakeRuntime();
    const router = new AgentRouter(fakeHost());
    router.registerRuntime("herdr", herdr);
    router.claimSession("h1", "herdr");
    router.claimSession("h2", "herdr");

    await router.deleteSession("h1");
    router.hideSession("h2");
    expect(herdr.deleteSession).toHaveBeenCalledWith("h1", undefined);
    expect(herdr.hideSession).toHaveBeenCalledWith("h2");
    expect(router.runtimeOf("h1")).toBe("gjc");
    expect(router.runtimeOf("h2")).toBe("gjc");
  });

  it("keeps the owner when a delete fails", async () => {
    const herdr = fakeRuntime({
      deleteSession: vi.fn(async () => {
        throw new Error("still running");
      }),
    });
    const router = new AgentRouter(fakeHost());
    router.registerRuntime("herdr", herdr);
    router.claimSession("h1", "herdr");
    await expect(router.deleteSession("h1")).rejects.toThrow("still running");
    expect(router.runtimeOf("h1")).toBe("herdr");
  });

  it("claims a session forked or reopened from the runtime's own session", async () => {
    const herdr = fakeRuntime({
      forkSession: vi.fn(async () => row("h2", "herdr")),
      resumeSession: vi.fn(async () => row("h3", "herdr")),
    });
    const router = new AgentRouter(fakeHost());
    router.registerRuntime("herdr", herdr);
    router.claimSession("h1", "herdr");
    await router.forkSession({ sourceSessionId: "h1" });
    await router.resumeSession("h1");
    expect(router.runtimeOf("h2")).toBe("herdr");
    expect(router.runtimeOf("h3")).toBe("herdr");
  });

  it("takes a runtime back with its sessions, and refuses a second controller", () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime();
    const router = new AgentRouter(gjc);
    const unregister = router.registerRuntime("herdr", herdr);
    expect(() => router.registerRuntime("herdr", fakeRuntime())).toThrow("already has a controller");
    router.claimSession("h1", "herdr");
    expect(router.controllerFor("h1")).toBe(herdr);

    unregister();
    expect(router.runtimeOf("h1")).toBe("gjc");
    expect(router.controllerFor("h1")).toBe(gjc);
    expect(() => router.claimSession("h1", "herdr")).toThrow("has no controller");
  });

  it("takes a tool decision to the runtime whose session the tool id names, and GJC's own ids to GJC", async () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime({
      toolDecisionInfo: vi.fn(() => ({ name: "이번만 허용", requiresConfirmation: true })),
      resolveToolCall: vi.fn(async () => undefined),
    });
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    router.claimSession("terminal-1", "herdr");
    const decision = { optionId: "allow_once" };
    expect(router.sessionOfTool("terminal-1:toolu_9")).toBe("terminal-1");
    expect(router.sessionOfTool("terminal-1/approval-2")).toBe("terminal-1");
    expect(router.sessionOfTool("toolu_9")).toBeUndefined();
    expect(router.toolDecisionInfo("terminal-1:toolu_9", decision)).toEqual({ name: "이번만 허용", requiresConfirmation: true });
    await router.resolveToolCall("terminal-1:toolu_9", decision);
    expect(herdr.resolveToolCall).toHaveBeenCalledWith("terminal-1:toolu_9", decision);
    await router.resolveToolCall("toolu_9", decision);
    expect(gjc.resolveToolCall).toHaveBeenCalledWith("toolu_9", decision);
    expect(herdr.resolveToolCall).toHaveBeenCalledTimes(1);
  });

  it("asks a runtime for a tool id of a session it has not listed yet", () => {
    const herdr = fakeRuntime({ sessionOfTool: vi.fn((toolId: string) => (toolId.startsWith("terminal-9:") ? "terminal-9" : undefined)) });
    const router = new AgentRouter(fakeHost());
    router.registerRuntime("herdr", herdr);
    expect(router.sessionOfTool("terminal-9:call_1")).toBe("terminal-9");
  });

  it("shuts every controller down once", () => {
    const gjc = fakeHost();
    const herdr = fakeRuntime();
    const router = new AgentRouter(gjc);
    router.registerRuntime("herdr", herdr);
    router.dispose();
    router.dispose();
    expect(gjc.dispose).toHaveBeenCalledTimes(1);
    expect(herdr.dispose).toHaveBeenCalledTimes(1);
  });
});
