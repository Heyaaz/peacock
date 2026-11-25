import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  developmentUserData,
  legacyAppPid,
  migrateUserData,
  MIGRATION_MARKER,
  type UserDataMigration,
} from "./user-data-migration.js";

const roots: string[] = [];
function appData(): string {
  const root = mkdtempSync(path.join(tmpdir(), "peacock-migration-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  // the unreadable fixture must be readable again before its folder can go
  for (const root of roots.splice(0)) {
    const locked = path.join(root, "Agent Control", "artifacts", "locked.bin");
    if (existsSync(locked)) chmodSync(locked, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

function put(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** An old data folder as Gajae left it, with what must travel and what must not. */
function legacyFolder(root: string): string {
  const legacy = path.join(root, "Agent Control");
  put(path.join(legacy, "agent-control-settings.json"), '{"language":"ko"}\n');
  put(path.join(legacy, "agent-control-sessions.json"), '{"sessions":{"a":{"title":"x"}}}\n');
  put(path.join(legacy, "terminal-sessions.json"), "[]\n");
  put(path.join(legacy, "omp-rpc-sessions.json"), "[]\n");
  put(path.join(legacy, "agent-hooks", "token"), "f".repeat(64) + "\n");
  put(path.join(legacy, "agent-hooks", "relay.sh"), "#!/bin/sh\n");
  put(path.join(legacy, "productivity.sqlite"), Buffer.from([0, 1, 2, 3, 255]));
  put(path.join(legacy, "productivity.sqlite-wal"), Buffer.alloc(4096, 7));
  put(path.join(legacy, "Local Storage", "leveldb", "000003.log"), "gajae:thoughts=1");
  put(path.join(legacy, "artifacts", "s1", "shot.png"), Buffer.alloc(10_000, 1));
  put(path.join(legacy, "Cache", "Cache_Data", "data_0"), "cache");
  put(path.join(legacy, "Code Cache", "js", "index"), "cache");
  put(path.join(legacy, "GPUCache", "data_1"), "cache");
  put(path.join(legacy, "DawnGraphiteCache", "data_0"), "cache");
  put(path.join(legacy, "bin", "herdr-core", "hc"), "binary");
  put(path.join(legacy, "DevToolsActivePort"), "9222");
  symlinkSync("my-mac.local-999999", path.join(legacy, "SingletonLock"));
  symlinkSync("shot.png", path.join(legacy, "artifacts", "s1", "latest.png"));
  return legacy;
}

const notRunning = () => false;

describe("userData migration", () => {
  it("copies the old folder into Peacock once, verified, and keeps the old one as it was", () => {
    const root = appData();
    const legacy = legacyFolder(root);
    const before = readdirSync(legacy).sort();
    const result = migrateUserData({ appData: root, isLegacyApp: notRunning, now: () => new Date("2026-11-25T10:00:00Z") });
    const target = path.join(root, "Peacock");
    expect(result).toMatchObject({ kind: "migrated", userData: target, legacy });
    for (const name of [
      "agent-control-settings.json",
      "agent-control-sessions.json",
      "terminal-sessions.json",
      path.join("agent-hooks", "token"),
      "productivity.sqlite",
      "productivity.sqlite-wal",
      path.join("Local Storage", "leveldb", "000003.log"),
      path.join("artifacts", "s1", "shot.png"),
    ])
      expect(readFileSync(path.join(target, name))).toEqual(readFileSync(path.join(legacy, name)));
    expect(readlinkSync(path.join(target, "artifacts", "s1", "latest.png"))).toBe("shot.png");
    // locks, caches and the reinstalled hc stay behind
    for (const name of ["SingletonLock", "DevToolsActivePort", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "bin"])
      expect(existsSync(path.join(target, name))).toBe(false);
    const marker = JSON.parse(readFileSync(path.join(target, MIGRATION_MARKER), "utf8"));
    expect(marker).toMatchObject({ from: legacy, files: (result as Extract<UserDataMigration, { kind: "migrated" }>).files });
    // nothing was taken from the old folder
    expect(readdirSync(legacy).sort()).toEqual(before);
    expect(readFileSync(path.join(legacy, "agent-control-settings.json"), "utf8")).toBe('{"language":"ko"}\n');
    expect(readdirSync(root).sort()).toEqual(["Agent Control", "Peacock"]);
  });

  it("runs once: a second launch keeps the new folder even when the old one changed since", () => {
    const root = appData();
    const legacy = legacyFolder(root);
    migrateUserData({ appData: root, isLegacyApp: notRunning });
    put(path.join(legacy, "agent-control-settings.json"), '{"language":"en"}\n');
    expect(migrateUserData({ appData: root, isLegacyApp: notRunning })).toEqual({ kind: "current", userData: path.join(root, "Peacock") });
    expect(readFileSync(path.join(root, "Peacock", "agent-control-settings.json"), "utf8")).toBe('{"language":"ko"}\n');
  });

  it("starts fresh, creating nothing, when there is no old data", () => {
    const root = appData();
    expect(migrateUserData({ appData: root, isLegacyApp: notRunning })).toEqual({ kind: "fresh", userData: path.join(root, "Peacock") });
    expect(readdirSync(root)).toEqual([]);
  });

  it("copies nothing while the old app runs, and says which process holds the folder", () => {
    const root = appData();
    const legacy = legacyFolder(root);
    const result = migrateUserData({ appData: root, isLegacyApp: (pid) => pid === 999999 });
    expect(result).toEqual({ kind: "legacy-running", legacy, pid: 999999 });
    expect(existsSync(path.join(root, "Peacock"))).toBe(false);
  });

  it("sets an empty profile in the way aside instead of merging into it", () => {
    const root = appData();
    legacyFolder(root);
    put(path.join(root, "Peacock", "Local State"), "{}");
    const result = migrateUserData({ appData: root, isLegacyApp: notRunning, now: () => new Date("2026-11-25T10:00:00Z") });
    expect(result.kind).toBe("migrated");
    const aside = readdirSync(root).find((name) => name.startsWith("Peacock.pre-migration-"));
    expect(aside).toBeDefined();
    expect(readFileSync(path.join(root, aside!, "Local State"), "utf8")).toBe("{}");
    expect(existsSync(path.join(root, "Peacock", "agent-control-settings.json"))).toBe(true);
  });

  it("falls back to the old folder when the copy fails, keeping the partial copy and deleting nothing", () => {
    const root = appData();
    const legacy = legacyFolder(root);
    put(path.join(legacy, "artifacts", "locked.bin"), "secret");
    chmodSync(path.join(legacy, "artifacts", "locked.bin"), 0o000);
    const result = migrateUserData({ appData: root, isLegacyApp: notRunning });
    expect(result).toMatchObject({ kind: "failed", userData: legacy });
    expect(existsSync(path.join(root, "Peacock"))).toBe(false);
    const kept = (result as Extract<UserDataMigration, { kind: "failed" }>).kept!;
    expect(path.basename(kept)).toMatch(/^Peacock\.failed-/u);
    expect(existsSync(path.join(legacy, "agent-control-settings.json"))).toBe(true);
  });
});

describe("legacyAppPid", () => {
  it("reads the pid from the lock and asks whether it is the old app", () => {
    const root = appData();
    mkdirSync(path.join(root, "x"));
    expect(legacyAppPid(path.join(root, "x"), () => true)).toBeUndefined();
    symlinkSync("meong-MacBookPro.local-731", path.join(root, "x", "SingletonLock"));
    expect(legacyAppPid(path.join(root, "x"), (pid) => pid === 731)).toBe(731);
    expect(legacyAppPid(path.join(root, "x"), () => false)).toBeUndefined();
  });
});

describe("developmentUserData", () => {
  it("uses the old folder until the new one holds the app's data, copying nothing", () => {
    const root = appData();
    expect(developmentUserData(root)).toBe(path.join(root, "Peacock"));
    legacyFolder(root);
    expect(developmentUserData(root)).toBe(path.join(root, "Agent Control"));
    put(path.join(root, "Peacock", "agent-control-settings.json"), "{}");
    expect(developmentUserData(root)).toBe(path.join(root, "Peacock"));
  });
});
