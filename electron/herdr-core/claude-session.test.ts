import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectDirectory, claudeSessionOfPid, claudeTranscriptPath } from "./claude-session.js";

describe("Claude Code sessions", () => {
  it("names the project folder after the real path, every non-alphanumeric as -", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "gajae-cc-"));
    const expected = realpathSync(folder).replace(/[^A-Za-z0-9]/gu, "-");
    expect(claudeProjectDirectory(folder, "/home/me")).toBe(path.join("/home/me", ".claude", "projects", expected));
    expect(claudeTranscriptPath("/gone/a.b", "41fe", "/home/me")).toBe("/home/me/.claude/projects/-gone-a-b/41fe.jsonl");
  });

  it("reads the session a running Claude Code is in from its pid file", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gajae-cc-home-"));
    mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "a5a6-ffa2", cwd: "/w" }));
    writeFileSync(path.join(home, ".claude", "sessions", "4343.json"), JSON.stringify({ pid: 1, sessionId: "x" }));
    await expect(claudeSessionOfPid(4242, home)).resolves.toEqual({ sessionId: "a5a6-ffa2", cwd: "/w" });
    await expect(claudeSessionOfPid(4343, home)).resolves.toBeUndefined();
    await expect(claudeSessionOfPid(9999, home)).resolves.toBeUndefined();
    await expect(claudeSessionOfPid(-1, home)).resolves.toBeUndefined();
  });
});
