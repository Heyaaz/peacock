import { describe, expect, it } from "vitest";
import {
  DEEP_LINK_PROMPT_LIMIT,
  deepLinksInArgv,
  sessionShortcutForDeepLink,
} from "./deep-link.js";

const folders = new Set(["/Users/me/project"]);
const parse = (url: string) =>
  sessionShortcutForDeepLink(url, (candidate) => folders.has(candidate));

describe("peacock:// links", () => {
  it("opens the new-session dialog with the prompt and folder, never a session", () => {
    expect(parse("peacock://new?prompt=fix%20the%20build&path=%2FUsers%2Fme%2Fproject")).toEqual({
      type: "new",
      prefill: { workspace: "/Users/me/project", prompt: "fix the build" },
    });
    expect(parse("peacock://new/?prompt=a+b")).toEqual({ type: "new", prefill: { prompt: "a b" } });
    expect(parse("peacock://new")).toEqual({ type: "new", prefill: {} });
  });

  it("opens a session by id", () => {
    expect(parse("peacock://session/0198-abc")).toEqual({ type: "open", sessionId: "0198-abc" });
    expect(parse("peacock://session/a%20b")).toEqual({ type: "open", sessionId: "a b" });
  });

  it("refuses a folder that is relative, missing, or not a directory, and says which", () => {
    for (const requested of ["project", "/Users/me/missing", "~/project"])
      expect(parse(`peacock://new?path=${encodeURIComponent(requested)}`)).toEqual({
        type: "invalidLink",
        reason: { kind: "path", path: requested },
      });
  });

  it("refuses a prompt over the limit instead of cutting it", () => {
    const prompt = "x".repeat(DEEP_LINK_PROMPT_LIMIT + 1);
    expect(parse(`peacock://new?prompt=${prompt}`)).toEqual({
      type: "invalidLink",
      reason: { kind: "prompt", limit: DEEP_LINK_PROMPT_LIMIT },
    });
    expect(parse(`peacock://new?prompt=${"x".repeat(DEEP_LINK_PROMPT_LIMIT)}`)).toMatchObject({
      type: "new",
    });
  });

  it("refuses a session link without a usable id", () => {
    for (const url of [
      "peacock://session",
      "peacock://session/",
      "peacock://session/a/b",
      "peacock://session/%E0%A4%A",
      `peacock://session/${"x".repeat(257)}`,
    ])
      expect(parse(url)).toEqual({ type: "invalidLink", reason: { kind: "session" } });
  });

  it("ignores anything that is not one of its links", () => {
    for (const url of [
      "https://example.com/new?prompt=x",
      "peacock://settings",
      "peacock://new/extra",
      "peacock:new",
      "not a url",
    ])
      expect(parse(url)).toBeUndefined();
  });

  it("finds links among launch arguments", () => {
    expect(
      deepLinksInArgv(["/Applications/Peacock.app", "--flag", "peacock://session/1", "https://x"]),
    ).toEqual(["peacock://session/1"]);
  });

  it("still honours gajae://, the scheme before the rename, the same way", () => {
    expect(parse("gajae://new?prompt=hi")).toEqual({ type: "new", prefill: { prompt: "hi" } });
    expect(parse("gajae://session/0198-abc")).toEqual({ type: "open", sessionId: "0198-abc" });
    expect(parse("gajae://settings")).toBeUndefined();
    expect(deepLinksInArgv(["gajae://session/1", "peacock://session/2", "other://x"])).toEqual([
      "gajae://session/1",
      "peacock://session/2",
    ]);
  });
});
