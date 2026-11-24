import type {
  PermissionOption,
  ToolActivity,
  ToolDecision,
  TranscriptItem,
} from "../../shared/agent-contract.js";
import { normalizeRulePrefix, type CommandRuleDecision, type CommandRuleMatch } from "../../shared/command-rules.js";
import { permissionOptionLabel } from "../../shared/permission-options.js";
import { APPROVAL_WAIT_SECONDS, type HookChannel } from "./agent-hooks.js";
import {
  bounded,
  callIdPart,
  record,
  resultText,
  string,
  toolRow,
  toolSummary,
  TranscriptRows,
  type Row,
} from "./transcript/transcript-records.js";

/** A terminal agent's approval offers what its hook can answer: this once, yes or no (design §5.6). */
export const APPROVAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "reject_once", kind: "reject_once", name: "Reject" },
];

/** A tool row the approvals lay over the transcript's: a card waiting, or how one was decided. */
export interface ApprovalOverlay {
  row: ToolActivity;
  /** The row the card follows when the transcript has no row of its own for the call. */
  afterId?: string;
  /** Let go with no decision: the transcript's own row says how it went. */
  released?: boolean;
}

/** Why a waiting approval was let go without Gajae's decision. */
export type ReleaseReason = "ran" | "answered" | "stopped" | "closed" | "timeout" | "ended";

interface Pending {
  toolId: string;
  sessionId: string;
  /** The tool's own name (Claude Code's `Bash`, omp's `bash`). */
  toolName: string;
  input: Row;
  channel: HookChannel;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

interface RecentCall {
  callId: string;
  toolName: string;
  key: string;
  at: number;
  paired: boolean;
}

export interface HerdrApprovalsOptions {
  /** Project command rules, applied before a card is shown (GJC's own store). */
  commandRules?: {
    decide(projectPath: string, toolName: string, command: string): Promise<CommandRuleMatch | undefined>;
    add(projectPath: string, prefix: string, decision: CommandRuleDecision): Promise<void>;
  };
  workspaceOf(sessionId: string): string | undefined;
  /** The last row the session's chat has now, for placing a card the transcript has no row for. */
  lastRowId(sessionId: string): string | undefined;
  /** The session's cards changed. */
  changed(sessionId: string): void;
  waitMs?: number;
  now?: () => number;
}

/** How long a PreToolUse is kept for pairing with its approval. */
const PAIRING_MS = 2 * 60_000;
const RECENT_CALLS = 32;
const OVERLAYS_KEPT = 64;
const FINAL_STATUSES: ReadonlySet<ToolActivity["status"]> = new Set(["completed", "failed", "denied", "cancelled"]);

/** What a tool printed, from PostToolUse's `tool_response` (Bash: its stdout and stderr). */
function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  const value = record(response);
  const streams = [value.stdout, value.stderr].filter((text): text is string => typeof text === "string" && text.length > 0);
  if (streams.length > 0) return streams.join("\n");
  return resultText(value.content ?? response);
}

/** A value as JSON with object keys in order, so the same input reads the same however it was built. */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as Row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey((value as Row)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The hook's answer: Claude Code's PermissionRequest output, which omp's extension reads too. */
export function approvalAnswer(decision: "allow" | "deny", comment?: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision:
        decision === "allow"
          ? { behavior: "allow" }
          : // with words for the agent it goes on with them; without, it stops as at the terminal's No
            { behavior: "deny", message: comment || "The user declined this tool call in Gajae.", interrupt: !comment },
    },
  });
}

/**
 * Tool approvals of terminal agents (design §5.6). An agent's hook asks (Claude Code's
 * PermissionRequest, omp's extension) and waits on its connection; the project's command rules
 * answer first, else the request becomes a card (a tool row waiting for approval, laid over the
 * transcript's own row for the call) that the window or a phone answers. Claude Code's request names
 * no call, so it is paired with the latest PreToolUse of the same tool and input.
 *
 * The agent's own dialog stays up meanwhile, and an answer there wins too: the card is let go when
 * the tool runs (PostToolUse), the transcript records its result, the dialog closes (herdr-core's
 * status leaves blocked), the turn stops, the hook goes away, or Gajae's wait runs out.
 */
