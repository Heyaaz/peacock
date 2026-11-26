/**
 * What the app knows about a newer Gajae release.
 *
 * `unknown` is a normal outcome, not an error: an unpublished or private
 * repository, no network and GitHub's rate limit all end there, and none of them
 * may block the app or raise a notification.
 */
export type AppUpdateStatus =
  | { state: "unchecked"; currentVersion: string }
  | {
      state: "current";
      currentVersion: string;
      latestVersion: string;
      checkedAtMs: number;
    }
  | {
      state: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      checkedAtMs: number;
      /** The macOS archive a user can install from inside the app. */
      asset?: AppUpdateAsset;
    }
  | {
      state: "unknown";
      currentVersion: string;
      reason: AppUpdateUnknownReason;
      checkedAtMs: number;
    };

/** The release download the updater installs: the app archive and its SHA-256. */
export interface AppUpdateAsset {
  archiveUrl: string;
  checksumUrl: string;
  archiveName: string;
}

/** Started installing: the app replaces itself and reopens. */
export type AppUpdateInstallResult = { state: "restarting"; version: string };

export type AppUpdateUnknownReason =
  | "no-repository"
  | "not-found"
  | "rate-limited"
  | "unreachable"
  | "invalid-response";

export type AvailableAppUpdate = Extract<AppUpdateStatus, { state: "available" }>;
