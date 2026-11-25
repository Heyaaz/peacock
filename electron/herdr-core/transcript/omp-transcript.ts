/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (server/transcript-records.ts, its omp path): reading an omp transcript
 * (`~/.omp/agent/sessions/<cwd>/<time>_<id>.jsonl`, pi's session format) into chat rows. OmO's
 * goals and tasks, skills and pictures are stubs here (design §5.5).
 *
 * Row ids hold only what the record itself says: a tool row is its call id, a text or thinking
 * block its entry id and block index, a prompt its entry id, each after the Gajae session id.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { ToolActivity } from "../../../shared/agent-contract.js";
import {
  bounded,
  callIdPart,
  clockLabel,
  isContextClear,
  messageRow,
  noticeRow,
  record,
  resultText,
  string,
  systemRow,
  thoughtRow,
  toolRow,
  toolSummary,
  TranscriptRows,
  type Row,
  type TranscriptParser,
} from "./transcript-records.js";

const AGENT_NAME = "omp";

/**
 * Internal IRC deliveries between panes, stored as custom messages with `attribution: "agent"`
 * (gjc 0.18.12, omp 18.8.7): another agent's traffic, not a notice to the person.
 */
const IRC_MESSAGES = new Set(["irc:incoming", "irc:autoreply", "irc:relay"]);

/** pi-family providers use several spellings for the same tool call and result fields. */
export function piMessage(value: unknown): Row | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.display === false || entry.display === false) return null;
  const raw = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === "toolCall")
      return { ...block, name: string(block.toolName, block.name), id: string(block.toolCallId, block.id, block.callId), arguments: block.toolInput ?? block.input ?? block.arguments };
    if (block.type === "toolResult")
      return { ...block, toolCallId: string(block.toolCallId, block.callId, block.id), content: block.output ?? block.content ?? block.result };
    return block;
  });
  return { ...message, toolCallId: string(message.toolCallId, message.callId), content };
}

/** The tool results a message carries: a `toolResult` message itself, or result blocks inside it. */
function piResults(message: Row): { id: string; text: string; error: boolean; details: Row }[] {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((block) => record(block).type === "toolResult") : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== "string") return [];
    return [{ id: block.toolCallId, text: resultText(block.content), error: block.isError === true, details: record(block.details) }];
  });
}

/** What a result's details add to its row: how long it ran, and an edit's diff (as the RPC chat's live rows read them). */
function resultFacts(details: Row): Pick<ToolActivity, "durationMs" | "diff" | "targetPath"> {
  const wall = typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs) ? Math.round(details.wallTimeMs) : undefined;
  const diff = typeof details.diff === "string" && details.diff.trim().length > 0 ? bounded(details.diff) : undefined;
  const target = typeof details.path === "string" && details.path.length > 0 ? details.path : undefined;
  return { ...(wall !== undefined ? { durationMs: wall } : {}), ...(diff ? { diff } : {}), ...(diff && target ? { targetPath: target } : {}) };
}

/**
 * A notice the runtime put in the user's seat (`custom_message`, `display` not false): a
 * background job's result, a wake. IRC traffic between agents is none.
 */
function piNotice(entry: Row): { text: string; source: string } | null {
  if (entry.type !== "custom_message" || entry.display === false || typeof entry.content !== "string") return null;
  if ((entry.attribution === "agent" || entry.attribution === undefined) && typeof entry.customType === "string" && IRC_MESSAGES.has(entry.customType))
    return null;
  const text = entry.content.trim().replace(/^<system-notice>\s*/u, "").replace(/\s*<\/system-notice>$/u, "").trim();
  if (text.length === 0) return null;
  return { text, source: typeof entry.customType === "string" ? entry.customType : "custom_message" };
}

const OMP_ROW_TYPES = new Set(["message", "compaction", "custom", "custom_message"]);

/** Whether a line can hold a row: model changes, titles and the like are passed over unparsed. */
export function ompLineMayHoldRow(line: string): boolean {
  const opening = /^\{"type":"([^"]+)"/u.exec(line);
  return opening ? OMP_ROW_TYPES.has(opening[1]!) : true;
}

