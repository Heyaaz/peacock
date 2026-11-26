import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiffSnapshot,
  GitStatusSnapshot,
  GoalSnapshot,
} from "../../shared/agent-contract";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentSession } from "../backend/types";
import type { DiffScope } from "../../shared/turn-diff";
import { goalPollDelay } from "./goal-poll";

type SessionIdRef = { current: string | null };

export function useGoal(
  backend: AgentBackend,
  selectedIdRef: SessionIdRef,
  selectedSessionId: string | undefined,
  selectedSessionStatus: AgentSession["status"] | undefined,
) {
  const [goal, setGoal] = useState<GoalSnapshot>({
    enabled: false,
    completed: 0,
    total: 0,
  });
  const goalRescheduleRef = useRef<(snapshot: GoalSnapshot) => void>(
    () => undefined,
  );
  const [goalBusySessionId, setGoalBusySessionId] = useState<string | null>(null);


  useEffect(() => {
    if (!selectedSessionId) return;
    let active = true;
    let refreshing = false;
    let timer: number | undefined;
    const clearTimer = (): void => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (snapshot: GoalSnapshot): void => {
      if (!active) return;
      clearTimer();
      timer = window.setTimeout(refresh, goalPollDelay(snapshot, selectedSessionStatus));
    };
    const refresh = (): void => {
      if (!active || refreshing) return;
      refreshing = true;
      void backend
        .getGoal(selectedSessionId)
        .then((snapshot) => {
          if (!active || selectedIdRef.current !== selectedSessionId) return;
          setGoal(snapshot);
          schedule(snapshot);
        })
        .catch(() => {
          if (!active || selectedIdRef.current !== selectedSessionId) return;
          const snapshot = { enabled: false, completed: 0, total: 0 };
          setGoal(snapshot);
          schedule(snapshot);
        })
        .finally(() => { refreshing = false; });
    };
    goalRescheduleRef.current = (snapshot) => {
      if (active) schedule(snapshot);
    };
    // Goal and todo state advance at tool-call pace, not at streaming pace. No
    // active goal backs off to 30s; a goal operation reschedules immediately from
    // the snapshot it already received instead of issuing another query.
    queueMicrotask(refresh);
    const refreshOnVisible = (): void => {
      if (document.hidden) return;
      clearTimer();
      refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      active = false;
      clearTimer();
      goalRescheduleRef.current = () => undefined;
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [backend, selectedSessionId, selectedSessionStatus]);

  return { goal, setGoal, goalRescheduleRef, goalBusySessionId, setGoalBusySessionId };
}

/** Whether a status is a turn in progress: the agent is not asking for the next request yet. */
function turnOn(status: AgentSession["status"] | undefined): boolean {
  return status === "running" || status === "starting" || status === "waiting";
}

/**
 * How many turns of the selected session have ended since it was selected: the count goes up when its
 * status leaves a turn in progress. What its folder holds is worth reading again then, not at every
 * status change, which a terminal agent makes often.
 */
export function useTurnEnds(
  sessionId: string | undefined,
  status: AgentSession["status"] | undefined,
): number {
  const [track, setTrack] = useState({ sessionId, status, ended: 0 });
  if (track.sessionId !== sessionId) setTrack({ sessionId, status, ended: 0 });
  else if (track.status !== status)
    setTrack({ sessionId, status, ended: track.ended + (turnOn(track.status) && !turnOn(status) ? 1 : 0) });
  return track.sessionId === sessionId ? track.ended : 0;
}

/**
 * The selected session's git status, read when it is selected, when one of its turns ends
 * (`turnEnds`) and when the window gets focus back; never on a status change that is not a turn's end.
 */
export function useGitStatus(
  backend: AgentBackend,
  selectedSessionId: string | undefined,
  turnEnds: number,
) {
  const [selectedGit, setSelectedGit] = useState<GitStatusSnapshot | null>(
    null,
  );


  useEffect(() => {
    if (!selectedSessionId) {
      queueMicrotask(() => setSelectedGit(null));
      return;
    }
    let active = true;
    const refresh = (): void => {
      void backend
        .getGitStatus(selectedSessionId)
        .then((status) => {
          if (active) setSelectedGit(status);
        })
        .catch(() => {
          if (active) setSelectedGit(null);
        });
    };
    queueMicrotask(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [backend, selectedSessionId, turnEnds]);

  return selectedGit;
}

/**
 * The selected session's changed files, read when the panel opens and when the session changes.
 * `followTurns` (a session's turn count, from `useTurnEnds`) keeps an open panel current: it is read
 * again when a turn ends and when the window gets focus back, and `followedReads` counts those reads.
 *
 * The panel can show everything or only the latest turn (`diffScope`, remembered per session; one that was
 * never chosen for starts on everything). While it shows a turn it follows `turnEnds` as well, so the turn
 * it reads is never an old one just because the session is not one that follows its turns.
 */
export function useDiff(
  backend: AgentBackend,
  diffOpen: boolean,
  selectedId: string | null,
  selectedIdRef: SessionIdRef,
  sessionWorkspace: string | undefined,
  followTurns?: number,
  turnEnds?: number,
) {
  // what each session was last shown as; a session never chosen for is shown everything
  const [scopeChoices, setScopeChoices] = useState<Readonly<Record<string, DiffScope>>>({});
  const diffScope: DiffScope = (selectedId ? scopeChoices[selectedId] : undefined) ?? "all";
  const setDiffScope = useCallback(
    (scope: DiffScope) => {
      if (selectedId) setScopeChoices((choices) => ({ ...choices, [selectedId]: scope }));
    },
    [selectedId],
  );
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const [followedReads, setFollowedReads] = useState(0);
  const diffOpenRef = useRef(diffOpen);
  diffOpenRef.current = diffOpen;
  // Every diff belongs to the session it was requested for; bumping this drops
  // an answer that arrives after the user moved on.
  const diffRequestRef = useRef(0);
  const [diffLoading, setDiffLoading] = useState(false);

  const refreshDiff = useCallback(async (): Promise<void> => {
    const sessionId = selectedId;
    if (!sessionId) return;
    const request = ++diffRequestRef.current;
    const workspace = sessionWorkspace ?? "";
    setDiffLoading(true);
    try {
      const snapshot = await (diffScope === "turn"
        ? backend.getDiff(sessionId, { scope: "turn" })
        : backend.getDiff(sessionId));
      if (diffRequestRef.current !== request || selectedIdRef.current !== sessionId)
        return;
      setDiff(snapshot);
    } catch (e) {
      if (diffRequestRef.current !== request || selectedIdRef.current !== sessionId)
        return;
      setDiff({
        sessionId,
        workspace,
        files: [],
        refreshedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (diffRequestRef.current === request) setDiffLoading(false);
    }
  }, [backend, selectedId, sessionWorkspace, diffScope]);

  // A session switch invalidates the diff already on screen and anything still in
  // flight, so those patches can never be read -- or acted on -- under the new
  // session.
  useEffect(() => {
    diffRequestRef.current += 1;
    setDiff(null);
    setDiffLoading(false);
    if (selectedId && diffOpenRef.current) void refreshDiff();
  }, [selectedId, diffOpen, refreshDiff]);

  const followed = followTurns ?? (diffScope === "turn" ? turnEnds : undefined);
  const following = followed !== undefined;
  const seenTurns = useRef({ selectedId, followed, diffScope });
  useEffect(() => {
    const seen = seenTurns.current;
    seenTurns.current = { selectedId, followed, diffScope };
    if (!following || !selectedId || !diffOpen) return;
    // a turn ended on the session that was already shown: not a session switch or a change of what is
    // shown, which read on their own
    if (seen.selectedId === selectedId && seen.diffScope === diffScope && seen.followed !== followed) {
      setFollowedReads((count) => count + 1);
      void refreshDiff();
    }
  }, [following, followed, diffScope, selectedId, diffOpen, refreshDiff]);

  useEffect(() => {
    if (!following || !selectedId || !diffOpen) return;
    const onFocus = (): void => {
      setFollowedReads((count) => count + 1);
      void refreshDiff();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [following, selectedId, diffOpen, refreshDiff]);

  return { diff, diffLoading, refreshDiff, followedReads, diffScope, setDiffScope };
}
