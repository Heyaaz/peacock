import { describe, expect, it } from "vitest";
import type { ToolActivity, TranscriptItem } from "../../../shared/agent-contract.js";
import { claudeLineMayHoldRow, createClaudeTranscriptParser } from "./claude-transcript.js";

// Synthetic records in the shape Claude Code 2.1.33x writes (no real transcript is copied here).
const SID = "terminal-test";
const AT = "2026-11-24T06:23:32.153Z";
const common = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: "/work/demo", sessionId: "cc-1", version: "2.1.331", gitBranch: "main" };
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const prompt = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ parentUuid, ...common, promptId: "p-1", type: "user", message: { role: "user", content }, uuid, timestamp: AT, permissionMode: "default", origin: { kind: "human" }, promptSource: "typed", ...extra });
const answer = (uuid: string, parentUuid: string, content: unknown[], stop: string | null = "end_turn", extra: Record<string, unknown> = {}) =>
  line({ parentUuid, ...common, message: { model: "claude-test", id: `msg_${uuid}`, type: "message", role: "assistant", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }, requestId: "req_1", type: "assistant", uuid, timestamp: AT, ...extra });
const result = (uuid: string, parentUuid: string, callId: string, content: unknown, isError = false) =>
  line({ parentUuid, ...common, type: "user", message: { role: "user", content: [{ tool_use_id: callId, type: "tool_result", content, is_error: isError }] }, uuid, timestamp: AT, toolUseResult: { stdout: "" }, sourceToolAssistantUUID: parentUuid });
const noise = [
  line({ type: "mode", mode: "normal", sessionId: "cc-1" }),
  line({ type: "permission-mode", permissionMode: "default", sessionId: "cc-1" }),
  line({ type: "api-request-shape", sessionId: "cc-1", shapeHash: "h", timestamp: AT, version: "2.1.331", shape: { system: "x".repeat(2000) } }),
  line({ parentUuid: "u1", ...common, attachment: { type: "prompt_snapshot", prompt: "y".repeat(2000) }, type: "attachment", uuid: "att-1", timestamp: AT }),
  line({ type: "last-prompt", lastPrompt: "hi", leafUuid: "u1", sessionId: "cc-1" }),
  line({ parentUuid: "u1", ...common, type: "system", subtype: "turn_duration", durationMs: 10, isMeta: false, uuid: "sys-1", timestamp: AT }),
].join("");

/** One whole turn: a prompt, thinking, a Bash call, its result, and the answer. */
const TURN = [
  prompt("u1", null, "List the files"),
  noise,
  answer("a1", "u1", [{ type: "thinking", thinking: "I should run ls.", signature: "sig" }], null),
  answer("a2", "a1", [{ type: "text", text: "Running ls." }], null),
  answer("a3", "a2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls", description: "List files" } }], "tool_use"),
  result("r1", "a3", "toolu_1", "a.txt\nb.txt"),
  answer("a4", "r1", [{ type: "text", text: "Two files." }]),
].join("");

const parse = (text: string): TranscriptItem[] => {
  const parser = createClaudeTranscriptParser(SID);
  parser.write(text);
  return parser.items();
};

