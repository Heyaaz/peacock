/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (server/claude-transcript.ts): reading a Claude Code transcript (`~/.claude/projects/…/<id>.jsonl`)
 * into chat rows. Subagents, skills, Code Mode, senpi and pictures are stubs here (design §5.5).
 *
 * Row ids hold only what the record itself says, so they stay the same when the file is read again
 * from another starting point: a tool row is its call id, a text or thinking block its record's
 * uuid and block index, and a prompt its record's uuid, each after the Gajae session id.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { ToolActivity } from "../../../shared/agent-contract.js";
import {
  bounded,
  capNotice,
  clockLabel,
  isContextClear,
  messageRow,
  noticeRow,
  record,
  resultText,
  slashCommandEcho,
  streamsText,
  stripTerminalControls,
  systemRow,
  taggedStreams,
  thoughtRow,
  toolRow,
  toolSummary,
  TranscriptRows,
  unwrapPastes,
  type Row,
  type TranscriptParser,
} from "./transcript-records.js";

const AGENT_NAME = "Claude Code";

/** The record types that can hold a row; Claude Code writes many more (API shapes, costs, modes). */
const ROW_TYPES = new Set(["user", "assistant", "system", "attachment"]);

/**
 * Whether a line is worth parsing. Claude Code 2.1.33x writes request shapes and prompt snapshots
 * of tens of kilobytes on every turn: a line that opens on another type, or an attachment that is
 * no queued prompt, is passed over without parsing it.
 */
export function claudeLineMayHoldRow(line: string): boolean {
  const opening = /^\{"type":"([^"]+)"/u.exec(line);
  if (opening) return ROW_TYPES.has(opening[1]!) && (opening[1] !== "attachment" || line.includes('"queued_command"'));
  if (line.includes('"type":"attachment"')) return line.includes('"queued_command"');
  return true;
}

/** Claude Code's word for a turn the user stopped, written as the next prompt's text. */
const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/u;
/** A tool result written for a call the user turned down. */
const REJECTED = /^The user doesn't want to proceed with this tool use\b/u;
const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/u;

/** Claude Code's own entries in the user's seat that say nothing to the chat. */
function isCommandEntry(text: string): boolean {
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-") || text.startsWith("<bash-");
}

