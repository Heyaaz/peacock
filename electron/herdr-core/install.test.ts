import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installHerdrCore, type BundleCopier, type VersionReader } from "./install.js";
import { HC_BUNDLE, bundleBinary } from "./version.js";

/** A fake Herdr Core.app whose binary is a text file naming its version. */
function bundle(root: string, version: string): string {
  const app = path.join(root, `src-${version}`, HC_BUNDLE);
  mkdirSync(path.dirname(bundleBinary(app)), { recursive: true });
  writeFileSync(bundleBinary(app), version);
  return app;
}

const readVersion: VersionReader = async (binary) => {
  try {
    return readFileSync(binary, "utf8").split(".").map(Number);
  } catch {
    return null;
  }
};

const copy: BundleCopier = async (from, to) => {
  mkdirSync(path.dirname(bundleBinary(to)), { recursive: true });
  writeFileSync(bundleBinary(to), readFileSync(bundleBinary(from)));
};

describe("installHerdrCore", () => {
  it("copies the bundle into a folder of its version and runs it from there", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-hc-install-"));
    const source = bundle(root, "0.1.18");
    const installed = await installHerdrCore({ source, root: path.join(root, "bin"), readVersion, copy });
    expect(installed).toEqual({
      binary: bundleBinary(path.join(root, "bin", "0.1.18", HC_BUNDLE)),
      version: [0, 1, 18],
    });
    expect(readFileSync(installed.binary, "utf8")).toBe("0.1.18");
  });

  it("does not copy again when that version is installed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-hc-install-"));
    const source = bundle(root, "0.1.18");
    const copied = vi.fn(copy);
    await installHerdrCore({ source, root: path.join(root, "bin"), readVersion, copy: copied });
    await installHerdrCore({ source, root: path.join(root, "bin"), readVersion, copy: copied });
    expect(copied).toHaveBeenCalledTimes(1);
  });

  it("installs a newer bundle beside the old one, which its holders may still run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-hc-install-"));
    const bin = path.join(root, "bin");
    await installHerdrCore({ source: bundle(root, "0.1.18"), root: bin, readVersion, copy });
    const newer = await installHerdrCore({ source: bundle(root, "0.1.19"), root: bin, readVersion, copy });
    expect(newer.version).toEqual([0, 1, 19]);
    expect(existsSync(bundleBinary(path.join(bin, "0.1.18", HC_BUNDLE)))).toBe(true);
  });

  it("keeps a newer hc a newer app left behind: hc never goes back", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-hc-install-"));
    const bin = path.join(root, "bin");
    await installHerdrCore({ source: bundle(root, "0.1.19"), root: bin, readVersion, copy });
    const older = await installHerdrCore({ source: bundle(root, "0.1.18"), root: bin, readVersion, copy });
    expect(older).toEqual({ binary: bundleBinary(path.join(bin, "0.1.19", HC_BUNDLE)), version: [0, 1, 19] });
  });

  it("refuses a bundle whose hc does not answer its version", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gajae-hc-install-"));
    await expect(
      installHerdrCore({ source: path.join(root, "missing", HC_BUNDLE), root: path.join(root, "bin"), readVersion, copy }),
    ).rejects.toThrow(/not a working herdr-core bundle/u);
  });
});
