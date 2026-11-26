import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isOmpRpcSessionId, OmpRpcSessionStore } from "./session-store.js";

describe("OmpRpcSessionStore", () => {
  it("keeps chats newest first in a 0600 file that a new store reads back", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-store-"));
    const store = new OmpRpcSessionStore(directory, () => new Date("2026-11-25T01:00:00Z"));
    const first = store.create({ title: " first ", workspace: "/tmp/work" });
    const second = store.create({ title: "second", workspace: "/tmp/work/", launch: { permissionMode: "always-ask", model: "opencodex/x" } });
    expect(isOmpRpcSessionId(first.id)).toBe(true);
    expect(first).toMatchObject({ title: "first", workspace: "/tmp/work", createdAt: "2026-11-25T01:00:00.000Z" });
    expect(store.list().map((record) => record.id)).toEqual([second.id, first.id]);
    const file = path.join(directory, "omp-rpc-sessions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new OmpRpcSessionStore(directory).get(second.id)).toEqual(second);
  });

  it("keeps the worktree a chat was made in, and reads a damaged one as none", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-store-"));
    const store = new OmpRpcSessionStore(directory);
    const worktree = { sourceWorkspace: "/work/repo", path: "/work/repo.gajae-worktrees/a", branch: "peacock/a", managed: true as const, createdBranch: true };
    const made = store.create({ title: "in a worktree", workspace: worktree.path, worktree });
    const plain = store.create({ title: "plain", workspace: "/tmp/work" });
    expect(plain).not.toHaveProperty("worktree");
    expect(new OmpRpcSessionStore(directory).get(made.id)?.worktree).toEqual(worktree);
    const file = path.join(directory, "omp-rpc-sessions.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, unknown>[] };
    raw.sessions = raw.sessions.map((record) => (record.id === made.id ? { ...record, worktree: { ...worktree, managed: false } } : record));
    writeFileSync(file, JSON.stringify(raw));
    expect(new OmpRpcSessionStore(directory).get(made.id)).not.toHaveProperty("worktree");
  });

  it("records omp's session file and id, renames, touches and deletes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-store-"));
    const store = new OmpRpcSessionStore(directory, () => new Date("2026-11-25T02:00:00Z"));
    const record = store.create({ title: "chat", workspace: "/tmp/work" });
    expect(store.reportSession(record.id, { sessionFile: "/tmp/s/a.jsonl", ompSessionId: "01a2103a-b2a8-7412" })).toBe(true);
    expect(store.reportSession(record.id, { sessionFile: "/tmp/s/a.jsonl" })).toBe(false);
    // a relative path or an odd id is not taken
    expect(store.reportSession(record.id, { sessionFile: "rel.jsonl", ompSessionId: "bad id" })).toBe(false);
    store.rename(record.id, "renamed");
    store.touch(record.id);
    expect(store.get(record.id)).toMatchObject({
      title: "renamed",
      sessionFile: "/tmp/s/a.jsonl",
      ompSessionId: "01a2103a-b2a8-7412",
      updatedAt: "2026-11-25T02:00:00.000Z",
    });
    expect(() => store.rename(record.id, "  ")).toThrow("Session title cannot be empty");
    store.delete(record.id);
    expect(store.list()).toEqual([]);
  });

  it("refuses launch options omp does not take", () => {
    const store = new OmpRpcSessionStore(mkdtempSync(path.join(tmpdir(), "gajae-omp-store-")));
    expect(() => store.create({ title: "x", workspace: "/tmp", launch: { effort: "high" } })).toThrow("omp does not take effort");
  });

  it("drops records that are not well formed instead of failing to load", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-store-"));
    const good = { id: "omp-0f8fad5b-d9cb-469f-a165-70867728950e", title: "ok", workspace: "/tmp", createdAt: "2026-11-25T00:00:00Z", launch: { effort: "x" } };
    writeFileSync(
      path.join(directory, "omp-rpc-sessions.json"),
      JSON.stringify({ sessions: [good, { id: "terminal-1", title: "x", workspace: "/tmp", createdAt: "" }, { ...good, id: "omp-x" }, null] }),
    );
    const store = new OmpRpcSessionStore(directory);
    // the bad launch is dropped, the record kept
    expect(store.list()).toEqual([{ id: good.id, title: "ok", workspace: "/tmp", createdAt: good.createdAt }]);
    expect(JSON.parse(readFileSync(path.join(directory, "omp-rpc-sessions.json"), "utf8")).sessions).toHaveLength(4);
  });
});
