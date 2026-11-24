/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (shared/launch-rules.ts): the effort levels each CLI takes and the model-name rule.
 */
import type { AgentKindId } from "./agent-contract.js";

/** What a terminal agent session may be started with, beyond its program. */
export interface AgentLaunchOptions {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/** Claude Code's `--effort` levels, as `claude --help` lists them (2.1.311). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Claude Code's `--permission-mode` values Gajae offers. */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
/** Codex's `model_reasoning_effort` levels (developers.openai.com/codex/config-reference). */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * A model name as the CLIs take it after `--model`: one word that never reads as a flag, with an
 * optional bracketed variant such as Claude Code's `[1m]` context window (`opus[1m]`).
 */
export const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]*(?:\[[A-Za-z0-9]+\])?$/u;

const FIELDS = ["model", "effort", "permissionMode"] as const;

/** What each agent takes, by option; an agent missing from here takes none. */
const SUPPORTED: Partial<Record<AgentKindId, Partial<Record<(typeof FIELDS)[number], readonly string[] | "model">>>> = {
  claude: { model: "model", effort: CLAUDE_EFFORTS, permissionMode: CLAUDE_PERMISSION_MODES },
  codex: { model: "model", effort: CODEX_EFFORTS },
  omp: { model: "model" },
};

/**
 * What is wrong with `options` for `agentKind`, in plain words; null when they can start it.
 * Only known fields with values the agent takes pass: nothing else reaches a command line.
 */
export function launchOptionsFault(agentKind: AgentKindId, options: unknown): string | null {
  if (options === undefined || options === null) return null;
  if (typeof options !== "object" || Array.isArray(options)) return "Launch options must be an object";
  const supported = SUPPORTED[agentKind] ?? {};
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!(FIELDS as readonly string[]).includes(key)) return `Unknown launch option: ${key}`;
    const rule = supported[key as (typeof FIELDS)[number]];
    if (!rule) return `${agentKind} does not take ${key}`;
    if (typeof value !== "string" || value.length === 0 || value.length > 100)
      return `${key} must be a short string`;
    if (rule === "model" ? !MODEL_NAME.test(value) : !rule.includes(value))
      return `${key} ${JSON.stringify(value)} is not one ${agentKind} takes`;
  }
  return null;
}

/** The launch options with only what passed {@link launchOptionsFault}; throws on anything else. */
export function launchOptions(agentKind: AgentKindId, options: unknown): AgentLaunchOptions | undefined {
  const fault = launchOptionsFault(agentKind, options);
  if (fault) throw new Error(fault);
  if (!options) return undefined;
  const picked: AgentLaunchOptions = {};
  for (const key of FIELDS) {
    const value = (options as Record<string, unknown>)[key];
    if (typeof value === "string") picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** The arguments the options become on `agentKind`'s command line. */
export function launchArgs(agentKind: AgentKindId, options: AgentLaunchOptions | undefined): string[] {
  if (!options) return [];
  const args: string[] = [];
  if (agentKind === "claude") {
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  } else if (agentKind === "codex") {
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
  } else if (agentKind === "omp") {
    if (options.model) args.push(`--model=${options.model}`);
  }
  return args;
}
