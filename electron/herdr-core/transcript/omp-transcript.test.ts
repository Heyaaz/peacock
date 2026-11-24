import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../../shared/agent-contract.js";
import { createOmpTranscriptParser, ompLineMayHoldRow } from "./omp-transcript.js";

// Synthetic records in the shape omp 19.x writes (pi's session format; no real transcript is copied here).
const SID = "terminal-omp";
const AT = "2026-11-24T03:03:29.928Z";
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const entry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
  line({ type: "message", id, parentId, timestamp: AT, runtime: { pid: 1 }, message: { timestamp: 1, ...message } });

const HEAD = [
  line({ type: "title", v: 1, title: "demo", source: "auto", updatedAt: AT, pad: "   " }),
  line({ type: "session", version: 3, id: "01a20b82-2b88-75d6-98bc-e61f14fc600d", timestamp: AT, cwd: "/work/demo" }),
  line({ type: "model_change", id: "m0", parentId: null, timestamp: AT, model: "test/model" }),
  line({ type: "custom", customType: "date-cwd-reminder", data: {}, id: "c0", parentId: "m0", timestamp: AT }),
].join("");

const TURN = [
  HEAD,
  entry("e1", "c0", { role: "user", content: [{ type: "text", text: "Read the readme" }], attribution: "user" }),
  entry("e2", "e1", {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "sig", summary: "Plan: read it." },
      { type: "text", text: "Reading." },
      { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" }, intent: "Read README" },
    ],
    stopReason: "toolUse",
  }),
  entry("e3", "e2", { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "# Demo" }], isError: false }),
  line({ type: "model_usage", id: "u1", parentId: "e3", timestamp: AT, usage: {} }),
  entry("e4", "e3", { role: "assistant", content: [{ type: "text", text: "It says Demo." }], stopReason: "stop" }),
].join("");

const parse = (text: string): TranscriptItem[] => {
  const parser = createOmpTranscriptParser(SID);
  parser.write(text);
  return parser.items();
};

describe("omp transcript", () => {
  it("reads a turn into rows whose ids are the entry's own", () => {
    const items = parse(TURN);
    expect(items).toMatchObject([
      { id: `${SID}:e1`, kind: "message", role: "user", content: "Read the readme" },
      { id: `${SID}:e2:0`, kind: "thought", content: "Plan: read it." },
      { id: `${SID}:e2:1`, kind: "message", role: "assistant", content: "Reading." },
      { id: `${SID}:call_1|fc_1`, kind: "tool", name: "read", description: "Read README", targetPath: "README.md", status: "completed", output: "# Demo" },
      { id: `${SID}:e4:0`, kind: "message", role: "assistant", content: "It says Demo." },
    ]);
  });

  it("passes over records that hold no row", () => {
    expect(ompLineMayHoldRow(JSON.stringify({ type: "model_usage" }))).toBe(false);
    expect(ompLineMayHoldRow(JSON.stringify({ type: "message" }))).toBe(true);
    expect(parse(HEAD)).toEqual([]);
  });

  it("keeps the same ids when read again, a line at a time, or from inside the file", () => {
    const whole = parse(TURN);
    expect(parse(TURN)).toEqual(whole);
    const parser = createOmpTranscriptParser(SID);
    for (const part of TURN.split(/(?<=\n)/u)) parser.write(part);
    expect(parser.items()).toEqual(whole);
    const window = TURN.slice(TURN.indexOf('{"type":"message","id":"e4"'));
    expect(parse(window).map((item) => item.id)).toEqual([`${SID}:e4:0`]);
  });

  it("shows the runtime's notices but not hidden ones or IRC traffic", () => {
    const items = parse(
      line({ type: "custom_message", customType: "async-result", content: "<system-notice>Job finished</system-notice>", display: true, id: "n1", parentId: null, timestamp: AT }) +
        line({ type: "custom_message", customType: "prewalk-continue", content: "continue", display: false, id: "n2", parentId: "n1", timestamp: AT }) +
        line({ type: "custom_message", customType: "irc:incoming", content: "hello", display: true, attribution: "agent", id: "n3", parentId: "n2", timestamp: AT }),
    );
    expect(items).toMatchObject([{ id: `${SID}:n1`, kind: "system", title: "omp", content: "Job finished", sourceType: "async-result" }]);
  });

  it("reads a compaction, a failed request and a stopped turn", () => {
    const items = parse(
      line({ type: "compaction", id: "k1", parentId: null, timestamp: AT, summary: "Earlier work", tokensBefore: 9000 }) +
        entry("e1", "k1", { role: "user", content: "go" }) +
        entry("e2", "e1", { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized" }) +
        entry("e3", "e2", { role: "user", content: "again" }) +
        entry("e4", "e3", { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "sleep 9" } }], stopReason: "toolUse" }) +
        entry("e5", "e4", { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
    );
    expect(items).toMatchObject([
      { id: `${SID}:k1`, kind: "compaction", tokensBefore: 9000, summary: "Earlier work" },
      { id: `${SID}:e1`, content: "go" },
      { id: `${SID}:e2:error`, kind: "notice", content: "401 Unauthorized" },
      { id: `${SID}:e3`, content: "again" },
      { id: `${SID}:call_2`, status: "cancelled" },
      { id: `${SID}:e5:aborted`, kind: "notice", content: "Request was aborted" },
    ]);
  });

  it("starts over on a context clear", () => {
    const items = parse(TURN + line({ type: "custom", customType: "context_clear", id: "x1", parentId: "e4", timestamp: AT }) + entry("e9", "x1", { role: "user", content: "new" }));
    expect(items.map((item) => item.id)).toEqual([`${SID}:e9`]);
  });
});
