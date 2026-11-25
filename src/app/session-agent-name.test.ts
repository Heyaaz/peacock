import { describe, expect, it } from "vitest";
import { sessionAgentName } from "./shell-model";

describe("sessionAgentName", () => {
  it("names the agent a session talks to, from its runtime when it names none", () => {
    expect(sessionAgentName({ runtime: "gjc" })).toBe("GJC");
    expect(sessionAgentName({ runtime: "omp-rpc" })).toBe("Oh My Pi");
    expect(sessionAgentName({ runtime: "omp-rpc", agentKind: "omp" })).toBe("Oh My Pi");
    expect(sessionAgentName({ runtime: "herdr", agentKind: "claude" })).toBe("Claude Code");
    expect(sessionAgentName({ runtime: "herdr", agentKind: "codex" })).toBe("Codex");
    expect(sessionAgentName({ runtime: "hermes" })).toBe("Hermes");
  });
});