export class HerdrApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly recent = new Map<string, RecentCall[]>();
  private readonly overlays = new Map<string, Map<string, ApprovalOverlay>>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(private readonly options: HerdrApprovalsOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A tool call about to run (Claude Code's PreToolUse): what its approval is paired with. */
  notePreToolUse(sessionId: string, payload: Row): void {
    const callId = string(payload.tool_use_id);
    const toolName = string(payload.tool_name);
    if (!callId || !toolName) return;
    const now = this.now();
    const calls = (this.recent.get(sessionId) ?? []).filter((call) => now - call.at < PAIRING_MS);
    calls.push({ callId, toolName, key: stableKey(payload.tool_input ?? {}), at: now, paired: false });
    this.recent.set(sessionId, calls.slice(-RECENT_CALLS));
  }

  /** A tool call that ran (PostToolUse): its approval was given, here or at the terminal. */
  notePostToolUse(sessionId: string, payload: Row): void {
    const callId = string(payload.tool_use_id);
    if (!callId) return;
    const toolId = `${sessionId}:${callIdPart(callId)}`;
    this.recent.set(sessionId, (this.recent.get(sessionId) ?? []).filter((call) => call.callId !== callId));
    this.release(toolId, "ran");
    // a card with no transcript row of its own (a call made inside another, as Code Mode makes them)
    // shows what the call printed, as its row would
    const overlay = this.overlays.get(sessionId)?.get(toolId);
    if (!overlay || !["approved", "completed"].includes(overlay.row.status)) return;
    const output = responseText(payload.tool_response);
    this.lay(sessionId, { ...overlay, row: { ...overlay.row, status: "completed", ...(output ? { output: bounded(output) } : {}) } });
  }

  /** An approval the agent's hook asks, answered on `channel`. */
  async request(sessionId: string, payload: Row, channel: HookChannel): Promise<void> {
    const toolName = string(payload.tool_name);
    if (!toolName) {
      channel.reply("");
      return;
    }
    const input = record(payload.tool_input);
    const callId = string(payload.tool_use_id) ?? this.pairedCall(sessionId, toolName, input) ?? `approval-${++this.sequence}`;
    const toolId = `${sessionId}:${callIdPart(callId)}`;
    // a request asked again for the same call replaces the one before it
    this.release(toolId, "answered");
    const row = this.row(sessionId, toolId, toolName, input);
    const afterId = this.options.lastRowId(sessionId);
    const command = row.name === "bash" && typeof input.command === "string" ? input.command : undefined;
    const workspace = this.options.workspaceOf(sessionId);
    if (command !== undefined && workspace && this.options.commandRules) {
      let match: CommandRuleMatch | undefined;
      try {
        match = await this.options.commandRules.decide(workspace, "bash", command);
      } catch {
        match = undefined;
      }
      if (match) {
        channel.reply(approvalAnswer(match.decision === "allow" ? "allow" : "deny"));
        this.lay(sessionId, {
          row: { ...row, status: match.decision === "allow" ? "approved" : "denied", autoDecision: match },
          ...(afterId ? { afterId } : {}),
        });
        return;
      }
    }
    if (channel.closed) return;
    const pending: Pending = {
      toolId,
      sessionId,
      toolName,
      input,
      channel,
      at: this.now(),
      timer: setTimeout(() => this.release(toolId, "timeout"), this.options.waitMs ?? APPROVAL_WAIT_SECONDS * 1000),
    };
    pending.timer.unref?.();
    this.pending.set(toolId, pending);
    channel.onClose(() => this.release(toolId, "closed"));
    this.lay(sessionId, {
      row: { ...row, status: "approval-required", permissionOptions: [...APPROVAL_OPTIONS] },
      ...(afterId ? { afterId } : {}),
    });
  }

  owns(toolId: string): boolean {
    return this.pending.has(toolId);
  }

  decisionInfo(toolId: string, decision: ToolDecision): { name: string; requiresConfirmation: boolean } {
    const { option } = this.choice(toolId, decision);
    const allows = option.kind.startsWith("allow");
    const label = permissionOptionLabel(option);
    return {
      name:
        decision.rule && allows
          ? `${label}\n"${decision.rule.prefix}"로 시작하는 명령은 이 프로젝트에서 앞으로 묻지 않고 허용합니다.`
          : label,
      requiresConfirmation: allows,
    };
  }

  /**
   * Answers the hook, and with `decision.rule` remembers the prefix for the session's project first.
   * A rule that cannot be saved must not leave the agent waiting, so the call is answered either way
   * and the save error is thrown afterwards.
   */
  async resolve(toolId: string, decision: ToolDecision): Promise<void> {
    const { pending, option } = this.choice(toolId, decision);
    const allows = option.kind.startsWith("allow");
    let ruleFailure: unknown;
    if (decision.rule) {
      try {
        const workspace = this.options.workspaceOf(pending.sessionId);
        const prefix = normalizeRulePrefix(decision.rule.prefix);
        if (!this.options.commandRules || !workspace) throw new Error("Command rules are unavailable for this session");
        if (this.row(pending.sessionId, toolId, pending.toolName, pending.input).name !== "bash")
          throw new Error("Command rules apply to bash calls only");
        if (!prefix) throw new Error("Command rule prefix is invalid");
        await this.options.commandRules.add(workspace, prefix, allows ? "allow" : "reject");
      } catch (error) {
        ruleFailure = error;
      }
    }
    if (this.pending.get(toolId) !== pending) throw new Error(`No pending permission for tool call ${toolId}`);
    this.pending.delete(toolId);
    clearTimeout(pending.timer);
    pending.channel.reply(approvalAnswer(allows ? "allow" : "deny", decision.comment));
    const overlay = this.overlays.get(pending.sessionId)?.get(toolId);
    if (overlay) {
      const { permissionOptions: _options, ...row } = overlay.row;
      this.lay(pending.sessionId, { ...overlay, row: { ...row, status: allows ? "approved" : "denied" } });
    }
    if (ruleFailure) throw ruleFailure;
  }

  /** Lets go of a waiting approval with no decision: the agent's dialog answers it. */
  release(toolId: string, reason: ReleaseReason): void {
    const pending = this.pending.get(toolId);
    if (!pending) return;
    this.pending.delete(toolId);
    clearTimeout(pending.timer);
    pending.channel.reply("");
    const overlay = this.overlays.get(pending.sessionId)?.get(toolId);
    if (!overlay) return;
    const { permissionOptions: _options, ...row } = overlay.row;
    // a card with no row of its own says how it ended: it ran, or it was answered elsewhere
    this.lay(pending.sessionId, { ...overlay, released: true, row: { ...row, status: reason === "ran" ? "completed" : "cancelled" } });
  }

  /** Lets go of a session's waiting approvals asked by `before` (all when it is absent). */
  releaseSession(sessionId: string, reason: ReleaseReason, before = Number.POSITIVE_INFINITY): void {
    for (const pending of [...this.pending.values()])
      if (pending.sessionId === sessionId && pending.at <= before) this.release(pending.toolId, reason);
  }

  /** The transcript's rows now: a call it shows finished was answered, here or at the terminal. */
  noteRows(sessionId: string, items: readonly TranscriptItem[]): void {
    const overlays = this.overlays.get(sessionId);
    if (!overlays?.size) return;
    let dropped = false;
    for (const item of items) {
      if (item.kind !== "tool" || !FINAL_STATUSES.has(item.status) || !overlays.has(item.id)) continue;
      this.release(item.id, "answered");
      overlays.delete(item.id);
      dropped = true;
    }
    if (dropped) this.options.changed(sessionId);
  }

  overlay(sessionId: string): ApprovalOverlay[] {
    return [...(this.overlays.get(sessionId)?.values() ?? [])];
  }

  hasPending(sessionId: string): boolean {
    for (const pending of this.pending.values()) if (pending.sessionId === sessionId) return true;
    return false;
  }

  forget(sessionId: string): void {
    this.releaseSession(sessionId, "ended");
    this.recent.delete(sessionId);
    this.overlays.delete(sessionId);
  }

  dispose(): void {
    for (const pending of [...this.pending.values()]) this.release(pending.toolId, "ended");
  }

  private choice(toolId: string, decision: ToolDecision): { pending: Pending; option: PermissionOption } {
    const pending = this.pending.get(toolId);
    if (!pending) throw new Error(`No pending permission for tool call ${toolId}`);
    const option = APPROVAL_OPTIONS.find((candidate) => candidate.optionId === decision.optionId);
    if (!option) throw new Error(`Unknown permission option ${decision.optionId}`);
    return { pending, option };
  }

  /** The latest PreToolUse of this tool with this input not yet paired, by its call id. */
  private pairedCall(sessionId: string, toolName: string, input: Row): string | undefined {
    const key = stableKey(input);
    const now = this.now();
    const calls = this.recent.get(sessionId) ?? [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index]!;
      if (call.paired || call.toolName !== toolName || call.key !== key || now - call.at >= PAIRING_MS) continue;
      call.paired = true;
      return call.callId;
    }
    return undefined;
  }

  private row(sessionId: string, toolId: string, toolName: string, input: Row): ToolActivity {
    return toolRow(new TranscriptRows(sessionId), toolId, toolName, input, toolSummary(toolName, input), new Date(this.now()).toISOString());
  }

  private lay(sessionId: string, overlay: ApprovalOverlay): void {
    if (process.env.GAJAE_DEBUG_HERDR)
      console.log(`[herdr approval] ${new Date().toISOString().slice(11, 23)} ${overlay.row.id} ${overlay.row.status}${overlay.released ? " released" : ""}`);
    const overlays = this.overlays.get(sessionId) ?? new Map<string, ApprovalOverlay>();
    overlays.delete(overlay.row.id);
    overlays.set(overlay.row.id, overlay);
    // the oldest settled cards go first; a waiting one is never dropped
    for (const [id, kept] of overlays) {
      if (overlays.size <= OVERLAYS_KEPT) break;
      if (!this.pending.has(id) && kept !== overlay) overlays.delete(id);
    }
    this.overlays.set(sessionId, overlays);
    this.options.changed(sessionId);
  }
}
