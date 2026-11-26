import { capabilitiesOf } from "./agent-contract.js";
import type { AgentSession } from "./agent-contract.js";

/**
 * Reading only what a turn changed.
 *
 * When a turn starts the host writes the folder's files, as they are then, into Git's object store as a
 * tree (through a throwaway index, so the real index and the files are never touched) and remembers the
 * tree id. "This turn" is then that tree against the folder as it is now. Nothing but the id is kept.
 */

/** Everything the folder changed since the session's start, or only since its latest turn began. */
export type DiffScope = "all" | "turn";

export function parseDiffScope(value: unknown): DiffScope {
  if (value === "all" || value === "turn") return value;
  throw new Error("Diff scope must be all or turn");
}

/** Why there is no turn to compare with; each reason has its own fix, so each has its own sentence. */
export type TurnDiffReason =
  /** No turn has started since the app began watching this session. */
  | "no-turn"
  /** The agent gives no turn signal the app can trust (Codex), or runs no turns (a shell). */
  | "unsupported"
  | "not-git"
  /** The repository is past the size the feature stays on for. */
  | "too-large"
  | "failed"
  /** Git no longer has the tree the turn started from. */
  | "lost";

export type TurnDiffState =
  | { state: "ready"; /** When the turn started, as an ISO time. */ startedAt: string }
  | { state: "unavailable"; reason: TurnDiffReason; detail?: string };

/**
 * Past either of these a turn start would read too much of the disk: the real index is the repository's
 * tracked files (about 100 bytes each), and untracked files are the ones `git add -A` would have to hash.
 * The feature is off for that repository, and says so, instead of slowing every turn.
 */
export const TURN_DIFF_INDEX_LIMIT_BYTES = 16 * 1024 * 1024;
export const TURN_DIFF_UNTRACKED_LIMIT = 5000;

/**
 * Whether the app can see when this session's turns start: a GJC chat, an omp chat and a Claude Code or
 * omp terminal report it as a status change. Codex reports none it can be trusted by, and a shell runs
 * no turns.
 */
export function supportsTurnDiff(
  session: Pick<AgentSession, "agentKind" | "runtime" | "capabilities" | "workspace">,
): boolean {
  if (session.agentKind === "codex" || session.agentKind === "shell") return false;
  return capabilitiesOf(session).git && session.workspace.trim() !== "";
}
