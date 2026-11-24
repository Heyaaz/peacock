/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (app/electron/scripts/runtimes.ts): the pinned herdr-core release and its checksum.
 */
import path from "node:path";

/**
 * The herdr-core (hc) Gajae bundles, from releases.herdr.dev/core/<version>/manifest.json.
 * Each download is checked against this SHA-256 before it is used, so a build never takes
 * whatever the server hands out that day. Changing the version means changing the checksum
 * here too, and HC_VERSION in electron/herdr-core/version.ts.
 */
export const HERDR_CORE = Object.freeze({
  version: "0.1.18",
  target: "macos-aarch64",
  url: "https://releases.herdr.dev/core/0.1.18/herdr-core-macos-aarch64.tar.gz",
  sha256: "77d8af092e25ae650f4424d6dad27514f6916a11d807fb0752858cd27c21e4fc",
});

/** The signed, notarized bundle inside the release archive. Gajae ships it whole. */
export const HERDR_CORE_BUNDLE = "Herdr Core.app";

/** Where a checkout keeps the verified download, outside version control. */
export function herdrCoreCacheDirectory(root) {
  return path.join(root, "build", "herdr-core", HERDR_CORE.version);
}

export function herdrCoreBundle(root) {
  return path.join(herdrCoreCacheDirectory(root), HERDR_CORE_BUNDLE);
}

/** herdr-core's LICENSE (Apache-2.0) and THIRD-PARTY-NOTICES, shipped beside the bundle. */
export function herdrCoreLicenses(root) {
  return path.join(herdrCoreCacheDirectory(root), "herdr-core-licenses");
}

export function herdrCoreBinary(root) {
  return path.join(herdrCoreBundle(root), "Contents", "MacOS", "herdr-core");
}
