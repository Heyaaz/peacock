/*
 * Adapted from Ovis (https://github.com/devswha/ovis), MIT License, Copyright (c) 2026 devswha
 * (server/transcript-records.ts, server/claude-transcript.ts): the record readers both transcript
 * parsers share. Subagents, skills, Code Mode and pictures are left out (design §5.5); what is read
 * becomes Gajae transcript rows instead of Ovis's conversation turns.
 * See THIRD_PARTY_NOTICES.md.
 */
import type {
  ChatMessage,
  NoticeActivity,
  SystemNoticeActivity,
  ThoughtActivity,
  ToolActivity,
  TranscriptItem,
} from "../../../shared/agent-contract.js";

export type Row = Record<string, unknown>;

export const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

export const string = (...values: unknown[]): string | undefined =>
  values.find((value) => typeof value === "string") as string | undefined;

/** A tool result's text: a string, or the text blocks of a block list. */
export const resultText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => (typeof record(part).text === "string" ? (record(part).text as string) : "")).join("")
      : "";

/** The most of a tool's input or output a row carries (GJC's rows keep the same, MAX_TOOL_TEXT). */
export const MAX_TOOL_TEXT = 12_000;
/** The most of a notice the agent printed (a slash command's output) a row carries. */
const NOTICE_MAX_CHARS = 4000;

export function bounded(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function capNotice(text: string): string {
  return bounded(text, NOTICE_MAX_CHARS);
}

/**
 * A `/clear` the transcript records: Claude Code's whole local-command envelope (quoting /clear in
 * prose is no reset), or pi's `context_clear` custom entry.
 */
export function isContextClear(value: unknown, source: "claude" | "omp"): boolean {
  const entry = record(value);
  if (source === "omp") return entry.type === "custom" && entry.customType === "context_clear";
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string")
    return false;
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/u.test(
    message.content,
  );
}

const label = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** One line on what a tool call does: what the agent said it is for, or the command, file or pattern it names. */
export function toolSummary(name: string, input: Row): string {
  if (name === "task") {
    const items = Array.isArray(input.tasks) ? input.tasks.map(record) : [input];
    const titles = items.map((item) => label(item.task_summary) ?? label(item.description)).filter((title) => title !== null);
    if (titles.length > 0) return titles.join(" · ").slice(0, 120);
  }
  // what the agent itself said the call is for: the `description` Claude gives a Bash command or a
  // subagent's prompt; another tool's `description` is its own data
  const said =
    typeof input.code === "string"
      ? label(input.summary)
      : typeof input.command === "string" || typeof input.prompt === "string"
        ? label(input.description)
        : null;
  if (said !== null) return said.slice(0, 120);
  // pi names a file `path` where Claude names it `file_path`, and a notebook `notebook_path`
  const first = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.description ?? input.url;
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/** Removes terminal control sequences from text an agent captured from a terminal. */
export function stripTerminalControls(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) out += input[i];
      i++;
      continue;
    }
    const kind = input[i + 1];
    if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      // a string (OSC, DCS, SOS, PM, APC) ends at BEL or ST; another ESC ends it too
      i += 2;
      while (i < input.length && input.charCodeAt(i) !== 0x07 && input.charCodeAt(i) !== 0x1b) i++;
      if (input.charCodeAt(i) === 0x07) i++;
      else if (input[i + 1] === "\\") i += 2;
    } else if (kind === "[") {
      // CSI: parameters, intermediates, one final byte
      i += 2;
      while (i < input.length && (input.charCodeAt(i) < 0x40 || input.charCodeAt(i) > 0x7e)) i++;
      i++;
    } else {
      i += 2;
    }
  }
  return out;
}

/** A paste Claude Code wrapped in `<pasted_content id>` tags, as the text that was pasted. */
export function unwrapPastes(text: string): string {
  let changed = false;
  const visible = text.replace(
    /<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/gu,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/u.test(opening)) return whole;
      changed = true;
      return body;
    },
  );
  return changed ? visible.replace(/^\n+|\n+$/gu, "") : text;
}

/**
 * The streams of an entry that is wholly a command's output (`<local-command-stdout>…` or
 * `<bash-stdout>…<bash-stderr>…`), one after another; null when the entry is anything else, such
 * as prose that quotes a tag.
 */
export function taggedStreams(content: unknown, tag: "local-command" | "bash"): { stream: "stdout" | "stderr"; text: string }[] | null {
  if (typeof content !== "string") return null;
  const streams: { stream: "stdout" | "stderr"; text: string }[] = [];
  let at = 0;
  for (;;) {
    while (at < content.length && /\s/u.test(content[at]!)) at++;
    if (at === content.length) break;
    const stream = content.startsWith(`<${tag}-stdout>`, at) ? "stdout" : content.startsWith(`<${tag}-stderr>`, at) ? "stderr" : null;
    if (stream === null) return null;
    const start = at + `<${tag}-${stream}>`.length;
    // a closing tag the output prints itself ends nothing: the stream's own one is at the end of
    // the entry or before the next stream
    const close = `</${tag}-${stream}>`;
    let end = content.indexOf(close, start);
    let next = 0;
    while (end !== -1) {
      next = end + close.length;
      while (next < content.length && /\s/u.test(content[next]!)) next++;
      if (next === content.length || content.startsWith(`<${tag}-stdout>`, next) || content.startsWith(`<${tag}-stderr>`, next)) break;
      end = content.indexOf(close, end + close.length);
    }
    if (end === -1) return null;
    streams.push({ stream, text: stripTerminalControls(content.slice(start, end)) });
    at = next;
  }
  return streams.length > 0 ? streams : null;
}

