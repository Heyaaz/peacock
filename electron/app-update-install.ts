import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  AppUpdateInstallResult,
  AvailableAppUpdate,
} from "../shared/app-update.js";

/** A release the updater cannot install from inside the running app. */
export class AppUpdateInstallError extends Error {}

export interface AppUpdateInstallOptions {
  status: AvailableAppUpdate;
  /** The .app bundle this process was started from. */
  bundlePath: string;
  /** The directory a work folder may be made in; the bundle's sibling is not. */
  tempRoot: string;
  download: (url: string, file: string) => Promise<void>;
  readText: (url: string) => Promise<string>;
  sha256File: (file: string) => Promise<string>;
  unzip: (archive: string, into: string) => Promise<void>;
  spawn: typeof spawn;
  pid: number;
}

/** The first SHA-256 hex digest in a `.sha256` file (`<digest>  <name>`). */
export function parseChecksum(text: string): string | undefined {
  const digest = text.trim().split(/\s+/u)[0];
  return digest && /^[0-9a-f]{64}$/iu.test(digest) ? digest.toLowerCase() : undefined;
}

/**
 * Replaces the running bundle once this process has exited, then reopens it.
 *
 * Arguments: pid, bundle, staged bundle, work directory. The old bundle is only
 * removed after the new one is in place, so a failed copy leaves the app usable.
 */
export const SWAP_SCRIPT = `#!/bin/sh
set -u
PID="$1"
TARGET="$2"
STAGED="$3"
WORK="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 1; done
NEW="$TARGET.update"
rm -rf "$NEW"
ditto "$STAGED" "$NEW" || exit 1
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
OLD="$TARGET.old"
rm -rf "$OLD"
mv "$TARGET" "$OLD" || exit 1
if ! mv "$NEW" "$TARGET"; then
  mv "$OLD" "$TARGET"
  exit 1
fi
rm -rf "$OLD" "$WORK"
open "$TARGET"
`;

/**
 * Downloads the release archive, checks it against the published SHA-256, stages
 * the bundle, and hands the swap to a detached script that waits for this process
 * to exit. The caller quits the app after this resolves.
 */
export async function installAppUpdate(
  options: AppUpdateInstallOptions,
): Promise<AppUpdateInstallResult> {
  const { status } = options;
  const asset = status.asset;
  if (!asset)
    throw new AppUpdateInstallError(
      "이 릴리스에는 앱 설치 파일이 없습니다. 릴리스 페이지에서 내려받아 주세요.",
    );
  try {
    await access(path.dirname(options.bundlePath), constants.W_OK);
  } catch {
    throw new AppUpdateInstallError(
      "앱을 바꿀 수 없는 위치에서 실행 중입니다. Applications 폴더로 옮긴 뒤 다시 시도해 주세요.",
    );
  }
  const work = await mkdtemp(path.join(options.tempRoot, "peacock-update-"));
  const archive = path.join(work, asset.archiveName);
  await options.download(asset.archiveUrl, archive);
  const published = parseChecksum(await options.readText(asset.checksumUrl));
  if (!published)
    throw new AppUpdateInstallError(
      "릴리스의 체크섬 파일을 읽지 못했습니다. 릴리스 페이지에서 내려받아 주세요.",
    );
  const actual = await options.sha256File(archive);
  if (actual.toLowerCase() !== published)
    throw new AppUpdateInstallError(
      "내려받은 파일이 공개된 체크섬과 다릅니다. 다시 시도해 주세요.",
    );
  const unpacked = path.join(work, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await options.unzip(archive, unpacked);
  const bundles = await readdir(unpacked, { withFileTypes: true });
  const staged = bundles.find(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (!staged)
    throw new AppUpdateInstallError(
      "릴리스 압축 파일에서 Peacock.app을 찾지 못했습니다.",
    );
  const script = path.join(work, "install.sh");
  await writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
  const child: ChildProcess = options.spawn(
    "/bin/sh",
    [
      script,
      String(options.pid),
      options.bundlePath,
      path.join(unpacked, staged.name),
      work,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return { state: "restarting", version: status.latestVersion };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
