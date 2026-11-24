/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (app/electron/scripts/runtimes.ts): download, checksum, then unpack.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  HERDR_CORE,
  HERDR_CORE_BUNDLE,
  herdrCoreBinary,
  herdrCoreBundle,
  herdrCoreCacheDirectory,
  herdrCoreLicenses,
} from "./herdr-core-pin.mjs";

const execFileAsync = promisify(execFile);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The bytes at `pin.url`, refused unless they hash to `pin.sha256`. */
export async function download(pin, fetcher = fetch) {
  const response = await fetcher(pin.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}): ${pin.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = sha256(bytes);
  if (got !== pin.sha256)
    throw new Error(`Checksum mismatch for ${pin.url}: expected ${pin.sha256}, got ${got}`);
  return bytes;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The verified Herdr Core.app for this checkout and herdr-core's license files, downloaded once
 * into build/herdr-core/<version>/. A bundle already there whose `--version` names the pinned
 * release is used as it is.
 */
export async function ensureHerdrCore(root, { fetcher = fetch, log = console.log } = {}) {
  const bundle = herdrCoreBundle(root);
  const binary = herdrCoreBinary(root);
  const licenses = herdrCoreLicenses(root);
  if ((await exists(binary)) && (await exists(path.join(licenses, "LICENSE")))) {
    const { stdout } = await execFileAsync(binary, ["--version"]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === `hc ${HERDR_CORE.version}`) return { bundle, licenses };
  }
  const directory = herdrCoreCacheDirectory(root);
  await mkdir(path.dirname(directory), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(directory), `.staging-${HERDR_CORE.version}-`));
  try {
    log(`herdr-core ${HERDR_CORE.version}: downloading ${HERDR_CORE.url}`);
    const archive = path.join(staging, "herdr-core.tar.gz");
    await writeFile(archive, await download(HERDR_CORE, fetcher));
    await execFileAsync("/usr/bin/tar", ["-xzf", archive, "-C", staging]);
    const unpacked = path.join(staging, HERDR_CORE_BUNDLE);
    if (!(await exists(path.join(unpacked, "Contents", "MacOS", "herdr-core"))))
      throw new Error(`${HERDR_CORE.url} has no ${HERDR_CORE_BUNDLE}`);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await rename(unpacked, bundle);
    await mkdir(licenses, { recursive: true });
    for (const name of ["LICENSE", "THIRD-PARTY-NOTICES"]) {
      if (!(await exists(path.join(staging, name))))
        throw new Error(`${HERDR_CORE.url} has no ${name}`);
      await rename(path.join(staging, name), path.join(licenses, name));
    }
    log(`herdr-core ${HERDR_CORE.version}: ${bundle}`);
    return { bundle, licenses };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log(`herdr-core: no pinned build for ${process.platform}-${process.arch}; skipped`);
  } else {
    await ensureHerdrCore(fileURLToPath(new URL("..", import.meta.url)));
  }
}
