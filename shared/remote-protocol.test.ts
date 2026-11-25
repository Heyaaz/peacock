import { describe, expect, it } from "vitest";
import { runsInTerminal, type AgentSession } from "./agent-contract.js";
import { toRemoteEvent, toRemoteSession } from "./remote-protocol.js";

const row = (overrides: Partial<AgentSession>): AgentSession => ({
  id: "s",
  title: "t",
  subtitle: "",
  workspace: "/w",
  runtime: "gjc",
  status: "idle",
  updatedAt: "now",
  pinned: false,
  unread: false,
  accent: "#000",
  ownership: "gajae",
  attachment: "attached",
  ...overrides,
});

/** runsInTerminal as PWAs before omp's RPC chat had it: every agent other than GJC in a terminal. */
const olderRunsInTerminal = (session: Pick<AgentSession, "runtime" | "agentKind">) =>
  session.runtime === "herdr" || (session.runtime as string) === "terminal" || (session.agentKind !== undefined && session.agentKind !== "gjc");

describe("remote wire names", () => {
  it("keeps the pre-P5 name for terminal sessions", () => {
    expect(toRemoteSession(row({ runtime: "herdr", agentKind: "claude" })).runtime).toBe("terminal");
    expect(toRemoteEvent({ type: "session.updated", session: row({ runtime: "herdr" }) })).toMatchObject({ session: { runtime: "terminal" } });
  });

  it("keeps an omp RPC chat's own name: an older PWA shows it as omp's chat, a newer one as a conversation (design §10)", () => {
    const chat = row({ runtime: "omp-rpc", agentKind: "omp", surfaces: ["chat"] });
    const wire = toRemoteSession(chat);
    expect(wire.runtime).toBe("omp-rpc");
    // an older PWA takes it as the agent's chat on a device with no terminal
    expect(olderRunsInTerminal(wire)).toBe(true);
    // this build takes it as a conversation the app drives
    expect(runsInTerminal(wire)).toBe(false);
  });
});
