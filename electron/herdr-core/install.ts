/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (app/electron/src/children.ts `installCore`, `hcVersion`): the core runs from a copy in the
 * app's data folder, never from the bundled file, and never goes back to an older hc.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HC_BUNDLE, bundleBinary, compareVersions, parseHcVersion, versionText } from "./version.js";

const execFileAsync = promisify(execFile);

export type VersionReader = (binary: string) => Promise<number[] | null>;
export type BundleCopier = (from: string, to: string) => Promise<void>;

export const readHcVersion: VersionReader = async (binary) => {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 });
    return parseHcVersion(stdout);
  } catch {
    return null;
  }
};

/** ditto keeps the bundle's signature, extended attributes and modes exactly. */
export const dittoCopy: BundleCopier = async (from, to) => {
  await execFileAsync("/usr/bin/ditto", [from, to], { timeout: 60_000 });
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface InstalledCore {
  binary: string;
  version: number[];
}

/**
 * Installs the bundled Herdr Core.app as `<root>/<version>/Herdr Core.app` and returns the hc to run.
 *
 * The core and its terminal holders outlive the app, and an app update replaces the bundle they
 * started from, so they run from this copy. Each version gets a folder of its own: hc refuses to
 * swap a signed bundle in place (`hc update --from` answers "isn't writable", P1 measurement), and
 * holders an older core started keep running from their own folder until their terminals end.
 * A newer version already installed (left by a newer Gajae before a rollback) wins: hc never goes back.
 */
export async function installHerdrCore(options: {
  source: string;
  root: string;
  readVersion?: VersionReader;
  copy?: BundleCopier;
}): Promise<InstalledCore> {
  const readVersion = options.readVersion ?? readHcVersion;
  const copy = options.copy ?? dittoCopy;
  const bundled = await readVersion(bundleBinary(options.source));
  if (!bundled) throw new Error(`${options.source} is not a working herdr-core bundle`);
  const folder = path.join(options.root, versionText(bundled));
  const target = path.join(folder, HC_BUNDLE);
  const installed = (await exists(bundleBinary(target))) ? await readVersion(bundleBinary(target)) : null;
  if (!installed || compareVersions(installed, bundled) !== 0) {
    await mkdir(options.root, { recursive: true });
    const staging = `${folder}.installing-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await copy(options.source, path.join(staging, HC_BUNDLE));
    await rm(folder, { recursive: true, force: true });
    await rename(staging, folder);
  }
  const newest = await newestInstalled(options.root, readVersion);
  if (newest && compareVersions(newest.version, bundled) > 0) return newest;
  return { binary: bundleBinary(target), version: bundled };
}

async function newestInstalled(root: string, readVersion: VersionReader): Promise<InstalledCore | null> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  let best: InstalledCore | null = null;
  for (const name of names) {
    const named = parseHcVersion(name);
    if (!named || versionText(named) !== name) continue;
    if (best && compareVersions(named, best.version) <= 0) continue;
    const binary = bundleBinary(path.join(root, name, HC_BUNDLE));
    const actual = (await exists(binary)) ? await readVersion(binary) : null;
    if (actual && compareVersions(actual, named) === 0) best = { binary, version: actual };
  }
  return best;
}
