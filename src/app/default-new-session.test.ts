import { describe, expect, it } from "vitest";
import { autoWorktreeBranch, defaultSessionInput } from "./default-new-session";

describe("autoWorktreeBranch", () => {
  it("is peacock/<time>-<salt>, a branch name git and the host accept", () => {
    const branch = autoWorktreeBranch(1_700_000_000_000, () => 0.5);
    expect(branch).toBe("peacock/loyw3v28-i000");
    expect(branch).toMatch(/^peacock\/[0-9a-z]+-[0-9a-z]{4}$/u);
  });

  it("differs between two starts in the same millisecond", () => {
    const first = autoWorktreeBranch(5, () => 0.1);
    const second = autoWorktreeBranch(5, () => 0.9);
    expect(first).not.toBe(second);
  });

  it("keeps the salt four characters long however small the draw", () => {
    expect(autoWorktreeBranch(1, () => 0)).toMatch(/-0000$/u);
    expect(autoWorktreeBranch(1, () => 0.999999999)).toMatch(/-[0-9a-z]{4}$/u);
  });
});

describe("defaultSessionInput", () => {
  const gjc = { agentKind: "gjc" as const, surface: "chat" as const };

  it("starts GJC in the folder as it is, as ⌘T always did", () => {
    expect(defaultSessionInput({ choice: gjc, workspace: "/work/repo" })).toEqual({ title: "새 세션", workspace: "/work/repo" });
  });

  it("starts a terminal agent with its launch defaults and screen", () => {
    expect(
      defaultSessionInput({
        choice: { agentKind: "claude", surface: "terminal" },
        workspace: "/work/repo",
        launch: { permissionMode: "plan" },
      }),
    ).toEqual({
      title: "새 세션",
      workspace: "/work/repo",
      kind: "terminal",
      agentKind: "claude",
      surface: "terminal",
      launch: { permissionMode: "plan" },
    });
  });

  it("names no agent for a shell", () => {
    const input = defaultSessionInput({ choice: { agentKind: "shell", surface: "terminal" }, workspace: "/work/repo" });
    expect(input).toEqual({ title: "새 세션", workspace: "/work/repo", kind: "terminal", surface: "terminal" });
  });

  it("makes the session in a new worktree of the project root, on an automatic branch, when the project asks", () => {
    expect(
      defaultSessionInput({ choice: gjc, workspace: "/work/repo.gajae-worktrees/a", worktreeRoot: "/work/repo", branch: () => "peacock/x-1" }),
    ).toEqual({ title: "새 세션", workspace: "/work/repo", isolation: "worktree", worktreeBranch: "peacock/x-1" });
    expect(
      defaultSessionInput({
        choice: { agentKind: "omp", surface: "chat" },
        workspace: "/work/repo/sub",
        worktreeRoot: "/work/repo",
        branch: () => "peacock/x-2",
      }),
    ).toEqual({
      title: "새 세션",
      workspace: "/work/repo",
      isolation: "worktree",
      worktreeBranch: "peacock/x-2",
      kind: "terminal",
      agentKind: "omp",
      surface: "chat",
    });
  });

  it("asks for a branch of its own each time", () => {
    const input = { choice: gjc, workspace: "/w", worktreeRoot: "/w" };
    expect(defaultSessionInput(input).worktreeBranch).not.toBe(defaultSessionInput(input).worktreeBranch);
  });
});
