import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalSessionStore } from "./terminal-session-store.js";

const file = (directory: string) => path.join(directory, "terminal-sessions.json");

describe("TerminalSessionStore", () => {
  it("reads records from before herdr-core as shells and writes that back once", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-terminal-store-"));
    writeFileSync(
      file(directory),
      JSON.stringify({
        sessions: [{ id: "terminal-old", title: "빌드", workspace: "/tmp", createdAt: "2026-11-01T00:00:00.000Z" }],
      }),
    );
    const store = new TerminalSessionStore(directory);
    expect(store.list()).toEqual([
      { id: "terminal-old", title: "빌드", workspace: "/tmp", createdAt: "2026-11-01T00:00:00.000Z", agentKind: "shell" },
    ]);
    expect(JSON.parse(readFileSync(file(directory), "utf8")).sessions[0].agentKind).toBe("shell");
  });

  it("names new sessions shells and keeps where their shell runs across a restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-terminal-store-"));
    const store = new TerminalSessionStore(directory);
    const created = store.create({ title: "a", workspace: "/tmp" });
    expect(created.agentKind).toBe("shell");
    store.bindTerminal(created.id, { coreId: "c85563b5", terminalAddress: "t7" });
    expect(new TerminalSessionStore(directory).get(created.id)).toMatchObject({ coreId: "c85563b5", terminalAddress: "t7" });
    store.bindTerminal(created.id, undefined);
    const reread = new TerminalSessionStore(directory).get(created.id)!;
    expect(reread.coreId).toBeUndefined();
    expect(reread.terminalAddress).toBeUndefined();
  });

  it("drops a binding that is not one", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-terminal-store-"));
    writeFileSync(
      file(directory),
      JSON.stringify({
        sessions: [
          { id: "terminal-x", title: "x", workspace: "/tmp", createdAt: "2026-11-01T00:00:00.000Z", agentKind: "shell", coreId: "c1", terminalAddress: "t1; rm -rf /" },
          { id: "terminal-y", title: "y", workspace: "/tmp", createdAt: "2026-11-01T00:00:00.000Z", agentKind: "shell", coreId: "c1" },
        ],
      }),
    );
    const store = new TerminalSessionStore(directory);
    for (const record of store.list()) {
      expect(record.coreId).toBeUndefined();
      expect(record.terminalAddress).toBeUndefined();
    }
  });

  it("does not rewrite a file that needs no migration", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-terminal-store-"));
    const text = `${JSON.stringify({ sessions: [{ id: "terminal-z", title: "z", workspace: "/tmp", createdAt: "2026-11-01T00:00:00.000Z", agentKind: "shell" }] })}`;
    writeFileSync(file(directory), text);
    new TerminalSessionStore(directory);
    expect(readFileSync(file(directory), "utf8")).toBe(text);
  });
});
