import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Moving the app's data folder on the rename (design §11): `Agent Control` becomes `Peacock`.
 * The old folder is copied, never moved, and never deleted: a failed copy leaves both folders as
 * they were (the staging copy is kept beside them), and the old Gajae.app still opens its own.
 */

/** The data folder before the rename, under `~/Library/Application Support`. */
export const LEGACY_USER_DATA_NAME = "Agent Control";
/** The data folder since the rename. */
export const USER_DATA_NAME = "Peacock";
/** Written into the new folder once its copy verified: the migration happened, never again. */
export const MIGRATION_MARKER = "peacock-migration.json";

/** Files only the app writes: a folder holding one of them holds the app's data. */
const APP_DATA_FILES = [
  "agent-control-settings.json",
  "agent-control-sessions.json",
  "agent-control-desktop-state.json",
  "terminal-sessions.json",
  "omp-rpc-sessions.json",
  "remote-access.json",
  "remote-devices.json",
  "command-rules.json",
  "productivity.sqlite",
  path.join("agent-hooks", "token"),
];

/** What the copy also compares byte for byte (sha256): losing any of these loses user state. */
const KEY_FILES = [...APP_DATA_FILES, "productivity.sqlite-wal", "productivity.sqlite-shm"];

/** Top-level entries left behind: the running app's locks, and what the app reinstalls (`bin/`). */
const SKIPPED_TOP_LEVEL = /^(?:Singleton(?:Lock|Socket|Cookie)|DevToolsActivePort|bin)$/u;
/** Chromium caches, at any depth: rebuilt on demand. */
const SKIPPED_CACHE = /^(?:Cache|Code Cache|GPUCache|Dawn\w*Cache)$/u;

export type UserDataMigration =
  /** The new folder already holds the app's data (migrated before, or a fresh install's). */
  | { kind: "current"; userData: string }
  /** Nothing to move: no data in the old folder either. */
  | { kind: "fresh"; userData: string }
  /** Copied and verified this launch. */
  | { kind: "migrated"; userData: string; legacy: string; files: number; bytes: number }
  /** The old app holds the old folder: nothing was copied, and this launch must not go on. */
  | { kind: "legacy-running"; legacy: string; pid: number }
  /** The copy failed: this launch runs on the old folder, the staging copy is kept. */
  | { kind: "failed"; userData: string; error: string; kept?: string };

