import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runsInTerminal, type AgentEvent, type TranscriptItem } from "../../shared/agent-contract.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { OmpRpcController, ompRpcArgs, sessionOfOmpToolId } from "./controller.js";
import { FakeRpcProcess, settle } from "./fake-process.test-util.js";
import { OmpRpcSessionStore } from "./session-store.js";

type Row = { dir: string; frame: Record<string, unknown> };

function fixture(name: string): Row[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
}

/** The frames omp wrote for one prompt in a P0 recording, from its acceptance to its prompt_result. */
function turnFrames(name: string): Record<string, unknown>[] {
  const rows = fixture(name);
  const start = rows.findIndex((row) => row.dir === "in" && row.frame.type === "response" && row.frame.command === "prompt");
  const end = rows.findIndex((row) => row.dir === "in" && row.frame.type === "prompt_result");
  return rows.slice(start + 1, end + 1).filter((row) => row.dir === "in").map((row) => row.frame);
}

function setup(options: { installed?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-omp-rpc-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "gajae-omp-ws-"));
  const sessionFile = path.join(workspace, "omp-session.jsonl");
  const store = new OmpRpcSessionStore(directory);
  const events: AgentEvent[] = [];
  const claim = vi.fn();
  const detect = vi.fn(async (): Promise<AgentAvailability> =>
    options.installed === false
      ? { id: "omp", name: "Oh My Pi", installed: false, reason: "설치되어 있지 않습니다" }
      : { id: "omp", name: "Oh My Pi", installed: true, binary: "/bin/omp", version: "19.1.1" },
  );
  const processes: { child: FakeRpcProcess; command: string; args: readonly string[]; env: Record<string, string> }[] = [];
  let prompts = 0;
  const spawn = vi.fn((command: string, args: readonly string[], spawnOptions: { cwd: string; env: Record<string, string> }) => {
    const child = new FakeRpcProcess();
    processes.push({ child, command, args, env: spawnOptions.env });
    child.respond((frame) => {
      if (typeof frame.id !== "string") return;
      const answer = (data?: unknown) =>
        queueMicrotask(() => child.emitFrames({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }) }));
      if (frame.type === "get_state")
        answer({
          sessionFile,
          sessionId: "01a2103a-b2a8-7412-b3ed-0106bbece8c3",
          model: { provider: "opencodex", id: "deepseek-flash", name: "DeepSeek Flash" },
          thinkingLevel: "low",
          contextUsage: { percent: 1.5 },
        });
      else if (frame.type === "prompt") {
        prompts += 1;
        answer();
      } else answer();
    });
    queueMicrotask(() => child.ready());
    return child;
  });
  const controller = new OmpRpcController({
    store,
    detect,
    environment: async () => ({ PATH: "/usr/bin", HOME: "/Users/me" }),
    spawn,
    emit: (event) => events.push(event),
    claim,
    log: () => undefined,
    resyncDelaysMs: [0, 5, 5],
  });
  return { directory, workspace, sessionFile, store, events, claim, detect, controller, processes, spawn, prompts: () => prompts };
}

async function newChat(context: ReturnType<typeof setup>, title = "chat") {
  return context.controller.createSession({ runtime: "omp-rpc", workspace: context.workspace, isolation: "workspace", agentKind: "omp", title });
}

const ids = (sessionId: string, items: readonly TranscriptItem[]) => items.map((item) => `${item.kind}:${item.id.slice(sessionId.length + 1)}`);

