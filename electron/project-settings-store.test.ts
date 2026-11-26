import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectSettingsStore } from "./project-settings-store.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gajae-project-settings-"));
});

afterEach(async () => {
  await chmod(directory, 0o700);
  await rm(directory, { recursive: true, force: true });
});

const identity = async (projectPath: string) => projectPath;
const file = () => path.join(directory, "project-settings.json");
const SETTINGS = { newSessionWorktree: true, setupScript: "npm ci", copyFiles: [".env", "config/local.json"] };

describe("ProjectSettingsStore", () => {
  it("answers the defaults for a project that has none", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    expect(await store.get("/repo")).toEqual({ newSessionWorktree: false, setupScript: "", copyFiles: [] });
    expect(store.list()).toEqual([]);
  });

  it("keeps settings across a reload", async () => {
    await new ProjectSettingsStore(directory, identity).set("/repo", SETTINGS);
    const reloaded = new ProjectSettingsStore(directory, identity);
    expect(await reloaded.get("/repo")).toEqual(SETTINGS);
    expect(reloaded.list()).toEqual([{ root: "/repo", settings: SETTINGS }]);
  });

  it("writes a private file", async () => {
    await new ProjectSettingsStore(directory, identity).set("/repo", SETTINGS);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it("normalizes what it saves", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    const saved = await store.set("/repo", {
      newSessionWorktree: false,
      setupScript: "  make setup\n\n",
      copyFiles: ["./.env", ".env", " config//local.json "],
    });
    expect(saved).toEqual({ newSessionWorktree: false, setupScript: "make setup", copyFiles: [".env", "config/local.json"] });
    expect(await store.get("/repo")).toEqual(saved);
  });

  it("scopes settings to the project root the path resolves to", async () => {
    const store = new ProjectSettingsStore(directory, async (projectPath) =>
      projectPath.startsWith("/repo") ? "/repo" : projectPath,
    );
    await store.set("/repo.gajae-worktrees/a", SETTINGS);
    expect(await store.get("/repo")).toEqual(SETTINGS);
    expect(await store.get("/repo/sub")).toEqual(SETTINGS);
    expect((await store.get("/other")).setupScript).toBe("");
    expect(store.list().map(({ root }) => root)).toEqual(["/repo"]);
  });

  it("forgets a project whose settings go back to the defaults", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    await store.set("/repo", SETTINGS);
    await store.set("/other", { ...SETTINGS, setupScript: "" });
    await store.set("/repo", { newSessionWorktree: false, setupScript: "", copyFiles: [] });
    expect(store.list().map(({ root }) => root)).toEqual(["/other"]);
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).projects)).toEqual(["/other"]);
  });

  it("refuses settings that fail validation and changes nothing", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    await store.set("/repo", SETTINGS);
    await expect(store.set("/repo", { ...SETTINGS, copyFiles: ["../../etc/passwd"] })).rejects.toThrow(/invalid/);
    await expect(store.set("/repo", { ...SETTINGS, setupScript: 4 })).rejects.toThrow(/invalid/);
    await expect(store.set("/repo", "nope")).rejects.toThrow();
    expect(await store.get("/repo")).toEqual(SETTINGS);
  });

  it("keeps the old settings when the write fails", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    await store.set("/repo", SETTINGS);
    await chmod(directory, 0o500);
    await expect(store.set("/repo", { ...SETTINGS, setupScript: "other" })).rejects.toThrow();
    expect((await store.get("/repo")).setupScript).toBe("npm ci");
  });

  it("returns copies, so a caller cannot edit the saved list", async () => {
    const store = new ProjectSettingsStore(directory, identity);
    await store.set("/repo", SETTINGS);
    (await store.get("/repo")).copyFiles.push("x");
    store.list()[0]!.settings.copyFiles.push("y");
    expect((await store.get("/repo")).copyFiles).toEqual([".env", "config/local.json"]);
  });

  it("drops malformed entries and keeps the rest", async () => {
    await writeFile(
      file(),
      JSON.stringify({
        projects: {
          "/repo": { newSessionWorktree: true, setupScript: "ok", copyFiles: [".env", "../x", 5] },
          "/defaults": { newSessionWorktree: false, setupScript: "", copyFiles: [] },
          "/bad": "settings",
          "/null": null,
          "": { newSessionWorktree: true },
        },
      }),
    );
    expect(new ProjectSettingsStore(directory, identity).list()).toEqual([
      { root: "/repo", settings: { newSessionWorktree: true, setupScript: "ok", copyFiles: [".env"] } },
    ]);
  });

  it.each([["not json"], ["[]"], ['{"projects":[]}'], ["null"]])("starts empty from %s", async (content) => {
    await writeFile(file(), content);
    expect(new ProjectSettingsStore(directory, identity).list()).toEqual([]);
  });
});
