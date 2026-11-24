import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../shared/agent-contract.js";
import { HerdrTranscripts, TranscriptFollower, type TranscriptLocation } from "./transcripts.js";

const SID = "terminal-follow";
const AT = "2026-11-24T06:23:32.153Z";
const common = { isSidechain: false, cwd: "/work/demo", sessionId: "cc-1", version: "2.1.331" };
const prompt = (uuid: string, text: string) =>
  `${JSON.stringify({ parentUuid: null, ...common, type: "user", message: { role: "user", content: text }, uuid, timestamp: AT, origin: { kind: "human" }, permissionMode: "default" })}\n`;
const answer = (uuid: string, text: string) =>
  `${JSON.stringify({ parentUuid: null, ...common, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" }, uuid, timestamp: AT })}\n`;
const call = (uuid: string, callId: string) =>
  `${JSON.stringify({ parentUuid: null, ...common, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: callId, name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" }, uuid, timestamp: AT })}\n`;
const output = (uuid: string, callId: string) =>
  `${JSON.stringify({ parentUuid: null, ...common, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "done" }] }, uuid, timestamp: AT })}\n`;

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), "gajae-transcript-"));
}

describe("TranscriptFollower", () => {
  it("reads only whole lines and takes the rest once it is written", async () => {
    const file = path.join(folder(), "a.jsonl");
    const whole = prompt("u1", "hello") + answer("a1", "hi");
    writeFileSync(file, whole.slice(0, whole.length - 20));
    const follower = new TranscriptFollower(SID);
    const at: TranscriptLocation = { path: file, format: "claude" };
    expect(await follower.sync(at)).toBe(true);
    expect(follower.items().map((item) => item.id)).toEqual([`${SID}:u1`]);
    const revision = follower.revision();
    expect(await follower.sync(at)).toBe(false);
    appendFileSync(file, whole.slice(whole.length - 20));
    expect(await follower.sync(at)).toBe(true);
    expect(follower.items().map((item) => item.id)).toEqual([`${SID}:u1`, `${SID}:a1:0`]);
    expect(follower.revision()).not.toBe(revision);
  });

  it("starts over for another file, a replaced file, or a shorter one", async () => {
    const directory = folder();
    const first = path.join(directory, "a.jsonl");
    const second = path.join(directory, "b.jsonl");
    writeFileSync(first, prompt("u1", "one"));
    writeFileSync(second, prompt("u2", "two"));
    const follower = new TranscriptFollower(SID);
    await follower.sync({ path: first, format: "claude" });
    expect(await follower.sync({ path: second, format: "claude" })).toBe(true);
    expect(follower.items().map((item) => item.id)).toEqual([`${SID}:u2`]);
    // replaced under the same name (a new inode)
    writeFileSync(path.join(directory, "c.jsonl"), prompt("u3", "three"));
    renameSync(path.join(directory, "c.jsonl"), second);
    expect(await follower.sync({ path: second, format: "claude" })).toBe(true);
    expect(follower.items().map((item) => item.id)).toEqual([`${SID}:u3`]);
    // cut short in place
    writeFileSync(second, prompt("u4", "4"));
    await follower.sync({ path: second, format: "claude" });
    expect(follower.items().map((item) => item.id)).toEqual([`${SID}:u4`]);
  });

  it("reads a long file from its end with the ids a whole read gives", async () => {
    const file = path.join(folder(), "long.jsonl");
    const lines = Array.from({ length: 60 }, (_, index) => (index % 2 ? answer(`a${index}`, "x".repeat(200)) : prompt(`u${index}`, "y".repeat(200)))).join("");
    writeFileSync(file, lines);
    const whole = new TranscriptFollower(SID);
    await whole.sync({ path: file, format: "claude" });
    const tail = new TranscriptFollower(SID, 4000);
    await tail.sync({ path: file, format: "claude" });
    const tailIds = tail.items().map((item) => item.id);
    expect(tailIds.length).toBeGreaterThan(5);
    expect(tailIds.length).toBeLessThan(60);
    expect(whole.items().map((item) => item.id).slice(-tailIds.length)).toEqual(tailIds);
  });

  it("waits for a file that is not written yet", async () => {
    const file = path.join(folder(), "later.jsonl");
    const follower = new TranscriptFollower(SID);
    expect(await follower.sync({ path: file, format: "omp" })).toBe(true);
    expect(await follower.sync({ path: file, format: "omp" })).toBe(false);
    expect(follower.items()).toEqual([]);
  });
});