export interface MigrationOptions {
  /** `~/Library/Application Support`. */
  appData: string;
  /** Whether a pid is the old app, still running. */
  isLegacyApp?: (pid: number) => boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

export function hasAppData(directory: string): boolean {
  return APP_DATA_FILES.some((name) => existsSync(path.join(directory, name)));
}

/**
 * The pid holding a folder's Chromium single-instance lock, when it is the old app still running.
 * The lock is a symlink to `<host>-<pid>` that a clean exit removes; a crash can leave it behind,
 * so the pid has to name a live Gajae (or, from source, Electron) process.
 */
export function legacyAppPid(directory: string, isLegacyApp: (pid: number) => boolean = isGajaeProcess): number | undefined {
  let target: string;
  try {
    target = readlinkSync(path.join(directory, "SingletonLock"));
  } catch {
    return undefined;
  }
  const pid = Number(/-(\d+)$/u.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && isLegacyApp(pid) ? pid : undefined;
}

function isGajaeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2000 });
    return /Gajae|Electron/u.test(command);
  } catch {
    return false;
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface CopiedFile {
  relative: string;
  size: number;
}

/** Copies a folder tree: files (with their times and modes), folders and symlinks; sockets and other special files are not data. */
function copyTree(from: string, to: string, relative: string, copied: CopiedFile[]): void {
  mkdirSync(to, { recursive: true, mode: statSync(from).mode & 0o777 });
  for (const name of readdirSync(from)) {
    if ((relative === "" && SKIPPED_TOP_LEVEL.test(name)) || SKIPPED_CACHE.test(name)) continue;
    const source = path.join(from, name);
    const target = path.join(to, name);
    const entry = lstatSync(source);
    const rel = relative ? path.join(relative, name) : name;
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (entry.isDirectory()) copyTree(source, target, rel, copied);
    else if (entry.isFile()) {
      copyFileSync(source, target);
      utimesSync(target, entry.atime, entry.mtime);
      copied.push({ relative: rel, size: entry.size });
    }
  }
}

/** Every copied file has its size, and every key file its exact bytes; throws on the first that does not. */
function verifyCopy(from: string, to: string, copied: CopiedFile[]): void {
  for (const file of copied) {
    const size = statSync(path.join(to, file.relative)).size;
    if (size !== file.size) throw new Error(`${file.relative}: ${size} bytes copied of ${file.size}`);
  }
  for (const name of KEY_FILES) {
    const source = path.join(from, name);
    if (!existsSync(source)) continue;
    const target = path.join(to, name);
    if (!existsSync(target)) throw new Error(`${name} was not copied`);
    if (sha256(source) !== sha256(target)) throw new Error(`${name} differs from the original`);
  }
}

/**
 * Picks this launch's data folder, copying the old one into place first when that is due:
 * once, while the old app is not running, and only into a new folder that holds no data yet.
 */
export function migrateUserData(options: MigrationOptions): UserDataMigration {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const target = path.join(options.appData, USER_DATA_NAME);
  const legacy = path.join(options.appData, LEGACY_USER_DATA_NAME);
  const pid = legacyAppPid(legacy, options.isLegacyApp);
  // the old app and this one would drive the same terminals (hc session `gajae`) from two folders
  if (pid !== undefined && hasAppData(legacy)) return { kind: "legacy-running", legacy, pid };
  if (existsSync(path.join(target, MIGRATION_MARKER)) || hasAppData(target)) return { kind: "current", userData: target };
  if (!hasAppData(legacy)) return { kind: "fresh", userData: target };

  const when = stamp(now());
  const staging = path.join(options.appData, `${USER_DATA_NAME}.migrating-${when}`);
  try {
    const copied: CopiedFile[] = [];
    copyTree(legacy, staging, "", copied);
    verifyCopy(legacy, staging, copied);
    const bytes = copied.reduce((total, file) => total + file.size, 0);
    writeFileSync(
      path.join(staging, MIGRATION_MARKER),
      `${JSON.stringify({ from: legacy, migratedAt: now().toISOString(), files: copied.length, bytes }, null, 2)}\n`,
      { mode: 0o600 },
    );
    // a folder with no app data in it (an empty profile Chromium made) is set aside, not merged
    if (existsSync(target)) renameSync(target, path.join(options.appData, `${USER_DATA_NAME}.pre-migration-${when}`));
    renameSync(staging, target);
    log(`copied ${copied.length} files (${bytes} bytes) from ${legacy}; the old folder is kept`);
    return { kind: "migrated", userData: target, legacy, files: copied.length, bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let kept: string | undefined;
    if (existsSync(staging)) {
      kept = path.join(options.appData, `${USER_DATA_NAME}.failed-${when}`);
      try {
        renameSync(staging, kept);
      } catch {
        kept = staging;
      }
    }
    log(`copy failed (${message}); running on ${legacy} this time${kept ? `, the partial copy is in ${kept}` : ""}`);
    return { kind: "failed", userData: legacy, error: message, ...(kept ? { kept } : {}) };
  }
}

/**
 * A data folder for a run from source, which never copies anything: the new folder once it holds
 * the app's data, else the old one, as before the rename.
 */
export function developmentUserData(appData: string): string {
  const target = path.join(appData, USER_DATA_NAME);
  const legacy = path.join(appData, LEGACY_USER_DATA_NAME);
  return existsSync(path.join(target, MIGRATION_MARKER)) || hasAppData(target) || !hasAppData(legacy) ? target : legacy;
}
