import type { SessionStatus } from "../../shared/agent-contract.js";

/** What herdr-core says about one terminal: from a snapshot, `terminal.get`, or its events. */
export interface TerminalFacts {
  state: string;
  /** The program has sent an OSC 7501 report at least once. */
  reported: boolean;
  /** Its latest 7501 record: idle, working, done, blocked or error (null: none yet, or just cleared). */
  status: { state: string; kind?: string | null; msg?: string } | null;
  exitCode?: number | null;
  reason?: string | null;
  signal?: number | null;
}

export type ActivityCategory = "completed" | "permission" | "failed";

/** A program that ended on its own with code 0, or that Gajae or a restart ended, did not fail. */
function endedCleanly(facts: TerminalFacts): boolean {
  if (facts.reason === "killed" || facts.reason === "server_stop" || facts.reason === "stopped_by_restart") return true;
  return facts.reason === "exited" ? facts.exitCode === 0 : facts.exitCode === 0 && !facts.signal;
}

/**
 * The session status a terminal's facts mean (design §4):
 * working → running, blocked → waiting, idle/done → idle, error → failed, an abnormal end → failed,
 * a program that never reported → unknown. `previous` stands for the moment a dialog closes,
 * when the 7501 record is briefly null (P0.5 spike).
 */
export function sessionStatusOf(facts: TerminalFacts | undefined, previous: SessionStatus = "idle"): SessionStatus {
  if (!facts) return "idle";
  if (facts.state === "finished") return endedCleanly(facts) ? "idle" : "failed";
  if (!facts.reported) return "unknown";
  switch (facts.status?.state) {
    case undefined:
      return previous;
    case "working":
      return "running";
    case "blocked":
      return "waiting";
    case "idle":
    case "done":
      return "idle";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * What a change in facts is worth telling the user: a finished turn (`done`), a wait for approval
 * (`blocked`), or a failure (7501 `error`, or an abnormal end). Each is told once, on the change.
 */
export function activityOf(previous: TerminalFacts | undefined, next: TerminalFacts): ActivityCategory | undefined {
  if (next.state === "finished") {
    if (previous?.state === "finished") return undefined;
    return endedCleanly(next) ? undefined : "failed";
  }
  const was = previous?.state === "live" ? previous.status?.state : undefined;
  const now = next.status?.state;
  if (now === was) return undefined;
  if (now === "done") return "completed";
  if (now === "blocked") return "permission";
  if (now === "error") return "failed";
  return undefined;
}

/** A Terminal (snapshot, `terminal.get`) as facts. */
export function factsOfTerminal(terminal: {
  state?: string;
  reported?: boolean;
  status?: { state: string; kind?: string | null; msg?: string } | null;
  exit_code?: number | null;
  reason?: string | null;
  signal?: number | null;
}): TerminalFacts {
  return {
    state: terminal.state ?? "live",
    reported: terminal.reported === true,
    status: terminal.status ?? null,
    exitCode: terminal.exit_code ?? null,
    reason: terminal.reason ?? null,
    signal: terminal.signal ?? null,
  };
}
