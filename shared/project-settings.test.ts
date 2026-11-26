import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  isDefaultProjectSettings,
  normalizeCopyPath,
  parseProjectSettings,
  PROJECT_SETTINGS_LIMITS,
  projectSettingsFault,
} from "./project-settings.js";

describe("normalizeCopyPath", () => {
  it("keeps a root-relative path with single slashes and no dot segments", () => {
    expect(normalizeCopyPath(".env")).toBe(".env");
    expect(normalizeCopyPath("  ./config//local/.env.local ")).toBe("config/local/.env.local");
    expect(normalizeCopyPath("apps/web/./.env")).toBe("apps/web/.env");
  });

  it.each([
    ["an empty path", ""],
    ["blanks", "   "],
    ["a parent segment", "../secret"],
    ["a parent segment in the middle", "a/../../secret"],
    ["an absolute path", "/etc/passwd"],
    ["a home path", "~/.ssh/id_rsa"],
    ["a folder", "config/"],
    ["Git's own folder", ".git/config"],
    ["Git's own folder in any case", "sub/.GIT/hooks/post-checkout"],
    ["a backslash", "a\\..\\b"],
    ["a control character", "a\u0000b"],
    ["a line break", "a\nb"],
    ["only dots", "./."],
    ["a path that is too long", "a".repeat(PROJECT_SETTINGS_LIMITS.copyPathLength + 1)],
  ])("refuses %s", (_label, value) => {
    expect(normalizeCopyPath(value)).toBeUndefined();
  });

  it("refuses what is not a string", () => {
    expect(normalizeCopyPath(undefined)).toBeUndefined();
    expect(normalizeCopyPath(3)).toBeUndefined();
    expect(normalizeCopyPath(null)).toBeUndefined();
  });

  it("allows a file whose name only contains .git", () => {
    expect(normalizeCopyPath(".gitignore.local")).toBe(".gitignore.local");
    expect(normalizeCopyPath("a/.github/secrets.env")).toBe("a/.github/secrets.env");
  });
});

describe("parseProjectSettings", () => {
  it("falls back to the defaults for anything that is not a record", () => {
    for (const value of [undefined, null, "x", 3, [], true])
      expect(parseProjectSettings(value)).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it("keeps the valid parts and drops the rest", () => {
    expect(
      parseProjectSettings({
        newSessionWorktree: true,
        setupScript: "  npm install\n  ",
        copyFiles: [".env", "./.env", "../x", 4, "config/local.json", "/abs"],
      }),
    ).toEqual({ newSessionWorktree: true, setupScript: "npm install", copyFiles: [".env", "config/local.json"] });
  });

  it("is not fooled by a truthy non-boolean or an oversized script", () => {
    expect(parseProjectSettings({ newSessionWorktree: "yes" }).newSessionWorktree).toBe(false);
    expect(
      parseProjectSettings({ setupScript: "x".repeat(PROJECT_SETTINGS_LIMITS.setupScriptLength + 1) }).setupScript,
    ).toBe("");
    expect(parseProjectSettings({ setupScript: "a\u0000b" }).setupScript).toBe("");
  });

  it("caps the copy list", () => {
    const files = Array.from({ length: PROJECT_SETTINGS_LIMITS.copyFiles + 5 }, (_, index) => `f${index}`);
    expect(parseProjectSettings({ copyFiles: files }).copyFiles).toHaveLength(PROJECT_SETTINGS_LIMITS.copyFiles);
  });

  it("does not share the default's list between calls", () => {
    const first = parseProjectSettings(undefined);
    first.copyFiles.push("x");
    expect(parseProjectSettings(undefined).copyFiles).toEqual([]);
    expect(DEFAULT_PROJECT_SETTINGS.copyFiles).toEqual([]);
  });
});

describe("projectSettingsFault", () => {
  const valid = { newSessionWorktree: false, setupScript: "", copyFiles: [".env"] };

  it("accepts a well-formed input", () => {
    expect(projectSettingsFault(valid)).toBeNull();
    expect(projectSettingsFault({ ...valid, setupScript: "npm ci && npm run build", newSessionWorktree: true })).toBeNull();
  });

  it.each([
    ["not an object", "x"],
    ["no flag", { setupScript: "", copyFiles: [] }],
    ["a non-boolean flag", { ...valid, newSessionWorktree: 1 }],
    ["a non-string script", { ...valid, setupScript: 1 }],
    ["an oversized script", { ...valid, setupScript: "x".repeat(PROJECT_SETTINGS_LIMITS.setupScriptLength + 1) }],
    ["a script with NUL", { ...valid, setupScript: "a\u0000" }],
    ["a copy list that is not a list", { ...valid, copyFiles: ".env" }],
    ["an escaping copy path", { ...valid, copyFiles: [".env", "../../etc/passwd"] }],
    ["a non-string copy path", { ...valid, copyFiles: [3] }],
    ["too many copy paths", { ...valid, copyFiles: Array.from({ length: PROJECT_SETTINGS_LIMITS.copyFiles + 1 }, (_, i) => `f${i}`) }],
  ])("refuses %s", (_label, value) => {
    expect(projectSettingsFault(value)).toEqual(expect.any(String));
  });

  it("names the first bad copy path", () => {
    expect(projectSettingsFault({ ...valid, copyFiles: ["ok", "../bad"] })).toContain("../bad");
  });
});

describe("isDefaultProjectSettings", () => {
  it("is true only when nothing is set", () => {
    expect(isDefaultProjectSettings({ ...DEFAULT_PROJECT_SETTINGS, copyFiles: [] })).toBe(true);
    expect(isDefaultProjectSettings({ newSessionWorktree: true, setupScript: "", copyFiles: [] })).toBe(false);
    expect(isDefaultProjectSettings({ newSessionWorktree: false, setupScript: "x", copyFiles: [] })).toBe(false);
    expect(isDefaultProjectSettings({ newSessionWorktree: false, setupScript: "", copyFiles: [".env"] })).toBe(false);
  });
});