export function createOmpTranscriptParser(sessionId: string): TranscriptParser {
  const rows = new TranscriptRows(sessionId);
  const pending = new Map<string, string>();

  const applyResults = (message: Row): void => {
    for (const result of piResults(message)) {
      const id = pending.get(result.id) ?? rows.id(callIdPart(result.id));
      if (!rows.has(id)) continue;
      pending.delete(result.id);
      rows.update<ToolActivity>(id, (tool) => ({
        ...tool,
        status: result.error ? "failed" : "completed",
        ...(result.text ? { output: bounded(result.text) } : {}),
        ...resultFacts(result.details),
      }));
    }
  };

  const fold = (entry: Row): void => {
    if (isContextClear(entry, "omp")) {
      rows.clear();
      pending.clear();
      return;
    }
    const entryId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
    if (!entryId) return;
    const ts = entry.timestamp;
    const notice = piNotice(entry);
    if (notice) {
      rows.put(systemRow(rows, rows.id(entryId), AGENT_NAME, notice.text, notice.source, ts));
      return;
    }
    // pi folds old context into a summary of its own accord and on /compact
    if (entry.type === "compaction") {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (summary)
        rows.put({
          id: rows.id(entryId),
          kind: "compaction",
          sessionId,
          tokensBefore: typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : 0,
          summary,
          createdAt: clockLabel(ts),
        });
      return;
    }
    const message = piMessage(entry);
    if (message === null) return;
    // a command the user ran with `!` (or `!!`, kept out of the model's context): a shell card
    if (message.role === "bashExecution" && typeof message.command === "string") {
      const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
      const tool = toolRow(rows, rows.id(entryId), "bash", { command: message.command }, message.command.slice(0, 120), ts);
      rows.put({
        ...tool,
        status: message.cancelled === true ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
        ...(typeof message.output === "string" && message.output ? { output: bounded(message.output) } : {}),
        userShell: message.excludeFromContext === true ? { excludedFromContext: true } : {},
      });
      return;
    }
    if (message.role !== "assistant") applyResults(message);

    if (message.role === "user") {
      const blocks = Array.isArray(message.content) ? message.content.map(record) : [];
      const prompt = blocks
        .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .filter((text) => text.length > 0)
        .join("\n");
      const pictures = blocks.filter((block) => block.type === "image").length;
      // a new prompt means the calls of the turn before it will never answer
      for (const id of pending.values()) rows.update<ToolActivity>(id, (tool) => ({ ...tool, status: "cancelled" }));
      pending.clear();
      if (prompt.length > 0) rows.put(messageRow(rows, rows.id(entryId), "user", prompt, ts));
      else if (pictures > 0) rows.put(messageRow(rows, rows.id(entryId), "user", pictures === 1 ? "[image]" : `[${pictures} images]`, ts));
      return;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      message.content.forEach((value, index) => {
        const block = record(value);
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          rows.put(messageRow(rows, rows.id(entryId, index), "assistant", block.text, ts));
        } else if (block.type === "thinking") {
          // a provider that hides its reasoning leaves `thinking` empty and writes a summary beside it
          const thinking = [block.thinking, block.text, block.summary].map(resultText).find((text) => text.trim().length > 0) ?? "";
          if (thinking) rows.put(thoughtRow(rows, rows.id(entryId, index), thinking, ts));
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          const input = record(block.arguments);
          const callId = typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
          const id = callId ? rows.id(callIdPart(callId)) : rows.id(entryId, index);
          if (rows.has(id)) return;
          const summary = typeof block.intent === "string" && block.intent.length > 0 ? block.intent.slice(0, 120) : toolSummary(block.name, input);
          rows.put(toolRow(rows, id, block.name, input, summary, ts));
          if (callId) pending.set(callId, id);
        }
      });
      // a provider can place a result beside its call in the same assistant record
      applyResults(message);
      // a failed request (a 401, an overloaded provider) leaves an empty message: its error is the answer
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0)
        rows.put(noticeRow(rows, rows.id(entryId, "error"), "작업 실패", message.errorMessage, "warning", ts));
      else if (message.stopReason === "aborted") {
        for (const id of pending.values()) rows.update<ToolActivity>(id, (tool) => ({ ...tool, status: "cancelled" }));
        pending.clear();
        const reason = typeof message.errorMessage === "string" ? message.errorMessage : "";
        rows.put(noticeRow(rows, rows.id(entryId, "aborted"), "작업 취소됨", reason, "warning", ts));
      }
    }
  };

  return {
    write(text: string): void {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0 || !ompLineMayHoldRow(line)) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // a line torn by a write still in progress
        }
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) fold(entry as Row);
      }
    },
    items: () => rows.items(),
  };
}