/** The text of a command's output streams, each trimmed, the empty ones left out. */
export function streamsText(streams: { text: string }[]): string {
  return capNotice(
    streams
      .map(({ text }) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
  );
}

/**
 * A slash command Claude Code recorded as its echo (`<command-name>/model</command-name>
 * <command-args>…</command-args>`), as it was typed; null for anything else.
 */
export function slashCommandEcho(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<command-")) return null;
  const name = /<command-name>\s*(\/[\p{L}\p{N}_:.-]+)\s*<\/command-name>/u.exec(trimmed)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(trimmed)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

// ---- rows

const CLOCK_LABEL = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false });

/** A row's time as the chat shows it (GJC's rows use the same clock label). */
export function clockLabel(timestamp: unknown): string {
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : typeof timestamp === "number" ? timestamp : Number.NaN;
  return CLOCK_LABEL.format(Number.isFinite(parsed) ? new Date(parsed) : new Date());
}

/**
 * A transcript's rows, in order, by id. Rows are replaced, never changed in place: a reader that
 * kept the previous list compares it with this one to see what changed.
 */
export class TranscriptRows {
  private list: TranscriptItem[] = [];
  private readonly index = new Map<string, number>();

  constructor(readonly sessionId: string) {}

  /** A row id: the session first, then the record's own ids (never a file path). */
  id(...parts: (string | number)[]): string {
    return [this.sessionId, ...parts].join(":");
  }

  get(id: string): TranscriptItem | undefined {
    const at = this.index.get(id);
    return at === undefined ? undefined : this.list[at];
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Adds a row at the end, or replaces the row that has its id where it stands. */
  put(item: TranscriptItem): void {
    const at = this.index.get(item.id);
    if (at === undefined) {
      this.index.set(item.id, this.list.length);
      this.list.push(item);
    } else this.list[at] = item;
  }

  update<T extends TranscriptItem>(id: string, change: (item: T) => T): void {
    const at = this.index.get(id);
    if (at !== undefined) this.list[at] = change(this.list[at] as T);
  }

  remove(id: string): void {
    if (!this.index.has(id)) return;
    this.list = this.list.filter((item) => item.id !== id);
    this.reindex();
  }

  clear(): void {
    this.list = [];
    this.index.clear();
  }

  items(): TranscriptItem[] {
    return this.list.slice();
  }

  private reindex(): void {
    this.index.clear();
    this.list.forEach((item, at) => this.index.set(item.id, at));
  }
}

export function messageRow(rows: TranscriptRows, id: string, role: ChatMessage["role"], content: string, timestamp: unknown): ChatMessage {
  return { id, kind: "message", sessionId: rows.sessionId, role, content, createdAt: clockLabel(timestamp), streaming: false };
}

export function thoughtRow(rows: TranscriptRows, id: string, content: string, timestamp: unknown): ThoughtActivity {
  return { id, kind: "thought", sessionId: rows.sessionId, content, createdAt: clockLabel(timestamp), streaming: false };
}

export function noticeRow(
  rows: TranscriptRows,
  id: string,
  title: string,
  content: string,
  tone: NoticeActivity["tone"],
  timestamp: unknown,
): NoticeActivity {
  return { id, kind: "notice", sessionId: rows.sessionId, title, content, tone, createdAt: clockLabel(timestamp) };
}

export function systemRow(
  rows: TranscriptRows,
  id: string,
  title: string,
  content: string,
  sourceType: string,
  timestamp: unknown,
): SystemNoticeActivity {
  return { id, kind: "system", sessionId: rows.sessionId, title, content, sourceType, createdAt: clockLabel(timestamp) };
}

/**
 * Tool names as the chat's cards know them (GJC's lower-case names), so a Claude Code Bash, Read,
 * Write or Edit call reads like GJC's own; every other tool keeps the name it has.
 */
const CARD_TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
};

export function toolRow(
  rows: TranscriptRows,
  id: string,
  name: string,
  input: Row,
  description: string,
  timestamp: unknown,
): ToolActivity {
  const target = string(input.file_path, input.notebook_path, input.path);
  let command: string | undefined;
  try {
    command = bounded(JSON.stringify(input, null, 2));
  } catch {
    command = undefined;
  }
  return {
    id,
    kind: "tool",
    sessionId: rows.sessionId,
    name: CARD_TOOL_NAMES[name] ?? name,
    description,
    ...(command ? { command } : {}),
    status: "running",
    createdAt: clockLabel(timestamp),
    ...(target ? { targetPath: target } : {}),
  };
}

/**
 * A call id as a row id holds it: the characters every id check takes (letters, digits, `.`, `_`,
 * `:`, `-`), anything else as `_`. omp's OpenAI calls are `call_…|fc_…`, which the window's and
 * a phone's tool-decision checks would refuse; the transcript and the approvals spell it the same.
 */
export function callIdPart(callId: string): string {
  return callId.replace(/[^A-Za-z0-9._:-]/gu, "_");
}

/** Reads a transcript a line at a time and answers with its rows. */
export interface TranscriptParser {
  /** Whole lines, each ending in a newline; a torn last line is the caller's to keep. */
  write(text: string): void;
  items(): TranscriptItem[];
  /**
   * The leaf the agent holds when the file does not say it yet (omp after a tree navigation),
   * until the next record; undefined goes back to the file's. Only a tree-shaped format has it.
   */
  setLeaf?(leaf: string | null | undefined): void;
}
