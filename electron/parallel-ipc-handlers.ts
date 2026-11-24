import { ipcMain } from "electron";
import { statSync } from "node:fs";
import path from "node:path";
import { isAgentKindId } from "../shared/agent-contract.js";
import { launchOptions, launchOptionsFault } from "../shared/agent-launch.js";
import {
  PARALLEL_AGENT_DEFAULT_MODEL,
  PARALLEL_ATTEMPT_MAX,
  PARALLEL_ATTEMPT_MIN,
  PARALLEL_PROMPT_LIMIT,
  parallelCleanupConfirmation,
  safeBranchName,
  safeModelPreset,
} from "../shared/parallel-run.js";
import { PARALLEL_IPC, type ParallelStartInput } from "../shared/parallel-ipc.js";
import { requiredId } from "./gjc-input-validation.js";
import type { IpcSecurity } from "./ipc-security.js";
import type { ParallelRunService } from "./parallel-run-service.js";

export function parallelStartInput(value: unknown): ParallelStartInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Parallel run input is required");
  const candidate = value as Record<string, unknown>;
  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : undefined;
  if (!title || title.length > 256) throw new Error("Parallel run title is invalid");
  const workspace = candidate.workspace;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace))
    throw new Error("Parallel run workspace must be an absolute directory");
  try {
    if (!statSync(workspace).isDirectory()) throw new Error();
  } catch {
    throw new Error("Parallel run workspace must be an existing directory");
  }
  const prompt =
    typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
  if (!prompt || prompt.length > PARALLEL_PROMPT_LIMIT)
    throw new Error("Parallel run needs a request to send");
  if (candidate.branch !== undefined && !safeBranchName(candidate.branch))
    throw new Error("Parallel run branch is invalid");
  const presets = candidate.presets;
  if (
    !Array.isArray(presets) ||
    presets.length < PARALLEL_ATTEMPT_MIN ||
    presets.length > PARALLEL_ATTEMPT_MAX ||
    !presets.every(safeModelPreset)
  )
    throw new Error(
      `Parallel run needs ${PARALLEL_ATTEMPT_MIN}-${PARALLEL_ATTEMPT_MAX} model presets`,
    );
  const agentKind = candidate.agentKind ?? "gjc";
  if (!isAgentKindId(agentKind)) throw new Error("Parallel run agent is invalid");
  if (agentKind === "gjc") {
    if (candidate.launch !== undefined) throw new Error("A GJC parallel run takes model presets, not launch options");
  } else {
    // a terminal agent's attempt runs a model of its own, or the agent's default
    for (const preset of presets as string[]) {
      const model = preset.trim();
      const fault = model === PARALLEL_AGENT_DEFAULT_MODEL ? undefined : launchOptionsFault(agentKind, { model });
      if (fault) throw new Error(fault);
    }
    if (candidate.launch !== undefined) {
      if (!candidate.launch || typeof candidate.launch !== "object" || Array.isArray(candidate.launch) || "model" in candidate.launch)
        throw new Error("Parallel run launch options are invalid");
      const fault = launchOptionsFault(agentKind, candidate.launch);
      if (fault) throw new Error(fault);
    }
  }
  const launch = agentKind !== "gjc" && candidate.launch !== undefined ? launchOptions(agentKind, candidate.launch) : undefined;
  return {
    title,
    workspace: path.resolve(workspace),
    prompt,
    ...(typeof candidate.branch === "string" ? { branch: candidate.branch } : {}),
    presets: presets.map((preset) => preset.trim()),
    ...(agentKind !== "gjc" ? { agentKind } : {}),
    ...(launch && Object.keys(launch).length > 0 ? { launch } : {}),
  };
}

export function registerParallelIpcHandlers(
  service: ParallelRunService,
  security: IpcSecurity,
): () => void {
  const handle = (channel: string, handler: (...args: any[]) => any): void => {
    ipcMain.handle(channel, security.guarded(handler));
  };
  handle(PARALLEL_IPC.list, () => service.list());
  handle(PARALLEL_IPC.agents, () => service.agents());
  handle(PARALLEL_IPC.start, (_event, input: unknown) =>
    service.start(parallelStartInput(input)),
  );
  handle(PARALLEL_IPC.adopt, (_event, groupId: unknown, attemptId: unknown) =>
    service.adopt(
      requiredId(groupId, "Parallel group ID"),
      requiredId(attemptId, "Attempt ID"),
    ),
  );
  handle(PARALLEL_IPC.discard, (_event, groupId: unknown) =>
    service.discard(requiredId(groupId, "Parallel group ID")),
  );
  handle(PARALLEL_IPC.cleanup, async (event, groupId: unknown) => {
    const id = requiredId(groupId, "Parallel group ID");
    const plan = await service.cleanupPlan(id);
    await security.authorizeDestructive(event, {
      ...parallelCleanupConfirmation(plan),
      confirmLabel: "정리",
      danger: true,
    });
    return service.cleanup(id, plan);
  });
  return () => {
    for (const channel of Object.values(PARALLEL_IPC))
      if (channel !== PARALLEL_IPC.changed) ipcMain.removeHandler(channel);
  };
}
