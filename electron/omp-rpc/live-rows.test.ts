import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent, TranscriptItem } from "../../shared/agent-contract.js";
import { isLiveRowId, OmpLiveRows } from "./live-rows.js";
import type { RpcFrame } from "./rpc-client.js";
import { transcriptSyncEvents } from "./transcript-sync.js";

const SESSION = "omp-0f8fad5b-d9cb-469f-a165-70867728950e";

function incoming(name: string): RpcFrame[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { dir: string; frame: RpcFrame })
    .filter((row) => row.dir === "in")
    .map((row) => row.frame);
}

function replay(name: string) {
  const live = new OmpLiveRows(SESSION, () => Date.parse("2026-11-25T01:00:00Z"));
  const events: AgentEvent[] = [];
  for (const frame of incoming(name)) events.push(...live.apply(frame));
  return { live, events };
}

describe("OmpLiveRows", () => {
  it("builds a reply from its deltas, not from the snapshot omp's message_start already holds (P0 stream)", () => {
    const { live, events } = replay("stream.jsonl");
    const rows = live.items();
    expect(rows.map((item) => item.id.slice(SESSION.length + 1))).toEqual(["live:msg-1", "live:msg-2:0"]);
    expect(rows[0]).toMatchObject({ kind: "message", role: "user", content: "Reply with exactly: OK" });
    // "OK" once: message_start carried it and text_delta repeated it
    expect(rows[1]).toMatchObject({ kind: "message", role: "assistant", content: "OK", streaming: false });
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      { type: "message.delta", sessionId: SESSION, messageId: `${SESSION}:live:msg-2:0`, delta: "OK", streaming: true },
    ]);
    expect(events.map((event) => event.type)).toEqual(["transcript.appended", "transcript.appended", "message.delta", "message.updated", "message.updated"]);
  });

  it("follows a tool from its call through its run to its output, under the file's id (P0 parallel calls)", () => {
    const { live, events } = replay("approval-parallel.jsonl");
    const id = `${SESSION}:call_b845f691543f4b94855c0463`;
    const statuses = events.flatMap((event) =>
      event.type === "tool.updated" && event.tool.id === id ? [event.tool.status] : event.type === "transcript.appended" && event.item.id === id && event.item.kind === "tool" ? [event.item.status] : [],
    );
    expect(statuses[0]).toBe("pending");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("completed");
    expect(live.get(id)).toMatchObject({ name: "bash", description: "echo gajae-a", status: "completed", output: "gajae-a\n" });
    expect(live.runningTools()).toEqual([]);
  });

  it("keeps how long a call ran (bash wallTimeMs) and an edit's diff, and how long a thought took (P6)", () => {
    const { live } = replay("approval-parallel.jsonl");
    // omp's bash reports its own wall time: 29.97ms in the recording
    expect(live.get(`${SESSION}:call_b845f691543f4b94855c0463`)).toMatchObject({ durationMs: 30 });
    let clock = 1000;
    const timed = new OmpLiveRows(SESSION, () => clock);
    timed.apply({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    clock = 5200;
    timed.apply({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hm" } });
    expect(timed.get(`${SESSION}:live:m:0`)).toMatchObject({ kind: "thought", durationMs: 4200 });
    timed.apply({ type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "a.ts" } });
    clock = 5300;
    timed.apply({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result: { content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new", path: "a.ts" } } });
    expect(timed.get(`${SESSION}:e1`)).toMatchObject({ status: "completed", durationMs: 100, diff: "-1 old\n+1 new", targetPath: "a.ts" });
  });

  it("marks an aborted reply and the calls it left open (P0 abort)", () => {
    const { live } = replay("abort.jsonl");
    const notice = live.items().find((item) => item.kind === "notice");
    expect(notice).toMatchObject({ title: "작업 취소됨", tone: "warning" });
    expect(isLiveRowId(SESSION, notice!.id)).toBe(true);
  });

  it("records an image next to its text so delivery can be confirmed", () => {
    const live = new OmpLiveRows(SESSION);
    live.apply({
      type: "message_start",
      messageId: "msg-img",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "blob:sha256:abc", mimeType: "image/webp" },
        ],
      },
    });
    expect(live.items()[0]).toMatchObject({ kind: "message", role: "user", content: "look", imageCount: 1 });
  });

  it("keeps only what the session file will not hold when a turn is read back", () => {
    const live = new OmpLiveRows(SESSION);
    live.apply({ type: "message_start", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    live.put({ id: `${SESSION}:ui:notice-1`, kind: "notice", sessionId: SESSION, title: "n", content: "", tone: "neutral", createdAt: "01:00" });
    live.retain((item) => !isLiveRowId(SESSION, item.id));
    expect(live.items().map((item) => item.id)).toEqual([`${SESSION}:ui:notice-1`]);
  });
});

describe("transcriptSyncEvents", () => {
  const row = (id: string, content = id): TranscriptItem => ({ id, kind: "message", sessionId: "s", role: "assistant", content, createdAt: "01:00" });

  it("sends added and changed rows one by one", () => {
    expect(transcriptSyncEvents("s", [row("a"), row("b")], [row("a"), row("b", "B"), row("c")])).toEqual([
      { type: "transcript.appended", item: row("b", "B") },
      { type: "transcript.appended", item: row("c") },
    ]);
    expect(transcriptSyncEvents("s", [row("a")], [row("a")])).toEqual([]);
    expect(transcriptSyncEvents("s", undefined, [row("a")])).toEqual([]);
  });

  it("sends replaced rows as a tail from the last row both share, or as the whole list", () => {
    expect(transcriptSyncEvents("s", [row("a"), row("live-1"), row("live-2")], [row("a"), row("f1"), row("f2")])).toEqual([
      { type: "transcript.synced", sessionId: "s", items: [row("a"), row("f1"), row("f2")] },
    ]);
    expect(transcriptSyncEvents("s", [row("live-1")], [row("f1")])).toEqual([{ type: "transcript.synced", sessionId: "s", items: [row("f1")] }]);
  });
});
