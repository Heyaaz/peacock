import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentSession, TranscriptItem } from "../backend/types";
import type { NewSessionChoice } from "../../shared/agent-contract";
import { agentCatalogEntry, sessionRuntimeFor } from "../../shared/agent-catalog";
import type { AgentBackend } from "../backend/agent-backend";
import type { NewSessionPrefill } from "../../shared/settings-ipc";
import { cacheTranscript } from "../transcript-utils";
import { prefillComposerDraft } from "./composer";
import type { NewSessionInput } from "./dialogs";
import { t } from "../i18n";
import { directoryName, humanErrorMessage } from "./format";
import { worktreeSetupMessage } from "./worktree-setup";

export function useCreateSession(
  backend: AgentBackend,
  pendingSessions: MutableRefObject<Map<string, Promise<AgentSession>>>,
  setAppError: (message: string) => void,
  setNewSessionRequest: Dispatch<
    SetStateAction<{ prefill?: NewSessionPrefill; serial: number } | null>
  >,
  setSessions: Dispatch<SetStateAction<AgentSession[]>>,
  setSelectedId: Dispatch<SetStateAction<string | null>>,
  setTranscripts: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>,
  /** A terminal session was created, to open on the screen its dialog chose. */
  onTerminalCreated?: (session: AgentSession, choice: NewSessionChoice) => void,
  /** What the dialog chose, to come first next time. */
  rememberChoice?: (choice: NewSessionChoice) => void,
) {
  const createSession = useCallback(
    (input: NewSessionInput): void | Promise<void> => {
      if (input.kind === "terminal") {
        setAppError("");
        const agentKind = input.agentKind ?? "shell";
        const choice: NewSessionChoice = { agentKind, surface: input.surface ?? agentCatalogEntry(agentKind).defaultSurface };
        // omp's chat screen is an RPC chat of its own (design §10); every other screen is a herdr terminal
        const runtime: "omp-rpc" | "herdr" = sessionRuntimeFor(agentKind, choice.surface) === "omp-rpc" ? "omp-rpc" : "herdr";
        const worktree = input.isolation === "worktree";
        const request = {
          runtime,
          title: input.title,
          workspace: input.workspace,
          isolation: worktree ? ("worktree" as const) : ("workspace" as const),
          ...(worktree && input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
          ...(input.agentKind ? { agentKind: input.agentKind } : {}),
          ...(input.launch ? { launch: input.launch } : {}),
          surface: choice.surface,
        };
        if (!worktree)
          return backend
            .createSession(request)
            .then((session) => {
              onTerminalCreated?.(session, choice);
              if (input.remember) rememberChoice?.(choice);
              setSessions((current) => [
                session,
                ...current.filter((item) => item.id !== session.id),
              ]);
              setSelectedId(session.id);
              setNewSessionRequest(null);
            })
            .catch((error: unknown) => {
              throw new Error(humanErrorMessage(error));
            });
        // A worktree takes a moment, and a setup script as long as it takes: the session shows at
        // once as one that is starting, the way a GJC session does, and the dialog is not held.
        const draftId = `draft-${crypto.randomUUID()}`;
        const draft: AgentSession = {
          id: draftId,
          title: input.title,
          subtitle: `${directoryName(input.workspace)} · ${t("worktree 준비 중…")}`,
          workspace: input.workspace,
          runtime: "gjc",
          status: "starting",
          updatedAt: "now",
          updatedAtMs: Date.now(),
          pinned: false,
          unread: false,
          accent: "#ff8a34",
          ownership: "gajae",
          attachment: "attached",
        };
        setSessions((current) => [draft, ...current]);
        setSelectedId(draftId);
        setTranscripts((current) => cacheTranscript(current, draftId, []));
        setNewSessionRequest(null);
        const creation = backend.createSession(request);
        pendingSessions.current.set(draftId, creation);
        void creation
          .then((session) => {
            onTerminalCreated?.(session, choice);
            if (input.remember) rememberChoice?.(choice);
            setSessions((current) => [
              session,
              ...current.filter((item) => item.id !== draftId && item.id !== session.id),
            ]);
            setSelectedId((current) => (current === draftId ? session.id : current));
            setTranscripts((current) => {
              const next = { ...current };
              delete next[draftId];
              return next;
            });
            // The session is open either way; this only says its new worktree is not as asked.
            if (session.worktreeSetup) setAppError(worktreeSetupMessage(session.worktreeSetup));
          })
          .catch((error: unknown) => {
            setSessions((current) =>
              current.map((session) => (session.id === draftId ? { ...session, status: "failed" } : session)),
            );
            setAppError(humanErrorMessage(error));
          });
        return;
      }
      if (input.remember) rememberChoice?.({ agentKind: "gjc", surface: "chat" });
      const draftId = `draft-${crypto.randomUUID()}`;
      const draft: AgentSession = {
        id: draftId,
        title: input.title,
        subtitle: directoryName(input.workspace),
        workspace: input.workspace,
        runtime: "gjc",
        status: "starting",
        updatedAt: "now",
        updatedAtMs: Date.now(),
        pinned: false,
        unread: false,
        accent: "#ff8a34",
        ownership: "gajae",
        attachment: "attached",
      };
      setSessions((current) => [draft, ...current]);
      setSelectedId(draftId);
      setTranscripts((current) => cacheTranscript(current, draftId, []));
      setNewSessionRequest(null);
      setAppError("");

      const creation = backend.createSession({
        runtime: "gjc",
        title: input.title,
        workspace: input.workspace,
        isolation: input.isolation ?? "workspace",
        worktreeBranch: input.worktreeBranch,
        ...(input.worktreeBranchExisting ? { worktreeBranchExisting: true } : {}),
        ...(input.worktreePull ? { worktreePull: input.worktreePull } : {}),
        ...(input.workLink ? { workLink: input.workLink } : {}),
      });
      pendingSessions.current.set(draftId, creation);
      void creation
        .then((session) => {
          // Only the real id outlives this draft, so the prompt waits for it.
          // It is never sent from here: the user reads it and presses send.
          if (input.initialPrompt || input.initialImages)
            prefillComposerDraft(
              session.id,
              input.initialPrompt ?? "",
              input.initialImages,
            );
          setSessions((current) => [
            session,
            ...current.filter(
              (item) => item.id !== draftId && item.id !== session.id,
            ),
          ]);
          setSelectedId((current) =>
            current === draftId ? session.id : current,
          );
          setTranscripts((current) => {
            const next = { ...current };
            const items = current[session.id] ?? current[draftId] ?? [];
            delete next[draftId];
            return cacheTranscript(next, session.id, items);
          });
          // The session is open either way; this only says its new worktree is not as asked.
          if (session.worktreeSetup) setAppError(worktreeSetupMessage(session.worktreeSetup));
        })
        .catch((error) => {
          setSessions((current) =>
            current.map((session) =>
              session.id === draftId
                ? { ...session, status: "failed" }
                : session,
            ),
          );
          setAppError(humanErrorMessage(error));
        });
    },
    [backend],
  );

  return createSession;
}
