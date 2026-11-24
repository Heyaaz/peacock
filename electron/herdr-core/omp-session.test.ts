import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newestOmpSession, ompBreadcrumb, ompSessionFolders, ompSessionHeader } from "./omp-session.js";

function home(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-omp-home-")));
}

const header = (id: string, cwd: string) =>
  `${JSON.stringify({ type: "title", v: 1, title: "t", source: "auto" })}\n${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-24T03:03:29.928Z", cwd })}\n`;

describe("omp session folders", () => {
  it("names a folder below home, below the temp dir, and anywhere else as omp does", () => {
    expect(ompSessionFolders("/Users/me/pro/moa", "/Users/me", "/var/tmp-x")).toContain("-pro-moa");
    expect(ompSessionFolders("/Users/me", "/Users/me", "/var/tmp-x")).toContain("-");
    expect(ompSessionFolders("/var/tmp-x/job", "/Users/me", "/var/tmp-x")).toContain("-tmp-job");
    expect(ompSessionFolders("/opt/work", "/Users/me", "/var/tmp-x")).toEqual(["--opt-work--"]);
  });
});

describe("omp session files", () => {
  it("reads the session header after a title line", async () => {
    const root = home();
    const file = path.join(root, "s.jsonl");
    writeFileSync(file, header("01abc", "/work/demo"));
    expect(await ompSessionHeader(file)).toEqual({ id: "01abc", cwd: "/work/demo", timestamp: "2026-11-24T03:03:29.928Z" });
    expect(await ompSessionHeader(path.join(root, "none.jsonl"))).toBeUndefined();
  });

  it("follows a fresh breadcrumb for its cwd, and no stale or foreign one", async () => {
    const root = home();
    const cwd = path.join(root, "pro");
    mkdirSync(cwd);
    const crumbs = path.join(root, ".omp", "agent", "terminal-sessions");
    mkdirSync(crumbs, { recursive: true });
    const session = path.join(root, ".omp", "agent", "sessions", "-pro", "2026_x.jsonl");
    writeFileSync(path.join(crumbs, "ttys009"), `${cwd}\n${session}\ncwdstat 1 2\n`);
    const tty = async () => "ttys009";
    expect(await ompBreadcrumb(42, { home: root, cwd, since: Date.now() - 5000, tty })).toBe(session);
    // written by an omp that ran on this terminal before ours started
    expect(await ompBreadcrumb(42, { home: root, cwd, since: Date.now() + 60_000, tty })).toBeUndefined();
    expect(await ompBreadcrumb(42, { home: root, cwd: root, since: Date.now() - 5000, tty })).toBeUndefined();
    writeFileSync(path.join(crumbs, "ttys009"), `${cwd}\n/etc/passwd.jsonl\n`);
    expect(await ompBreadcrumb(42, { home: root, cwd, since: Date.now() - 5000, tty })).toBeUndefined();
    expect(await ompBreadcrumb(42, { home: root, cwd, since: 0, tty: async () => undefined })).toBeUndefined();
  });

  it("finds the newest transcript of the cwd begun since the terminal started", async () => {
    const root = home();
    const cwd = path.join(root, "pro");
    mkdirSync(cwd);
    const store = path.join(root, ".omp", "agent", "sessions", "-pro");
    mkdirSync(store, { recursive: true });
    const older = path.join(store, "a.jsonl");
    const newer = path.join(store, "b.jsonl");
    const foreign = path.join(store, "c.jsonl");
    writeFileSync(older, header("id-a", cwd));
    writeFileSync(newer, header("id-b", cwd));
    writeFileSync(foreign, header("id-c", "/somewhere/else"));
    const now = Date.now() / 1000;
    utimesSync(older, now - 10, now - 10);
    utimesSync(newer, now, now);
    utimesSync(foreign, now + 5, now + 5);
    const since = Date.now() - 60_000;
    expect(await newestOmpSession(cwd, { home: root, since })).toEqual({ path: newer, id: "id-b" });
    expect(await newestOmpSession(cwd, { home: root, since, exclude: new Set([newer]) })).toEqual({ path: older, id: "id-a" });
    expect(await newestOmpSession(cwd, { home: root, since: Date.now() + 60_000 })).toBeUndefined();
  });
});
