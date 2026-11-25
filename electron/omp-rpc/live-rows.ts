import type {
  AgentEvent,
  ChatMessage,
  NoticeActivity,
  ThoughtActivity,
  ToolActivity,
  TranscriptItem,
} from "../../shared/agent-contract.js";
import {
  bounded,
  callIdPart,
  clockLabel,
  record,
  resultText,
  string,
  toolRow,
  toolSummary,
  TranscriptRows,
  type Row,
} from "../herdr-core/transcript/transcript-records.js";
import { transcriptItemEqual } from "../../shared/transcript-item-equal.js";
import type { RpcFrame } from "./rpc-client.js";

/** A tool call omp is running or has asked about, as the approvals pair a select with it. */
export interface LiveToolCall {
  callId: string;
  rowId: string;
  name: string;
  input: Row;
  /** When omp started executing it (`tool_execution_start`); unset while it is only being written. */
  startedAt?: number;
  endedAt?: number;
}

const FINAL_TOOL_STATUSES: ReadonlySet<ToolActivity["status"]> = new Set(["completed", "failed", "cancelled", "denied"]);

/**
 * The rows of the turn omp is streaming now, built from its RPC events (design §10) into the
 * chat's own row shapes, and the events the window hears as they change.
 *
 * Ids: a tool row is `<session>:<call id>` exactly as the session-file reader names it, so a
 * card keeps its place when the turn is read back from the file. Text, thinking and prompts carry
 * omp's live `messageId` (`<session>:live:msg-3:0`), which exists only in this process; once
 * the turn ends the controller replaces them with the file's rows.
 *
 * omp's `message_start` already carries text the deltas after it repeat (P0), so a message is
 * built from `*_start`/`*_delta` and settled by `*_end` and `message_end`, which are whole.
 */
export class OmpLiveRows {
  private rows: TranscriptItem[] = [];
  private readonly index = new Map<string, number>();
  private readonly helper: TranscriptRows;
  private readonly tools = new Map<string, LiveToolCall>();
  /** When each thinking block began, so its duration can be told (P6). */
  private readonly thinkingStarted = new Map<string, number>();

  constructor(
    readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.helper = new TranscriptRows(sessionId);
  }

  items(): TranscriptItem[] {
    return this.rows.slice();
  }

  get size(): number {
    return this.rows.length;
  }

  get(id: string): TranscriptItem | undefined {
    const at = this.index.get(id);
    return at === undefined ? undefined : this.rows[at];
  }

  /** Tool calls started and not finished, oldest first: what an approval can be about. */
  runningTools(): LiveToolCall[] {
    return [...this.tools.values()].filter((call) => call.startedAt !== undefined && call.endedAt === undefined);
  }

  tool(callId: string): LiveToolCall | undefined {
    return this.tools.get(callId);
  }

  /** The tool call whose input is `input` among the ones being written or run, newest first. */
  findTool(match: (call: LiveToolCall) => boolean): LiveToolCall | undefined {
    return [...this.tools.values()].reverse().find(match);
  }

  /** Applies one RPC frame; returns what the window should hear. */
  apply(frame: RpcFrame): AgentEvent[] {
    switch (frame.type) {
      case "message_start":
        return this.messageStart(frame);
      case "message_update":
        return this.messageUpdate(frame);
      case "message_end":
        return this.messageEnd(frame);
      case "tool_execution_start":
        return this.toolStart(frame);
      case "tool_execution_update":
        return this.toolProgress(frame);
      case "tool_execution_end":
        return this.toolEnd(frame);
      default:
        return [];
    }
  }

  /** Puts a row of the controller's own (a card, a notice) at the end, or replaces it in place. */
  put(item: TranscriptItem): AgentEvent[] {
    const known = this.index.has(item.id);
    this.set(item);
    if (item.kind === "tool" && known) return [{ type: "tool.updated", tool: item }];
    if (item.kind === "question") return [{ type: "question.updated", question: item }];
    return [{ type: "transcript.appended", item }];
  }

  /** Changes a tool row (an approval's state), keeping the rest of it. */
  updateTool(rowId: string, change: (tool: ToolActivity) => ToolActivity): AgentEvent[] {
    const current = this.get(rowId);
    if (current?.kind !== "tool") return [];
    const next = change(current);
    if (next === current || transcriptItemEqual(next, current)) return [];
    this.set(next);
    return [{ type: "tool.updated", tool: next }];
  }

