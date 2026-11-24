import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentDetector, parseAgentVersion } from "./agent-detect.js";

function fakeBin(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

describe("AgentDetector", () => {
  it("finds an agent on PATH first, as an absolute path, with its version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-detect-"));
    const onPath = fakeBin(path.join(root, "path"), "claude");
    fakeBin(path.join(root, "home", ".local", "bin"), "claude");
    const version = vi.fn(async () => "2.1.331 (Claude Code)\n");
    const detector = new AgentDetector({ searchPath: async () => ["relative/bin", path.join(root, "path")], home: path.join(root, "home"), version });
    expect(await detector.detect("claude")).toEqual({ id: "claude", name: "Claude Code", installed: true, binary: onPath, version: "2.1.331" });
  });

  it("falls back to where the installer puts it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-detect-"));
    const installed = fakeBin(path.join(root, "home", ".local", "bin"), "omp");
    const detector = new AgentDetector({ searchPath: async () => [path.join(root, "empty")], home: path.join(root, "home"), version: async () => "omp v19.1.1" });
    expect(await detector.detect("omp")).toMatchObject({ installed: true, binary: installed, version: "19.1.1" });
  });

  it("says why an agent cannot start: missing, or a version flag that fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-detect-"));
    const detector = new AgentDetector({ searchPath: async () => [path.join(root, "bin")], home: root, version: async () => null });
    expect(await detector.detect("codex")).toMatchObject({ installed: false, reason: expect.any(String) });
    fakeBin(path.join(root, "bin"), "codex");
    expect(await detector.detect("codex")).toMatchObject({ installed: false, binary: path.join(root, "bin", "codex") });
  });

  it("asks a version once per executable until it changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-detect-"));
    fakeBin(path.join(root, "bin"), "claude");
    const version = vi.fn(async () => "2.1.331");
    const detector = new AgentDetector({ searchPath: async () => [path.join(root, "bin")], home: root, version });
    await detector.detect("claude");
    await detector.detect("claude");
    expect(version).toHaveBeenCalledTimes(1);
  });

  it("uses the executable the settings name over every search, and says when it cannot run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-detect-"));
    fakeBin(path.join(root, "bin"), "claude");
    const chosen = fakeBin(path.join(root, "elsewhere"), "claude-nightly");
    const settings: Record<string, string> = { claude: chosen };
    const detector = new AgentDetector({ searchPath: async () => [path.join(root, "bin")], home: root, version: async () => "2.2.0", executableOf: (id) => settings[id] });
    expect(await detector.detect("claude")).toEqual({ id: "claude", name: "Claude Code", installed: true, binary: chosen, configured: true, version: "2.2.0" });
    settings.claude = path.join(root, "missing", "claude");
    expect(await detector.detect("claude")).toMatchObject({ installed: false, configured: true, binary: settings.claude, reason: expect.any(String) });
    settings.claude = "claude";
    expect(await detector.detect("claude")).toMatchObject({ installed: false, configured: true });
  });

  it("always offers the shell", async () => {
    const detector = new AgentDetector({ searchPath: async () => [], home: "/nowhere", version: async () => null });
    expect(await detector.detect("shell")).toEqual({ id: "shell", name: "Shell", installed: true });
    expect((await detector.list()).map((agent) => agent.id)).toEqual(["claude", "omp", "codex", "gjc", "shell"]);
  });

  it("reads versions the way the CLIs print them", () => {
    expect(parseAgentVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseAgentVersion("omp/18.8.7")).toBe("18.8.7");
    expect(parseAgentVersion("no version")).toBeUndefined();
  });
});
