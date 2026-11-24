/** The herdr-core release Gajae bundles (scripts/herdr-core-pin.mjs pins its download). */
export const HC_VERSION = "0.1.18";

/** The signed, notarized bundle hc 0.1.18 ships; Gajae installs and runs it whole. */
export const HC_BUNDLE = "Herdr Core.app";

/** The executable inside {@link HC_BUNDLE}. */
export function bundleBinary(bundle: string): string {
  return `${bundle}/Contents/MacOS/herdr-core`;
}

/** `hc 0.1.18` as `hc --version` prints it, or a `hello` version, as numbers. */
export function parseHcVersion(text: string): number[] | null {
  const match = /^(?:hc )?(\d+)\.(\d+)\.(\d+)/u.exec(text.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function versionText(version: readonly number[]): string {
  return version.join(".");
}