describe("OmpRpcController", () => {
  it("creates an omp chat row that is a conversation, not a terminal, and claims it", async () => {
    const context = setup();
    const session = await newChat(context, " ");
    expect(session).toMatchObject({
      runtime: "omp-rpc",
      agentKind: "omp",
      surfaces: ["chat"],
      status: "idle",
      title: path.basename(context.workspace),
      subtitle: `Oh My Pi · ${path.basename(context.workspace)}`,
    });
    expect(session.id).toMatch(/^omp-[0-9a-f-]{36}$/u);
    expect(runsInTerminal(session)).toBe(false);
    expect(session.capabilities).toMatchObject({ send: true, cancel: true, streaming: true, goal: false, fork: false, git: false });
    expect(context.claim).toHaveBeenCalledWith(session.id);
    expect(context.events).toEqual([{ type: "session.created", session }]);
    expect(await context.controller.listSessions()).toEqual([session]);
    // nothing runs until the chat is opened or sent to
    expect(context.spawn).not.toHaveBeenCalled();
  });

  it("refuses an omp that is not installed, another agent, and a folder that is not there", async () => {
    const missing = setup({ installed: false });
    await expect(missing.controller.createSession({ runtime: "omp-rpc", workspace: missing.workspace, isolation: "workspace" })).rejects.toThrow(
      "Oh My Pi: 설치되어 있지 않습니다",
    );
    const { controller, workspace } = setup();
    await expect(controller.createSession({ runtime: "omp-rpc", workspace, isolation: "workspace", agentKind: "claude" })).rejects.toThrow("An RPC chat runs omp");
    await expect(controller.createSession({ runtime: "omp-rpc", workspace: path.join(workspace, "nope"), isolation: "workspace" })).rejects.toThrow(
      "Workspace must be an existing folder",
    );
  });

  it("starts omp in RPC mode with tool UI when the chat opens, and records its session file", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    expect(context.processes).toHaveLength(1);
    const [started] = context.processes;
    expect(started!.command).toBe("/bin/omp");
    expect(started!.args).toEqual(["--mode", "rpc-ui", "--cwd", context.workspace, "--approval-mode=always-ask"]);
    expect(started!.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me" });
    expect(started!.child.written.map((frame) => frame.type)).toEqual(["negotiate_protocol", "set_event_filter", "set_ask_dialog", "get_state"]);
    expect(started!.child.sent("set_event_filter")[0]).toMatchObject({ events: null, messageUpdates: "delta" });
    expect(context.store.get(session.id)).toMatchObject({ sessionFile: context.sessionFile, ompSessionId: "01a2103a-b2a8-7412-b3ed-0106bbece8c3" });
    expect((await context.controller.listSessions())[0]).toMatchObject({ model: "opencodex/deepseek-flash", modelDisplay: "DeepSeek Flash", thinking: "low", usagePercent: 2 });
    // a second open uses the same process
    await context.controller.refreshSessionContext(session.id);
    expect(context.processes).toHaveLength(1);
  });

  it("streams a turn into rows and events, then gives way to the session file's rows (P0 parallel-approval recording)", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.getTranscriptPage(session.id);
    await expect(context.controller.sendMessage(session.id, { text: "run two echoes", images: [], files: [] })).resolves.toBe("prompt");
    const child = context.processes[0]!.child;
    const prompt = child.sent("prompt")[0]!;
    expect(prompt).toMatchObject({ message: "run two echoes" });
    expect(prompt.streamingBehavior).toBeUndefined();
    expect((await context.controller.listSessions())[0]!.status).toBe("running");

    const frames = turnFrames("approval-parallel.jsonl");
    const result = frames.at(-1)!;
    child.emitFrames(...frames.slice(0, -1));
    await settle();
    const live = await context.controller.getTranscript(session.id);
    expect(ids(session.id, live)).toEqual([
      "message:live:msg-1",
      "tool:call_b845f691543f4b94855c0463",
      "tool:call_903914bc123b4cc68899cb31",
      "message:live:msg-5:0",
    ]);
    expect(live[1]).toMatchObject({ name: "bash", status: "completed", output: "gajae-a\n" });
    expect(live[3]).toMatchObject({ role: "assistant", content: "DONE", streaming: false });
    const types = context.events.map((event) => event.type);
    expect(types).toContain("tool.updated");
    expect(types).toContain("message.updated");
    // omp has written its file by the time the prompt's work settles
    copyFileSync(new URL("./fixtures/session-approval-parallel.jsonl", import.meta.url), context.sessionFile);
    const before = context.events.length;
    child.emitFrames({ ...result, id: prompt.id });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = context.events.slice(before);
    expect(after).toContainEqual(expect.objectContaining({ type: "session.activity", category: "completed", sessionId: session.id }));
    const synced = after.find((event) => event.type === "transcript.synced");
    expect(synced?.type === "transcript.synced" && ids(session.id, synced.items)).toEqual([
      expect.stringMatching(/^message:[0-9a-f]{8}$/u),
      "tool:call_b845f691543f4b94855c0463",
      "tool:call_903914bc123b4cc68899cb31",
      expect.stringMatching(/^message:[0-9a-f]{8}:0$/u),
    ]);
    const settled = await context.controller.getTranscript(session.id);
    expect(ids(session.id, settled)).toEqual(synced?.type === "transcript.synced" ? ids(session.id, synced.items) : []);
    expect((await context.controller.listSessions())[0]!.status).toBe("idle");
  });

  it("steers or queues while a turn works, and stops it with abort", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.sendMessage(session.id, { text: "first", images: [], files: [] });
    await expect(context.controller.sendMessage(session.id, { text: "/steer look here", images: [], files: [] })).resolves.toBe("steer");
    await context.controller.sendMessage(session.id, { text: "/queue then this", images: [], files: [] });
    const child = context.processes[0]!.child;
    expect(child.sent("steer")[0]).toMatchObject({ message: "look here" });
    expect(child.sent("follow_up")[0]).toMatchObject({ message: "then this" });
    await context.controller.cancelRun(session.id);
    expect(child.sent("abort")).toHaveLength(1);
  });

  it("closes the turn when omp ends in the middle of it, and resumes the session file on the next send", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.getTranscriptPage(session.id);
    await context.controller.sendMessage(session.id, { text: "go", images: [], files: [] });
    const child = context.processes[0]!.child;
    child.emitFrames({ type: "agent_start" }, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "sleep 9" } });
    await settle();
    copyFileSync(new URL("./fixtures/session-approval-parallel.jsonl", import.meta.url), context.sessionFile);
    child.stderr.write("fatal: out of memory\n");
    await settle();
    child.exit(1);
    await settle();
    expect(context.events).toContainEqual(expect.objectContaining({ type: "session.activity", category: "failed" }));
    expect(context.events).toContainEqual(expect.objectContaining({ type: "tool.updated", tool: expect.objectContaining({ id: `${session.id}:call_1`, status: "cancelled" }) }));
    const notice = context.events.find((event) => event.type === "transcript.appended" && event.item.kind === "notice");
    expect(notice).toMatchObject({ item: { title: "omp가 종료되었습니다", content: "(code 1) fatal: out of memory" } });
    expect((await context.controller.listSessions())[0]!.status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // the app's notice outlives the read-back; the cancelled live call is the file's to tell
    const rows = await context.controller.getTranscript(session.id);
    expect(rows.at(-1)).toMatchObject({ kind: "notice", title: "omp가 종료되었습니다" });

    await context.controller.sendMessage(session.id, { text: "again", images: [], files: [] });
    expect(context.processes).toHaveLength(2);
    expect(context.processes[1]!.args).toEqual(["--mode", "rpc-ui", "--cwd", context.workspace, "--resume", context.sessionFile, "--approval-mode=always-ask"]);
  });

  it("refuses attachments until the chat takes them, and an empty message", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.sendMessage(session.id, { text: "  ", images: [], files: [] })).rejects.toThrow("The message is empty");
    await expect(
      context.controller.sendMessage(session.id, { text: "x", images: [{ id: "i", name: "a.png", mimeType: "image/png", data: "AA" }], files: [] }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("renames and deletes, ending the chat's omp", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    await context.controller.renameSession(session.id, "renamed");
    expect(context.controller.sessionTitle(session.id)).toBe("renamed");
    expect(context.events.at(-1)).toMatchObject({ type: "session.updated", session: { title: "renamed" } });
    let ended = false;
    context.processes[0]!.child.stdin.on("finish", () => {
      ended = true;
    });
    await context.controller.deleteSession(session.id);
    await settle();
    expect(ended).toBe(true);
    expect(context.events.at(-1)).toEqual({ type: "session.deleted", sessionId: session.id });
    expect(await context.controller.listSessions()).toEqual([]);
  });

  it("builds omp's command line from the chat's launch options", () => {
    expect(ompRpcArgs({ workspace: "/w", sessionFile: "/s.jsonl", launch: { model: "opencodex/x", permissionMode: "yolo" } }, true)).toEqual([
      "--mode",
      "rpc-ui",
      "--cwd",
      "/w",
      "--resume",
      "/s.jsonl",
      "--approval-mode=yolo",
      "--model=opencodex/x",
    ]);
    expect(ompRpcArgs({ workspace: "/w", sessionFile: "/s.jsonl" }, false)).toEqual(["--mode", "rpc-ui", "--cwd", "/w", "--approval-mode=always-ask"]);
  });

  it("names the session of a tool id only for its own ids", () => {
    expect(sessionOfOmpToolId("omp-0f8fad5b-d9cb-469f-a165-70867728950e:call_1")).toBe("omp-0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(sessionOfOmpToolId("terminal-0f8fad5b-d9cb-469f-a165-70867728950e:call_1")).toBeUndefined();
    expect(sessionOfOmpToolId("call_1")).toBeUndefined();
  });
});
