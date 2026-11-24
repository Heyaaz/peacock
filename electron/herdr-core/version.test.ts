import { describe, expect, it } from "vitest";
import { HERDR_CORE } from "../../scripts/herdr-core-pin.mjs";
import { HC_VERSION, compareVersions, parseHcVersion } from "./version.js";

describe("herdr-core version", () => {
  it("bundles the release the download script pins", () => {
    expect(HERDR_CORE.version).toBe(HC_VERSION);
    expect(HERDR_CORE.url).toContain(`/core/${HC_VERSION}/`);
    expect(HERDR_CORE.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reads hc --version and hello versions", () => {
    expect(parseHcVersion("hc 0.1.18\n")).toEqual([0, 1, 18]);
    expect(parseHcVersion("0.1.20")).toEqual([0, 1, 20]);
    expect(parseHcVersion("herdr 1.0")).toBeNull();
  });

  it("orders versions numerically", () => {
    expect(compareVersions([0, 1, 9], [0, 1, 18])).toBeLessThan(0);
    expect(compareVersions([0, 2, 0], [0, 1, 99])).toBeGreaterThan(0);
    expect(compareVersions([0, 1, 18], [0, 1, 18])).toBe(0);
  });
});