export function createClaudeTranscriptParser(sessionId: string): TranscriptParser {
  const rows = new TranscriptRows(sessionId);
  /** Tool rows still waiting for their result, by call id. */
  const pending = new Map<string, string>();
  /** The last human prompt and the entry it hangs from: a send Claude Code cancelled before any
   *  reply is re-sent as a sibling of it, and its own screen shows only the re-send. */
  let lastPrompt: { id: string; parent: unknown; answered: boolean } | null = null;
  /** What the context held before the compaction its summary follows. */
  let compactedTokens = 0;

  const settlePending = (status: ToolActivity["status"]): void => {
    for (const id of pending.values()) rows.update<ToolActivity>(id, (tool) => ({ ...tool, status }));
    pending.clear();
  };

  const pushPrompt = (entry: Row, text: string, queued = false): void => {
    // a prompt typed at the prompt means the calls of the turn before it will never answer; one sent
    // while Claude worked is taken in between its calls
    if (!queued) settlePending("cancelled");
    if (lastPrompt && !lastPrompt.answered && typeof entry.parentUuid === "string" && entry.parentUuid === lastPrompt.parent)
      rows.remove(lastPrompt.id);
    const id = rows.id(String(entry.uuid));
    rows.put(messageRow(rows, id, "user", text, entry.timestamp));
    lastPrompt = { id, parent: entry.parentUuid, answered: false };
  };

  const resolveTool = (block: Row): void => {
    const callId = block.tool_use_id;
    if (typeof callId !== "string") return;
    const id = pending.get(callId) ?? rows.id(callId);
    if (!rows.has(id)) return;
    pending.delete(callId);
    const text = resultText(block.content);
    const status: ToolActivity["status"] =
      block.is_error === true ? (REJECTED.test(text) ? "denied" : "failed") : "completed";
    rows.update<ToolActivity>(id, (tool) => ({ ...tool, status, ...(text ? { output: bounded(text) } : {}) }));
  };

  const fold = (entry: Row): void => {
    // a subagent's own entries (older versions kept them in the main file) and Claude Code's reminders
    if (entry.isSidechain === true || entry.isMeta === true) return;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) return;
    if (isContextClear(entry, "claude")) {
      rows.clear();
      pending.clear();
      lastPrompt = null;
      return;
    }
    const message = record(entry.message);
    const content = message.content;
    const ts = entry.timestamp;

    if (entry.type === "system") {
      if (entry.subtype === "compact_boundary") {
        const tokens = record(entry.compactMetadata).preTokens;
        compactedTokens = typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
        return;
      }
      // a slash command answers in the terminal, not through the model: its output and Claude Code's
      // own notices (an unknown command, a usage limit) are the runtime speaking in the user's seat
      const text =
        entry.subtype === "local_command"
          ? streamsText(taggedStreams(entry.content, "local-command") ?? [])
          : entry.subtype === "informational" && typeof entry.content === "string"
            ? capNotice(stripTerminalControls(entry.content).trim())
            : "";
      if (text) rows.put(systemRow(rows, rows.id(entry.uuid), AGENT_NAME, text, String(entry.subtype), ts));
      return;
    }

    if (entry.isCompactSummary === true) {
      const summary =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((block) => (record(block).type === "text" ? String(record(block).text ?? "") : "")).join("\n")
            : "";
      rows.put({
        id: rows.id(entry.uuid),
        kind: "compaction",
        sessionId,
        tokensBefore: compactedTokens,
        summary,
        createdAt: clockLabel(ts),
      });
      compactedTokens = 0;
      return;
    }

    // A message sent while Claude works is no `user` entry: it is queued, then recorded as this
    // attachment when the turn takes it in. Only a person's prompt counts.
    if (entry.type === "attachment") {
      const queued = record(entry.attachment);
      const origin = record(queued.origin);
      if (queued.type !== "queued_command" || (queued.commandMode !== undefined && queued.commandMode !== "prompt")) return;
      if (origin.kind !== undefined && origin.kind !== "human") return;
      const prompt = typeof queued.prompt === "string" ? queued.prompt.trim() : "";
      if (prompt && !isCommandEntry(prompt)) pushPrompt(entry, unwrapPastes(prompt), true);
      return;
    }

    if (entry.type === "user" && typeof content === "string") {
      const command = slashCommandEcho(content);
      if (command !== null) {
        pushPrompt(entry, command);
        return;
      }
      const own = !("origin" in entry) && !("permissionMode" in entry);
      const shell = BASH_INPUT.exec(content)?.[1];
      if (shell !== undefined) {
        pushPrompt(entry, `!${shell}`);
        return;
      }
      const printed = taggedStreams(content, "local-command") ?? (own ? taggedStreams(content, "bash") : null);
      if (printed !== null) {
        const text = streamsText(printed);
        if (text) rows.put(systemRow(rows, rows.id(entry.uuid), AGENT_NAME, text, "local-command", ts));
        return;
      }
      if (isCommandEntry(content.trimStart())) return;
      if (INTERRUPTED.test(content.trim())) {
        settlePending("cancelled");
        rows.put(noticeRow(rows, rows.id(entry.uuid), "작업 취소됨", content.trim(), "warning", ts));
        return;
      }
      pushPrompt(entry, unwrapPastes(content));
      return;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const said: string[] = [];
      let pictures = 0;
      let interrupted: string | undefined;
      for (const value of content) {
        const block = record(value);
        if (block.type === "tool_result") resolveTool(block);
        else if (block.type === "image") pictures += 1;
        else if (block.type === "text" && typeof block.text === "string") {
          const text = block.text;
          if (INTERRUPTED.test(text.trim())) interrupted = text.trim();
          else if (!isCommandEntry(text.trim())) said.push(text);
        }
      }
      if (interrupted !== undefined) {
        settlePending("cancelled");
        rows.put(noticeRow(rows, rows.id(entry.uuid), "작업 취소됨", interrupted, "warning", ts));
      }
      const prompt = said.join("\n");
      // pictures are not carried yet (design §5.5): a prompt of only pictures still shows that it was sent
      if (prompt.trim()) pushPrompt(entry, unwrapPastes(prompt));
      else if (pictures > 0) pushPrompt(entry, pictures === 1 ? "[image]" : `[${pictures} images]`);
      return;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      if (lastPrompt) lastPrompt.answered = true;
      content.forEach((value, index) => {
        const block = record(value);
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          rows.put(messageRow(rows, rows.id(entry.uuid as string, index), "assistant", block.text, ts));
        } else if (block.type === "thinking") {
          const thinking = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
          if (thinking.trim()) rows.put(thoughtRow(rows, rows.id(entry.uuid as string, index), thinking, ts));
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = record(block.input);
          const callId = typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
          const id = callId ? rows.id(callId) : rows.id(entry.uuid as string, index);
          // a call Claude Code wrote twice (a resumed stream) keeps the result it already has
          if (rows.has(id)) return;
          rows.put(toolRow(rows, id, block.name, input, toolSummary(block.name, input), ts));
          if (callId) pending.set(callId, id);
        }
      });
    }
  };

  return {
    write(text: string): void {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0 || !claudeLineMayHoldRow(line)) continue;
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
