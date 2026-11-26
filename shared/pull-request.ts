import type { GithubFailure, GithubPullSummary } from "./repo-ipc.js";

/**
 * Opening a pull request for a session's branch.
 *
 * The surface is session-scoped: the window names a session and the host finds
 * that session's own worktree, so no path from the window ever reaches `gh` or
 * Git. Nothing here carries a credential; `gh` owns the login.
 */

/** Where a session's branch would open a pull request, and from what. */
export interface PullRequestTarget {
  /** `owner/name` of the repository the pull request is opened in. */
  repo: string;
  /** The branch it would merge into. */
  base: string;
  /** The session's branch. */
  branch: string;
  /** What `gh pr create --head` is given: the branch, or `owner:branch` when it is pushed to a fork. */
  head: string;
  /** The branch is pushed to a fork, so `repo` is that fork's parent. */
  fork: boolean;
}

/** What the pull request form starts with. */
export interface PullRequestDraft {
  title: string;
  body: string;
}

export interface PullRequestStatus {
  target: PullRequestTarget;
  /** The open pull request for this branch, when there is one. */
  pull: GithubPullSummary | null;
  /** Every commit of the branch is on the remote, which a pull request needs. */
  pushed: boolean;
  draft: PullRequestDraft;
}

/** Why a pull request could not be looked up or opened. */
export type PullRequestFailure =
  | GithubFailure
  /** A pull request from the repository's own default branch makes no sense, and nothing is pushed there. */
  | { state: "default-branch"; branch: string }
  /** The branch, or commits on it, is not on the remote yet. */
  | { state: "not-pushed"; branch: string }
  /** HEAD is detached, so there is no branch to open a pull request from. */
  | { state: "no-branch" };

export type PullRequestQuery<T> = { state: "ok"; value: T } | PullRequestFailure;

/** What the person typed. */
export interface PullRequestInput {
  title: string;
  body: string;
}

export const PULL_REQUEST_TITLE_LIMIT = 256;
export const PULL_REQUEST_BODY_LIMIT = 60_000;

/**
 * The title and body as they will be sent, or an error that says which is wrong. The title is one
 * line; the body keeps its own line breaks, normalised, without trailing blank space.
 */
export function checkedPullRequestInput(input: PullRequestInput): PullRequestInput {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const body = typeof input?.body === "string" ? input.body.replace(/\r\n/gu, "\n").trimEnd() : "";
  if (!title) throw new Error("Pull request title is required");
  if (title.length > PULL_REQUEST_TITLE_LIMIT || /[\r\n\0]/u.test(title))
    throw new Error(`Pull request title must be one line of at most ${PULL_REQUEST_TITLE_LIMIT} characters`);
  if (body.length > PULL_REQUEST_BODY_LIMIT || body.includes("\0"))
    throw new Error(`Pull request body must be at most ${PULL_REQUEST_BODY_LIMIT} characters`);
  return { title, body };
}