describe("Claude Code transcript", () => {
  it("reads a turn into rows whose ids are the record's own", () => {
    const items = parse(TURN);
    expect(items.map((item) => [item.id, item.kind])).toEqual([
      [`${SID}:u1`, "message"],
      [`${SID}:a1:0`, "thought"],
      [`${SID}:a2:0`, "message"],
      [`${SID}:toolu_1`, "tool"],
      [`${SID}:a4:0`, "message"],
    ]);
    expect(items[0]).toMatchObject({ role: "user", content: "List the files", sessionId: SID, streaming: false });
    expect(items[1]).toMatchObject({ content: "I should run ls.", streaming: false });
    const tool = items[3] as ToolActivity;
    expect(tool).toMatchObject({ name: "bash", description: "List files", status: "completed", output: "a.txt\nb.txt" });
    expect(JSON.parse(tool.command!)).toEqual({ command: "ls", description: "List files" });
    expect(items[4]).toMatchObject({ role: "assistant", content: "Two files." });
    expect(items.every((item) => !item.id.includes("/"))).toBe(true);
  });

  it("passes over Claude Code's own records without parsing them", () => {
    expect(claudeLineMayHoldRow(JSON.stringify({ type: "api-request-blob", message: { role: "user" } }))).toBe(false);
    expect(claudeLineMayHoldRow(JSON.stringify({ parentUuid: null, type: "attachment", attachment: { type: "skill_listing" } }))).toBe(false);
    expect(claudeLineMayHoldRow(JSON.stringify({ parentUuid: null, type: "attachment", attachment: { type: "queued_command" } }))).toBe(true);
    expect(claudeLineMayHoldRow(JSON.stringify({ parentUuid: null, type: "user" }))).toBe(true);
    expect(parse(noise)).toEqual([]);
  });

  it("keeps the same ids when the file is read again, a line at a time, or from inside it", () => {
    const whole = parse(TURN);
    expect(parse(TURN)).toEqual(whole);
    const parser = createClaudeTranscriptParser(SID);
    for (const part of TURN.split(/(?<=\n)/u)) parser.write(part);
    expect(parser.items()).toEqual(whole);
    // a window that begins after the prompt (a long file read from its end)
    const window = TURN.slice(TURN.indexOf(answer("a2", "a1", [{ type: "text", text: "Running ls." }], null)));
    const ids = parse(window).map((item) => item.id);
    expect(ids).toEqual(whole.slice(2).map((item) => item.id));
  });

  it("shows a slash command as typed and its output as the agent's notice", () => {
    const items = parse(
      prompt("c1", null, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>") +
        line({ parentUuid: "c1", ...common, type: "system", subtype: "local_command", content: "<local-command-stdout>Set model to sonnet</local-command-stdout>", level: "info", uuid: "c2", timestamp: AT }) +
        prompt("c3", "c2", "<local-command-stdout>Older output</local-command-stdout>"),
    );
    expect(items).toMatchObject([
      { id: `${SID}:c1`, kind: "message", role: "user", content: "/model sonnet" },
      { id: `${SID}:c2`, kind: "system", title: "Claude Code", content: "Set model to sonnet", sourceType: "local_command" },
      { id: `${SID}:c3`, kind: "system", content: "Older output", sourceType: "local-command" },
    ]);
  });

  it("starts over on /clear and drops meta and subagent records", () => {
    const items = parse(
      TURN +
        prompt("m1", "a4", "<system-reminder>hidden</system-reminder>", { isMeta: true }) +
        answer("s1", "a4", [{ type: "text", text: "subagent" }], "end_turn", { isSidechain: true }) +
        prompt("x1", "a4", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>") +
        prompt("u2", "x1", "Fresh start"),
    );
    expect(items.map((item) => item.id)).toEqual([`${SID}:u2`]);
  });

  it("reads a prompt sent while Claude worked from its queued attachment", () => {
    const items = parse(
      prompt("u1", null, "Long task") +
        answer("a1", "u1", [{ type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/work/demo/a.txt" } }], "tool_use") +
        line({ parentUuid: "a1", ...common, type: "attachment", attachment: { type: "queued_command", prompt: "also check b", commandMode: "prompt", origin: { kind: "human" } }, uuid: "q1", timestamp: AT }) +
        result("r1", "q1", "toolu_9", [{ type: "text", text: "contents" }]),
    );
    expect(items).toMatchObject([
      { id: `${SID}:u1` },
      { id: `${SID}:toolu_9`, name: "read", targetPath: "/work/demo/a.txt", status: "completed", output: "contents" },
      { id: `${SID}:q1`, role: "user", content: "also check b" },
    ]);
  });

  it("marks a turn the user stopped, and a call they turned down", () => {
    const items = parse(
      prompt("u1", null, "Delete it") +
        answer("a1", "u1", [{ type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "rm x" } }], "tool_use") +
        result("r1", "a1", "toolu_a", "The user doesn't want to proceed with this tool use. The tool use was rejected.", true) +
        answer("a2", "r1", [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "sleep 100" } }], "tool_use") +
        prompt("i1", "a2", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    );
    expect(items).toMatchObject([
      { id: `${SID}:u1` },
      { id: `${SID}:toolu_a`, status: "denied" },
      { id: `${SID}:toolu_b`, status: "cancelled" },
      { id: `${SID}:i1`, kind: "notice", tone: "warning" },
    ]);
  });

  it("replaces a prompt Claude Code cancelled before any reply with its re-send", () => {
    const items = parse(prompt("u1", "root", "first try") + prompt("u2", "root", "second try") + answer("a1", "u2", [{ type: "text", text: "ok" }]));
    expect(items.map((item) => item.id)).toEqual([`${SID}:u2`, `${SID}:a1:0`]);
  });

  it("reads a compaction's summary with the tokens it replaced", () => {
    const items = parse(
      line({ parentUuid: null, ...common, type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 41234 }, uuid: "b1", timestamp: AT }) +
        prompt("s1", "b1", "This session is being continued. Summary: did things.", { isCompactSummary: true }),
    );
    expect(items).toMatchObject([{ id: `${SID}:s1`, kind: "compaction", tokensBefore: 41234, summary: "This session is being continued. Summary: did things." }]);
  });

  it("unwraps pastes and shows a prompt of only pictures", () => {
    const items = parse(
      prompt("u1", null, '<pasted_content id="p1">\nline one\nline two\n</pasted_content id="p1">') +
        prompt("u2", "u1", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]),
    );
    expect(items).toMatchObject([{ content: "line one\nline two" }, { content: "[image]" }]);
  });

  it("ignores a torn last line", () => {
    const text = TURN + prompt("u9", "a4", "next").slice(0, 40);
    expect(parse(text).map((item) => item.id)).toEqual(parse(TURN).map((item) => item.id));
  });
});
