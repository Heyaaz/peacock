import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { launchArgs } from "../../shared/agent-launch.js";
import type { AgentKindId } from "../../shared/agent-contract.js";
import type { AgentAvailability, TerminalSessionRecord } from "../../shared/terminal-ipc.js";
import { loginShellPlan, type LoginShellCommand } from "../terminal-shell.js";
import { claudeTranscriptPath } from "./claude-session.js";

/** What a session's terminal runs: an absolute program, its arguments, and what goes on top of the core's env. */
export interface LaunchPlan {
  argv: string[];
  env?: Record<string, string>;
  /** The agent's own session id this launch uses, when Gajae chose it. */
  agentSessionRef?: string;
}

export interface LaunchDependencies {
  detect(id: AgentKindId): Promise<AgentAvailability>;
  /** Claude Code's `--settings` with Gajae's hooks (agent-hooks.ts), when the channel is up. */
  claudeSettingsPath?: string;
  /** omp's approval extension (agent-hooks.ts), when the channel is up and the omp takes it. */
  ompExtensionPath?: string;
  home: string;
  shell?: () => LoginShellCommand | undefined;
  exists?: (file: string) => Promise<boolean>;
  newRef?: () => string;
}

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * The command a terminal session starts. Claude Code gets a session id Gajae chose
 * (`--session-id`) and the hook settings; a session whose transcript exists resumes it instead,
 * the way a new terminal continues an agent whose terminal ended (design §4). omp resumes the
 * transcript Gajae found it writing (`--resume <file>`), so the chat keeps its rows, with Gajae's
 * approval extension (`-e <file>`); codex starts without hooks. Every agent learns its Gajae session
 * from `GAJAE_SESSION_ID`, which its hooks hand back.
 */
export async function planAgentLaunch(record: TerminalSessionRecord, deps: LaunchDependencies): Promise<LaunchPlan> {
  const agentKind = record.agentKind ?? "shell";
  if (agentKind === "shell") {
    const shell = (deps.shell ?? (() => loginShellPlan()[0]))();
    if (!shell) throw new Error("No login shell to run");
    return { argv: [shell.file, ...shell.args] };
  }
  if (agentKind === "gjc") throw new Error("GJC runs in the chat, not in a terminal session");
  const agent = await deps.detect(agentKind);
  if (!agent.installed || !agent.binary) throw new Error(`${agent.name}: ${agent.reason ?? "not installed"}`);
  const env = { GAJAE_SESSION_ID: record.id };
  const options = launchArgs(agentKind, record.launch);
  const exists = deps.exists ?? fileExists;
  if (agentKind === "omp") {
    const transcript = record.transcriptPath;
    const resume = transcript !== undefined && (await exists(transcript));
    return {
      argv: [
        agent.binary,
        ...(deps.ompExtensionPath ? ["-e", deps.ompExtensionPath] : []),
        ...(resume ? ["--resume", transcript] : []),
        ...options,
      ],
      env,
    };
  }
  if (agentKind !== "claude") return { argv: [agent.binary, ...options], env };
  const known = record.agentSessionRef;
  const transcript = known ? (record.transcriptPath ?? claudeTranscriptPath(record.workspace, known, deps.home)) : undefined;
  const resume = known !== undefined && transcript !== undefined && (await exists(transcript));
  const agentSessionRef = known ?? (deps.newRef ?? randomUUID)();
  return {
    argv: [
      agent.binary,
      ...(resume ? ["--resume", agentSessionRef] : ["--session-id", agentSessionRef]),
      ...(deps.claudeSettingsPath ? ["--settings", deps.claudeSettingsPath] : []),
      ...options,
    ],
    env,
    agentSessionRef,
  };
}
