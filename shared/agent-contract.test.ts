import { describe, expect, it } from "vitest";
import {
  AGENT_KIND_IDS,
  capabilitiesOf,
  isAgentKindId,
  normalizeRuntimeKind,
  runsInTerminal,
  SESSION_CAPABILITY_KEYS,
  type AgentSession,
  type RuntimeKind,
  type SessionCapabilities,
} from "./agent-contract.js";

const every = (value: boolean): SessionCapabilities =>
  Object.fromEntries(
    SESSION_CAPABILITY_KEYS.map((key) => [key, value]),
  ) as unknown as SessionCapabilities;

/** A GJC chat's default: everything it had before capabilities existed, nothing that came later. */
const gjcChat = (): SessionCapabilities => ({ ...every(true), contextBreakdown: false, subagentControl: false, queueEdit: false, runtimeModes: false });

const session = (
  runtime: RuntimeKind,
  capabilities?: AgentSession["capabilities"],
): Pick<AgentSession, "runtime" | "capabilities"> => ({
  runtime,
  ...(capabilities === undefined ? {} : { capabilities }),
});

describe("session capability keys", () => {
  it("names each item the design lists, once", () => {
    expect([...SESSION_CAPABILITY_KEYS].sort()).toEqual(
      [
        "send",
        "cancel",
        "approvals",
        "questions",
        "goal",
        "compact",
        "sideQuestion",
        "suggestion",
        "modelConfig",
        "thinking",
        "fork",
        "git",
        "attachments",
        "streaming",
        "contextBreakdown",
        "subagentControl",
        "queueEdit",
        "runtimeModes",
      ].sort(),
    );
  });
});

describe("capabilitiesOf runtime defaults", () => {
  it("keeps every feature a GJC chat had before capabilities existed", () => {
    expect(capabilitiesOf(session("gjc"))).toEqual(gjcChat());
  });

  it("treats the mock backend's rows like the GJC chat they stand in for", () => {
    expect(capabilitiesOf(session("hermes"))).toEqual(gjcChat());
  });

  it("offers nothing to a terminal session of an older host (runtime `terminal`), and reads its name as herdr", () => {
    expect(capabilitiesOf(session("terminal" as never))).toEqual(every(false));
    expect(normalizeRuntimeKind("terminal")).toBe("herdr");
    expect(normalizeRuntimeKind("gjc")).toBe("gjc");
    expect(normalizeRuntimeKind("other")).toBeUndefined();
    expect(normalizeRuntimeKind("omp-rpc")).toBe("omp-rpc");
  });

  it("tells a terminal session from a GJC conversation by its runtime or its agent", () => {
    expect(runsInTerminal({ runtime: "herdr" })).toBe(true);
    expect(runsInTerminal({ runtime: "terminal" as never })).toBe(true);
    expect(runsInTerminal({ runtime: "gjc", agentKind: "claude" })).toBe(true);
    expect(runsInTerminal({ runtime: "gjc" })).toBe(false);
    expect(runsInTerminal({ runtime: "gjc", agentKind: "gjc" })).toBe(false);
    // an omp RPC chat is a conversation the app drives, though its agent is omp (design §10)
    expect(runsInTerminal({ runtime: "omp-rpc", agentKind: "omp" })).toBe(false);
    expect(runsInTerminal({ runtime: "herdr", agentKind: "omp" })).toBe(true);
  });

  it("assumes nothing for a herdr session that reports nothing", () => {
    expect(capabilitiesOf(session("herdr"))).toEqual(every(false));
  });

  it("offers nothing on a runtime this build does not know", () => {
    expect(
      capabilitiesOf({ runtime: "future" as RuntimeKind }),
    ).toEqual(every(false));
  });
});

describe("capabilitiesOf reported values", () => {
  it("lays each reported value over the runtime default", () => {
    expect(
      capabilitiesOf(session("herdr", { send: true, cancel: true, git: true })),
    ).toEqual({ ...every(false), send: true, cancel: true, git: true });
    expect(
      capabilitiesOf(session("gjc", { attachments: false, streaming: false })),
    ).toEqual({ ...gjcChat(), attachments: false, streaming: false });
  });

  it("ignores values that are not booleans and keys it does not know", () => {
    const reported = {
      send: "yes",
      cancel: 1,
      approvals: null,
      unknownFeature: true,
    } as unknown as AgentSession["capabilities"];
    const result = capabilitiesOf(session("herdr", reported));
    expect(result).toEqual(every(false));
    expect(Object.keys(result).sort()).toEqual([...SESSION_CAPABILITY_KEYS].sort());
  });

  it("falls back to the default when the reported value is not an object", () => {
    for (const reported of [null, "all", 7, [true]])
      expect(
        capabilitiesOf(
          session("gjc", reported as unknown as AgentSession["capabilities"]),
        ),
      ).toEqual(gjcChat());
  });

  it("returns a fresh object the caller may change", () => {
    const first = capabilitiesOf(session("gjc"));
    first.send = false;
    expect(capabilitiesOf(session("gjc")).send).toBe(true);
  });
});

describe("agent kinds", () => {
  it("lists the agents the design names", () => {
    expect([...AGENT_KIND_IDS]).toEqual(["claude", "omp", "codex", "gjc", "shell"]);
  });

  it("recognizes only those names", () => {
    for (const id of AGENT_KIND_IDS) expect(isAgentKindId(id)).toBe(true);
    for (const value of ["", "Claude", "hermes", "terminal", undefined, 3, {}])
      expect(isAgentKindId(value)).toBe(false);
  });
});
