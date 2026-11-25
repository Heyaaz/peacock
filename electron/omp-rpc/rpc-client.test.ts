import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeRpcProcess, settle } from "./fake-process.test-util.js";
import { OmpRpcClient, OmpRpcError, OmpRpcExitError, RpcChunkAssembler, type RpcFrame } from "./rpc-client.js";

function fixture(name: string): { dir: string; frame: Record<string, unknown> }[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });
}

/** A frame's JSON cut into protocol-2 chunks, the way omp writes one over 1 MiB. */
function chunked(frame: unknown, size: number, chunkId = "rpc-1"): Record<string, unknown>[] {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / size);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

describe("OmpRpcClient", () => {
  it("waits for ready and passes over a line that is not JSON (a login shell's banner)", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const ready = client.waitReady(1000);
    child.emitLine("Last login: today\n");
    child.ready();
    await expect(ready).resolves.toMatchObject({ type: "ready", supportedProtocolVersions: [1, 2] });
    expect(client.ready?.protocolVersion).toBe(1);
  });

  it("matches responses to commands by id, out of order, and refuses what omp refused", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const state = client.call<{ sessionId: string }>({ type: "get_state" });
    const model = client.call({ type: "set_model", provider: "x", modelId: "y" });
    await settle();
    const [first, second] = child.written;
    child.emitFrames(
      { id: second!.id, type: "response", command: "set_model", success: false, error: "Model not found", code: "not_found" },
      { id: first!.id, type: "response", command: "get_state", success: true, data: { sessionId: "s-1" } },
    );
    await expect(state).resolves.toEqual({ sessionId: "s-1" });
    const refusal = await model.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OmpRpcError);
    expect(refusal).toMatchObject({ command: "set_model", message: "Model not found", code: "not_found" });
  });

  it("times a command out without leaving it pending", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    await expect(client.call({ type: "get_state" }, 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("settles a prompt's acceptance with its response and its result with the prompt_result", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const frames: RpcFrame[] = [];
    client.onFrame((frame) => frames.push(frame));
    const { id, accepted, result } = client.prompt({ type: "prompt", message: "hi" });
    await settle();
    expect(child.sent("prompt")[0]).toMatchObject({ id, message: "hi" });
    child.emitFrames(
      { id, type: "response", command: "prompt", success: true },
      { type: "agent_start" },
      { type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true },
    );
    await expect(accepted).resolves.toBeUndefined();
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(frames.map((frame) => frame.type)).toEqual(["agent_start", "prompt_result"]);
  });

  it("puts protocol-2 chunks back into the frame they carry", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const big = "a".repeat(3000);
    const read = client.call<{ messages: { text: string }[] }>({ type: "get_messages" });
    await settle();
    const id = child.written[0]!.id;
    child.emitFrames(...chunked({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ text: big }] } }, 1024));
    await expect(read).resolves.toEqual({ messages: [{ text: big }] });
  });

  it("drops a chunk sequence that breaks off and goes on with the next frame", () => {
    const dropped: string[] = [];
    const assembler = new RpcChunkAssembler((reason) => dropped.push(reason));
    const chunks = chunked({ type: "x", text: "b".repeat(100) }, 40);
    expect(assembler.push(chunks[0]!)).toBeUndefined();
    expect(assembler.push({ type: "agent_start" })).toEqual({ type: "agent_start" });
    expect(dropped).toEqual(["chunk sequence rpc-1 interrupted"]);
    expect(assembler.push(chunks[2]!)).toBeUndefined();
    expect(dropped).toHaveLength(2);
  });

  it("reads the chunk metadata omp 19.1.1 wrote (P0 fixture)", () => {
    const chunks = fixture("chunk.jsonl").filter((row) => row.frame.type === "rpc_chunk").map((row) => row.frame);
    expect(chunks).toHaveLength(6);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(chunks.map((chunk) => chunk.chunkId))).toEqual(new Set(["rpc-1"]));
  });

  it("refuses everything still waiting when the process ends, with what stderr said last", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const ready = client.waitReady(1000);
    const state = client.call({ type: "get_state" });
    const { result } = client.prompt({ type: "prompt", message: "x" });
    const exits: unknown[] = [];
    client.onExit((info) => exits.push(info));
    child.stderr.write("boom: no model\n");
    await settle();
    child.exit(1);
    for (const pending of [ready, state, result]) {
      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(OmpRpcExitError);
      expect(String((error as Error).message)).toContain("boom: no model");
    }
    expect(exits).toEqual([{ code: 1, signal: null, stderr: "boom: no model\n" }]);
    expect(client.exited).toBe(true);
    await expect(client.call({ type: "get_state" })).rejects.toBeInstanceOf(OmpRpcExitError);
  });

  it("hands frames over in the order omp wrote them (P0 parallel-approval fixture)", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    const types: string[] = [];
    client.onFrame((frame) => types.push(frame.type === "extension_ui_request" ? `ui:${String(frame.method)}` : frame.type));
    const incoming = fixture("approval-parallel.jsonl").filter((row) => row.dir === "in").map((row) => row.frame);
    child.emitFrames(...incoming);
    await settle();
    const approvals = types.indexOf("ui:select");
    expect(types.slice(approvals - 2, approvals + 2)).toEqual(["tool_execution_start", "tool_execution_start", "ui:select", "ui:select"]);
    // a response no command of this client asked for is handed over like any frame
    expect(types.slice(types.indexOf("prompt_result"), types.indexOf("prompt_result") + 2)).toEqual(["prompt_result", "session_settled"]);
  });

  it("closes by ending stdin, then terminates a process that stays", async () => {
    const child = new FakeRpcProcess();
    const client = new OmpRpcClient(child);
    let ended = false;
    child.stdin.on("finish", () => {
      ended = true;
    });
    client.close(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ended).toBe(true);
    expect(child.killed).toBe("SIGTERM");
    expect(client.exited).toBe(true);
  });
});
