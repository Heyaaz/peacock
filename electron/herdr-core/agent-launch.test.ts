import { describe, expect, it } from "vitest";
import type { TerminalSessionRecord } from "../../shared/terminal-ipc.js";
import { planAgentLaunch, type LaunchDependencies } from "./agent-launch.js";

const record = (extra: Partial<TerminalSessionRecord>): TerminalSessionRecord => ({
  id: "terminal-1",
  title: "a",
  workspace: "/w",
  createdAt: "2026-11-24T00:00:00.000Z",
  ...extra,
});

const deps = (extra: Partial<LaunchDependencies> = {}): LaunchDependencies => ({
  detect: async (id) => ({ id, name: id, installed: true, binary: `/bin/${id}` }),
  claudeSettingsPath: "/data/agent-hooks/claude-settings.json",
  home: "/home/me",
  shell: () => ({ file: "/bin/zsh", args: ["-l"] }),
  exists: async () => false,
  newRef: () => "11111111-2222-3333-4444-555555555555",
  ...extra,
});

describe("planAgentLaunch", () => {
  it("runs the login shell for a shell session", async () => {
    expect(await planAgentLaunch(record({ agentKind: "shell" }), deps())).toEqual({ argv: ["/bin/zsh", "-l"] });
  });

  it("starts Claude Code on a session id Gajae chose, with its hooks and launch options", async () => {
    expect(await planAgentLaunch(record({ agentKind: "claude", launch: { model: "haiku" } }), deps())).toEqual({
      argv: [
        "/bin/claude",
        "--session-id", "11111111-2222-3333-4444-555555555555",
        "--settings", "/data/agent-hooks/claude-settings.json",
        "--model", "haiku",
      ],
      env: { GAJAE_SESSION_ID: "terminal-1" },
      agentSessionRef: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("resumes the session whose transcript exists, and starts it fresh when it does not", async () => {
    const known = record({ agentKind: "claude", agentSessionRef: "abc" });
    const checked: string[] = [];
    const resumed = await planAgentLaunch(known, deps({ exists: async (file) => (checked.push(file), true) }));
    expect(resumed.argv.slice(1, 3)).toEqual(["--resume", "abc"]);
    expect(checked).toEqual(["/home/me/.claude/projects/-w/abc.jsonl"]);
    const fresh = await planAgentLaunch(known, deps());
    expect(fresh.argv.slice(1, 3)).toEqual(["--session-id", "abc"]);
  });

  it("starts omp and codex without hooks", async () => {
    expect(await planAgentLaunch(record({ agentKind: "codex", launch: { effort: "high" } }), deps())).toEqual({
      argv: ["/bin/codex", "-c", 'model_reasoning_effort="high"'],
      env: { GAJAE_SESSION_ID: "terminal-1" },
    });
    expect((await planAgentLaunch(record({ agentKind: "omp" }), deps())).argv).toEqual(["/bin/omp"]);
  });

  it("refuses an agent that is not installed, and GJC in a terminal", async () => {
    await expect(
      planAgentLaunch(record({ agentKind: "codex" }), deps({ detect: async (id) => ({ id, name: "Codex", installed: false, reason: "설치되어 있지 않습니다" }) })),
    ).rejects.toThrow("Codex: 설치되어 있지 않습니다");
    await expect(planAgentLaunch(record({ agentKind: "gjc" }), deps())).rejects.toThrow(/chat/u);
  });
});
