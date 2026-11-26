import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AvailableAppUpdate } from "../shared/app-update.js";
import {
  AppUpdateInstallError,
  installAppUpdate,
  parseChecksum,
} from "./app-update-install.js";

const digest = "a".repeat(64);

const status: AvailableAppUpdate = {
  state: "available",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  releaseUrl: "https://github.com/Heyaaz/peacock/releases/tag/v0.2.0",
  checkedAtMs: 5,
  asset: {
    archiveName: "Peacock-0.2.0-darwin-arm64.zip",
    archiveUrl:
      "https://github.com/Heyaaz/peacock/releases/download/v0.2.0/Peacock-0.2.0-darwin-arm64.zip",
    checksumUrl:
      "https://github.com/Heyaaz/peacock/releases/download/v0.2.0/Peacock-0.2.0-darwin-arm64.zip.sha256",
  },
};

async function workspace(): Promise<{ root: string; bundle: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "peacock-install-"));
  const bundle = path.join(root, "Peacock.app");
  await mkdir(bundle, { recursive: true });
  return { root, bundle };
}

describe("parseChecksum", () => {
  it("takes the digest from the shasum line and rejects anything else", () => {
    expect(parseChecksum(`${digest}  Peacock.zip\n`)).toBe(digest);
    expect(parseChecksum(`not-a-digest  Peacock.zip`)).toBeUndefined();
    expect(parseChecksum("")).toBeUndefined();
  });
});

describe("installAppUpdate", () => {
  it("verifies the download and hands the swap to a detached script", async () => {
    const { root, bundle } = await workspace();
    const spawn = vi.fn((..._args: unknown[]) => ({ unref: () => undefined }));
    const result = await installAppUpdate({
      status,
      bundlePath: bundle,
      tempRoot: root,
      download: async (_url, file) => {
        await writeFile(file, "archive");
      },
      readText: async () => `${digest}  Peacock-0.2.0-darwin-arm64.zip\n`,
      sha256File: async () => digest,
      unzip: async (_archive, into) => {
        await mkdir(path.join(into, "Peacock.app"), { recursive: true });
      },
      spawn: spawn as unknown as typeof nodeSpawn,
      pid: 4242,
    });
    expect(result).toEqual({ state: "restarting", version: "0.2.0" });
    expect(spawn).toHaveBeenCalledOnce();
    const [, args, options] = spawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(args[0]).toMatch(/install\.sh$/u);
    expect(args.slice(1, 3)).toEqual(["4242", bundle]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    const script = await readFile(args[0]!, "utf8");
    expect(script).toContain('while kill -0 "$PID" 2>/dev/null; do sleep 1; done');
    expect(script).toContain('open "$TARGET"');
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a download whose digest differs from the published one", async () => {
    const { root, bundle } = await workspace();
    await expect(
      installAppUpdate({
        status,
        bundlePath: bundle,
        tempRoot: root,
        download: async (_url, file) => {
          await writeFile(file, "archive");
        },
        readText: async () => `${digest}  Peacock-0.2.0-darwin-arm64.zip\n`,
        sha256File: async () => "b".repeat(64),
        unzip: async () => undefined,
        spawn: vi.fn() as unknown as typeof nodeSpawn,
        pid: 1,
      }),
    ).rejects.toBeInstanceOf(AppUpdateInstallError);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a release that publishes no installable archive", async () => {
    const { root, bundle } = await workspace();
    await expect(
      installAppUpdate({
        status: { ...status, asset: undefined },
        bundlePath: bundle,
        tempRoot: root,
        download: async () => undefined,
        readText: async () => "",
        sha256File: async () => digest,
        unzip: async () => undefined,
        spawn: vi.fn() as unknown as typeof nodeSpawn,
        pid: 1,
      }),
    ).rejects.toBeInstanceOf(AppUpdateInstallError);
    await rm(root, { recursive: true, force: true });
  });
});