describe("HerdrTranscripts", () => {
  function setup(initial: string) {
    const directory = folder();
    let location: TranscriptLocation = { path: path.join(directory, "t.jsonl"), format: "claude" };
    writeFileSync(location.path, initial);
    const events: AgentEvent[] = [];
    const transcripts = new HerdrTranscripts({ locate: async () => location, emit: (event) => events.push(event), pollMs: 60_000 });
    return {
      transcripts,
      events,
      directory,
      append: (text: string) => appendFileSync(location.path, text),
      move: (next: string, text: string) => {
        location = { path: path.join(directory, next), format: "claude" };
        writeFileSync(location.path, text);
      },
    };
  }

  it("answers pages, and sends what changed after the window read one", async () => {
    const { transcripts, events, append } = setup(prompt("u1", "hello") + call("a1", "toolu_1"));
    const page = await transcripts.page(SID);
    expect(page.items.map((item) => item.id)).toEqual([`${SID}:u1`, `${SID}:toolu_1`]);
    expect(events).toEqual([]);
    append(output("r1", "toolu_1") + answer("a2", "done"));
    await transcripts.items(SID);
    expect(events.map((event) => [event.type, event.type === "transcript.appended" ? event.item.id : ""])).toEqual([
      ["transcript.appended", `${SID}:toolu_1`],
      ["transcript.appended", `${SID}:a2:0`],
    ]);
    expect(events[0]).toMatchObject({ item: { status: "completed", output: "done" } });
  });

  it("sends many changes as one window from a row the window holds", async () => {
    const { transcripts, events, append } = setup(prompt("u1", "start"));
    await transcripts.page(SID);
    append(Array.from({ length: 20 }, (_, index) => answer(`a${index}`, `part ${index}`)).join(""));
    await transcripts.items(SID);
    expect(events).toHaveLength(1);
    const synced = events[0] as Extract<AgentEvent, { type: "transcript.synced" }>;
    expect(synced.type).toBe("transcript.synced");
    expect(synced.items[0]!.id).toBe(`${SID}:u1`);
    expect(synced.items).toHaveLength(21);
  });

  it("invalidates the window when rows went away (another file after /clear)", async () => {
    const { transcripts, events, move } = setup(prompt("u1", "old"));
    await transcripts.page(SID);
    move("next.jsonl", prompt("u2", "new"));
    await transcripts.items(SID);
    expect(events).toEqual([{ type: "transcript.invalidated", sessionId: SID }]);
    expect((await transcripts.page(SID)).items.map((item) => item.id)).toEqual([`${SID}:u2`]);
  });

  it("says nothing to a window that has not read the session", async () => {
    const { transcripts, events, append } = setup(prompt("u1", "a"));
    await transcripts.revision(SID);
    append(answer("a1", "b"));
    await transcripts.items(SID);
    expect(events).toEqual([]);
  });

  it("answers safety-net reads as a full window first, then patches", async () => {
    const { transcripts, append } = setup(prompt("u1", "a"));
    expect(await transcripts.changes(SID)).toMatchObject({ kind: "full", items: [{ id: `${SID}:u1` }] });
    append(answer("a1", "b"));
    expect(await transcripts.changes(SID)).toMatchObject({ kind: "patch", items: [{ id: `${SID}:a1:0` }] });
  });

  it("polls watched sessions", async () => {
    const directory = folder();
    const file = path.join(directory, "p.jsonl");
    writeFileSync(file, prompt("u1", "a"));
    const events: AgentEvent[] = [];
    const transcripts = new HerdrTranscripts({ locate: async () => ({ path: file, format: "claude" }), emit: (event) => events.push(event), pollMs: 20 });
    await transcripts.page(SID);
    transcripts.watch([SID]);
    appendFileSync(file, answer("a1", "b"));
    await expect.poll(() => events.length, { timeout: 2000 }).toBe(1);
    transcripts.dispose();
  });
});
