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
      { id: `${SID}:call_1_fc_1`, kind: "tool", name: "read", description: "Read README", targetPath: "README.md", status: "completed", output: "# Demo" },
      { id: `${SID}:e4:0`, kind: "message", role: "assistant", content: "It says Demo." },
    ]);
  });

  it("keeps the image count of a prompt whose text sits beside the pictures", () => {
    const items = parse(HEAD + entry("e1", "c0", {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "blob:sha256:abc", mimeType: "image/webp" },
      ],
    }));
    expect(items).toMatchObject([{ id: `${SID}:e1`, role: "user", content: "look", imageCount: 1 }]);
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

  it("reads how long a call ran and an edit's diff from the result's details (P6)", () => {
    const parser = createOmpTranscriptParser("s");
    parser.write(
      [
        { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "x.ts" } }] } },
        { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a" }], details: { wallTimeMs: 31.6 } } },
        { type: "message", id: "r2", message: { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b", path: "x.ts" } } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const [bash, editRow] = parser.items();
    expect(bash).toMatchObject({ kind: "tool", status: "completed", durationMs: 32 });
    expect(editRow).toMatchObject({ kind: "tool", diff: "-1 a\n+1 b", targetPath: "x.ts" });
  });
});

describe("omp's user shell records", () => {
  it("reads a !command and a !!command as shell cards with their output and exit", () => {
    const parser = createOmpTranscriptParser(SID);
    parser.write(
      HEAD +
        entry("b1", "c0", { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false }) +
        entry("b2", "b1", { role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: false, excludeFromContext: true }) +
        entry("b3", "b2", { role: "bashExecution", command: "sleep 9", output: "", cancelled: true, truncated: false }),
    );
    const tools = parser.items().filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool");
    expect(tools.map((tool) => [tool.id, tool.name, tool.status, tool.output ?? "", tool.userShell])).toEqual([
      [`${SID}:b1`, "bash", "completed", "hi\n", {}],
      [`${SID}:b2`, "bash", "failed", "", { excludedFromContext: true }],
      [`${SID}:b3`, "bash", "cancelled", "", {}],
    ]);
    expect(tools[0]!.command).toContain("echo hi");
  });
});

describe("omp's tree", () => {
  // root c0 → u1 (first question) → a1; u1 rewritten: c0 → u2 → a2 (the leaf, written last)
  const BRANCHED =
    HEAD +
    entry("u1", "c0", { role: "user", content: [{ type: "text", text: "first question" }] }) +
    entry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop" }) +
    entry("u2", "c0", { role: "user", content: [{ type: "text", text: "second question" }] }) +
    entry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "new answer" }], stopReason: "stop" }) +
    line({ type: "model_usage", id: "mu", parentId: "a2", timestamp: AT, activeLeafId: "a2" });
  const texts = (items: TranscriptItem[]) => items.flatMap((item) => (item.kind === "message" ? [item.content] : []));

  it("shows the path to the active leaf, not the branch it left, with the rows' ids kept", () => {
    const parser = createOmpTranscriptParser(SID);
    parser.write(BRANCHED);
    expect(texts(parser.items())).toEqual(["second question", "new answer"]);
    expect(parser.items().map((item) => item.id)).toEqual([`${SID}:u2`, `${SID}:a2:0`]);
  });

  it("follows a leaf the agent moved to until the next record, then the file's again", () => {
    const parser = createOmpTranscriptParser(SID);
    parser.write(BRANCHED);
    parser.setLeaf?.("a1");
    expect(texts(parser.items())).toEqual(["first question", "old answer"]);
    // a navigation to a first prompt leaves nothing on the path
    parser.setLeaf?.("c0");
    expect(texts(parser.items())).toEqual([]);
    parser.setLeaf?.("a1");
    parser.write(entry("u3", "a1", { role: "user", content: [{ type: "text", text: "follow-up" }] }));
    expect(texts(parser.items())).toEqual(["first question", "old answer", "follow-up"]);
  });

  it("reads a linear file as before", () => {
    const parser = createOmpTranscriptParser(SID);
    parser.write(TURN);
    expect(parser.items().length).toBeGreaterThan(0);
    parser.setLeaf?.(undefined);
    expect(parser.items().length).toBeGreaterThan(0);
  });
});