  /** The turn ended without finishing these calls (an abort, omp ending): they will not report. */
  cancelOpenTools(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const call of this.tools.values()) {
      if (call.endedAt !== undefined) continue;
      call.endedAt = this.now();
      events.push(
        ...this.updateTool(call.rowId, (tool) =>
          FINAL_TOOL_STATUSES.has(tool.status) ? tool : { ...withoutOptions(tool), status: "cancelled" },
        ),
      );
    }
    return events;
  }

  /** Keeps only the rows `keep` says the session file does not hold, and forgets the turn. */
  retain(keep: (item: TranscriptItem) => boolean): void {
    this.rows = this.rows.filter(keep);
    this.reindex();
    for (const [callId, call] of this.tools) if (!this.index.has(call.rowId) || call.endedAt !== undefined) this.tools.delete(callId);
    this.thinkingStarted.clear();
  }

  clear(): void {
    this.rows = [];
    this.index.clear();
    this.tools.clear();
    this.thinkingStarted.clear();
  }

  // ---- messages

  private messageStart(frame: RpcFrame): AgentEvent[] {
    const message = record(frame.message);
    const messageId = string(frame.messageId);
    if (!messageId) return [];
    if (message.role === "user") return this.userMessage(messageId, message);
    if (message.role === "toolResult") return this.toolResult(message);
    // an assistant's opening snapshot can run ahead of its deltas: its blocks come from them
    return [];
  }

  private userMessage(messageId: string, message: Row): AgentEvent[] {
    const blocks = Array.isArray(message.content) ? message.content.map(record) : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    const text = blocks
      .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    const pictures = blocks.filter((block) => block.type === "image").length;
    const content = text || (pictures === 1 ? "[image]" : pictures > 1 ? `[${pictures} images]` : "");
    if (!content) return [];
    const id = this.liveId(messageId);
    if (this.index.has(id)) return [];
    const row: ChatMessage = {
      id,
      kind: "message",
      sessionId: this.sessionId,
      role: "user",
      content,
      createdAt: clockLabel(message.timestamp),
      streaming: false,
    };
    this.set(row);
    return [{ type: "transcript.appended", item: row }];
  }

  private messageUpdate(frame: RpcFrame): AgentEvent[] {
    const messageId = string(frame.messageId);
    const event = record(frame.assistantMessageEvent);
    if (!messageId || record(frame.message).role !== "assistant") return [];
    const index = typeof event.contentIndex === "number" ? event.contentIndex : undefined;
    const type = string(event.type);
    if (index === undefined || !type) return [];
    const id = this.liveId(messageId, index);
    switch (type) {
      case "text_start":
        return this.ensureText(id, "").events;
      case "text_delta": {
        const delta = string(event.delta) ?? "";
        const { row, events } = this.ensureText(id, "");
        if (!delta) return events;
        this.set({ ...row, content: row.content + delta, streaming: true });
        return [...events, { type: "message.delta", sessionId: this.sessionId, messageId: id, delta, streaming: true }];
      }
      case "text_end": {
        const content = string(event.content);
        const { row, events } = this.ensureText(id, "");
        const settled: ChatMessage = { ...row, content: content ?? row.content, streaming: false };
        this.set(settled);
        return [...events, { type: "message.updated", message: settled }];
      }
      case "thinking_start":
        this.thinkingStarted.set(id, this.now());
        return this.ensureThought(id, "").events;
      case "thinking_delta": {
        const delta = string(event.delta) ?? "";
        const { row, events } = this.ensureThought(id, "");
        if (!delta) return events;
        this.set({ ...row, content: row.content + delta, streaming: true });
        return [...events, { type: "thought.delta", sessionId: this.sessionId, thoughtId: id, delta, streaming: true }];
      }
      case "thinking_end": {
        const content = string(event.content);
        const { row } = this.ensureThought(id, "");
        const began = this.thinkingStarted.get(id);
        const settled: ThoughtActivity = { ...row, content: content ?? row.content, streaming: false, ...(began !== undefined ? { durationMs: Math.max(0, this.now() - began) } : {}) };
        this.set(settled);
        return [{ type: "transcript.appended", item: settled }];
      }
      case "toolcall_start": {
        const block = record(event.block);
        return this.noteToolCall(block, false);
      }
      case "toolcall_end":
        return this.noteToolCall(record(event.toolCall), true);
      default:
        return [];
    }
  }

  private messageEnd(frame: RpcFrame): AgentEvent[] {
    const message = record(frame.message);
    const messageId = string(frame.messageId);
    if (!messageId) return [];
    if (message.role === "user") return this.userMessage(messageId, message);
    if (message.role === "toolResult") return this.toolResult(message);
    if (message.role !== "assistant") return [];
    const events: AgentEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((value, index) => {
      const block = record(value);
      const id = this.liveId(messageId, index);
      if (block.type === "text" && typeof block.text === "string") {
        if (!block.text && !this.index.has(id)) return;
        const { row, events: created } = this.ensureText(id, block.text, message.timestamp);
        const settled: ChatMessage = { ...row, content: block.text, streaming: false };
        this.set(settled);
        events.push(...created, { type: "message.updated", message: settled });
      } else if (block.type === "thinking") {
        const text = [block.thinking, block.text, block.summary].map(resultText).find((part) => part.trim().length > 0) ?? "";
        if (!text && !this.index.has(id)) return;
        const { row } = this.ensureThought(id, text, message.timestamp);
        const began = this.thinkingStarted.get(id);
        const settled: ThoughtActivity = {
          ...row,
          content: text || row.content,
          streaming: false,
          ...(row.durationMs === undefined && began !== undefined ? { durationMs: Math.max(0, this.now() - began) } : {}),
        };
        this.set(settled);
        events.push({ type: "transcript.appended", item: settled });
      } else if (block.type === "toolCall") {
        events.push(...this.noteToolCall(block, true));
      }
    });
    if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage)
      events.push(...this.notice(this.liveId(messageId, "error"), "작업 실패", message.errorMessage, "warning", message.timestamp));
    else if (message.stopReason === "aborted") {
      events.push(...this.cancelOpenTools());
      events.push(...this.notice(this.liveId(messageId, "aborted"), "작업 취소됨", typeof message.errorMessage === "string" ? message.errorMessage : "", "warning", message.timestamp));
    }
    return events;
  }

  private notice(id: string, title: string, content: string, tone: NoticeActivity["tone"], timestamp: unknown): AgentEvent[] {
    const row: NoticeActivity = { id, kind: "notice", sessionId: this.sessionId, title, content, tone, createdAt: clockLabel(timestamp) };
    this.set(row);
    return [{ type: "transcript.appended", item: row }];
  }

  private ensureText(id: string, content: string, timestamp?: unknown): { row: ChatMessage; events: AgentEvent[] } {
    const known = this.get(id);
    if (known?.kind === "message") return { row: known, events: [] };
    const row: ChatMessage = {
      id,
      kind: "message",
      sessionId: this.sessionId,
      role: "assistant",
      content,
      createdAt: clockLabel(timestamp ?? this.now()),
      streaming: true,
    };
    this.set(row);
    return { row, events: [{ type: "transcript.appended", item: row }] };
  }

  private ensureThought(id: string, content: string, timestamp?: unknown): { row: ThoughtActivity; events: AgentEvent[] } {
    const known = this.get(id);
    if (known?.kind === "thought") return { row: known, events: [] };
    const row: ThoughtActivity = {
      id,
      kind: "thought",
      sessionId: this.sessionId,
      content,
      createdAt: clockLabel(timestamp ?? this.now()),
      streaming: true,
    };
    this.set(row);
    return { row, events: [{ type: "transcript.appended", item: row }] };
  }

  // ---- tools

  /** A tool call omp wrote (being written, or whole): its row, waiting to run. */
  private noteToolCall(block: Row, whole: boolean): AgentEvent[] {
    const callId = string(block.id, block.toolCallId);
    const name = string(block.name, block.toolName);
    if (!callId || !name) return [];
    const input = whole ? record(block.arguments) : {};
    const rowId = this.helper.id(callIdPart(callId));
    const known = this.tools.get(callId);
    this.tools.set(callId, { ...(known ?? {}), callId, rowId, name, input: whole ? input : (known?.input ?? {}) });
    const current = this.get(rowId);
    if (current?.kind === "tool") {
      if (!whole) return [];
      const fresh = this.toolRow(rowId, name, input, current.createdAt);
      return this.updateTool(rowId, (tool) => ({ ...fresh, status: tool.status, ...(tool.output ? { output: tool.output } : {}), ...(tool.permissionOptions ? { permissionOptions: tool.permissionOptions } : {}) }));
    }
    const row: ToolActivity = { ...this.toolRow(rowId, name, input), status: "pending" };
    this.set(row);
    return [{ type: "transcript.appended", item: row }];
  }

  private toolStart(frame: RpcFrame): AgentEvent[] {
    const callId = string(frame.toolCallId);
    const name = string(frame.toolName);
    if (!callId || !name) return [];
    const input = frame.args !== undefined ? record(frame.args) : (this.tools.get(callId)?.input ?? {});
    const rowId = this.helper.id(callIdPart(callId));
    this.tools.set(callId, { callId, rowId, name, input, startedAt: this.now() });
    const current = this.get(rowId);
    if (current?.kind !== "tool") {
      const row: ToolActivity = this.toolRow(rowId, name, input);
      this.set(row);
      return [{ type: "transcript.appended", item: row }];
    }
    // an approval card already on it keeps its question; otherwise the call now runs
    return this.updateTool(rowId, (tool) => (tool.status === "approval-required" || FINAL_TOOL_STATUSES.has(tool.status) ? tool : { ...tool, status: "running" }));
  }

  private toolProgress(frame: RpcFrame): AgentEvent[] {
    const callId = string(frame.toolCallId);
    if (!callId) return [];
    const call = this.tools.get(callId);
    if (!call) return [];
    const output = resultText(record(frame.partialResult).content);
    if (!output) return [];
    return this.updateTool(call.rowId, (tool) =>
      FINAL_TOOL_STATUSES.has(tool.status) || tool.output === bounded(output)
        ? tool
        : { ...tool, status: tool.status === "approval-required" ? tool.status : "running", output: bounded(output) },
    );
  }

  private toolEnd(frame: RpcFrame): AgentEvent[] {
    const callId = string(frame.toolCallId);
    if (!callId) return [];
    const result = record(frame.result);
    return this.finishTool(callId, result.content, frame.isError === true, record(result.details));
  }

  private toolResult(message: Row): AgentEvent[] {
    const callId = string(message.toolCallId);
    if (!callId) return [];
    return this.finishTool(callId, message.content, message.isError === true, record(message.details));
  }

  private finishTool(callId: string, content: unknown, failed: boolean, details: Row = {}): AgentEvent[] {
    const call = this.tools.get(callId);
    if (!call) return [];
    if (call.endedAt === undefined) call.endedAt = this.now();
    const output = resultText(content);
    const facts = toolResultFacts(details, call.startedAt !== undefined ? call.endedAt - call.startedAt : undefined);
    return this.updateTool(call.rowId, (tool) => {
      const status: ToolActivity["status"] = tool.status === "denied" ? "denied" : failed ? "failed" : "completed";
      return { ...withoutOptions(tool), status, ...(output ? { output: bounded(output) } : {}), ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}), ...facts };
    });
  }

  private toolRow(rowId: string, name: string, input: Row, createdAt?: string): ToolActivity {
    const summary = typeof input.intent === "string" && input.intent.length > 0 ? input.intent.slice(0, 120) : toolSummary(name, input);
    const row = toolRow(this.helper, rowId, name, input, summary, this.now());
    return createdAt ? { ...row, createdAt } : row;
  }

  // ---- rows

  private liveId(messageId: string, index?: number | string): string {
    return index === undefined ? this.helper.id("live", messageId) : this.helper.id("live", messageId, index);
  }

  private set(item: TranscriptItem): void {
    const at = this.index.get(item.id);
    if (at === undefined) {
      this.index.set(item.id, this.rows.length);
      this.rows.push(item);
    } else this.rows[at] = item;
  }

  private reindex(): void {
    this.index.clear();
    this.rows.forEach((item, at) => this.index.set(item.id, at));
  }
}

/**
 * What a tool result's details add to its row: how long it ran (the bash tool's `wallTimeMs`, else
 * the time between its start and end) and an edit's diff and file (omp 19.1.1 edit `details.diff`).
 */
export function toolResultFacts(details: Row, measuredMs?: number): Pick<ToolActivity, "durationMs" | "diff" | "targetPath"> {
  const wall = typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs) ? details.wallTimeMs : undefined;
  const duration = wall ?? (measuredMs !== undefined && measuredMs >= 0 ? measuredMs : undefined);
  const diff = typeof details.diff === "string" && details.diff.trim().length > 0 ? bounded(details.diff) : undefined;
  const target = typeof details.path === "string" && details.path.length > 0 ? details.path : undefined;
  return {
    ...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
    ...(diff ? { diff } : {}),
    ...(diff && target ? { targetPath: target } : {}),
  };
}

function withoutOptions(tool: ToolActivity): ToolActivity {
  if (!tool.permissionOptions) return tool;
  const { permissionOptions: _options, ...rest } = tool;
  return rest;
}

/** Whether a row exists only while omp streams it (`<session>:live:…`), and not in the session file. */
export function isLiveRowId(sessionId: string, id: string): boolean {
  return id.startsWith(`${sessionId}:live:`);
}
