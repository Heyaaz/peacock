import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const CONTEXT_REPORT = [
  "Context window: 950000 tokens (2% used)",
  "  System prompt    [░░░░] 0%  1861 tokens",
  "  System tools     [░░░░] 1%  5743 tokens",
  "  Messages         [░░░░] 0%  6746 tokens",
  "  Auto-compact buf [█░░░] 15%  142500 tokens",
  "  Free             [███░] 83%  793150 tokens",
].join("\n");

function setup(options: { installed?: boolean; rules?: Record<string, "allow" | "reject"> } = {}) {
  const addRule = vi.fn(async () => undefined);
  const commandRules = {
    decide: vi.fn(async (_root: string, _tool: string, command: string) => {
      const prefix = Object.keys(options.rules ?? {}).find((candidate) => command.startsWith(candidate));
      return prefix ? { prefix, decision: options.rules![prefix]!, root: "/repo" } : undefined;
    }),
    add: addRule,
  };
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
  let goal: Record<string, unknown> | null = null;
  const modes = { fast: false, autoCompaction: true };
  const spawn = vi.fn((command: string, args: readonly string[], spawnOptions: { cwd: string; env: Record<string, string> }) => {
    const child = new FakeRpcProcess();
    processes.push({ child, command, args, env: spawnOptions.env });
    let openFile = sessionFile;
    child.respond((frame) => {
      if (typeof frame.id !== "string") return;
      const answer = (data?: unknown) =>
        queueMicrotask(() => child.emitFrames({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }) }));
      if (frame.type === "get_state")
        answer({
          sessionFile: openFile,
          sessionId: "01a2103a-b2a8-7412-b3ed-0106bbece8c3",
          model: { provider: "opencodex", id: "deepseek-flash", name: "DeepSeek Flash" },
          thinkingLevel: "low",
          configuredThinkingLevel: "low",
          thinkingLevels: ["off", "auto", "low", "high"],
          contextUsage: { percent: 1.5, tokens: 14350, contextWindow: 950000 },
          autoCompactionEnabled: modes.autoCompaction,
          fastModeEnabled: modes.fast,
          fastModeActive: false,
          slowModeSupported: false,
          slowModeEnabled: false,
        });
      else if (frame.type === "set_fast_mode") {
        modes.fast = frame.enabled === true;
        answer({ enabled: modes.fast, active: false });
      } else if (frame.type === "set_auto_compaction") {
        modes.autoCompaction = frame.enabled === true;
        answer();
      }
      else if (frame.type === "prompt" && frame.message === "/context")
        // omp answers the slash command itself: its report, then the response, and no prompt_result
        queueMicrotask(() =>
          child.emitFrames(
            { type: "command_output", text: CONTEXT_REPORT },
            { id: frame.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } },
          ),
        );
      else if (frame.type === "prompt" && frame.message === "/session")
        queueMicrotask(() =>
          child.emitFrames(
            { type: "command_output", text: "Session\n  Messages: 4" },
            { id: frame.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } },
          ),
        );
      else if (frame.type === "prompt") {
        prompts += 1;
        answer();
      } else if (frame.type === "get_model_picker")
        answer({
          rows: [
            { provider: "opencodex", id: "deepseek-flash", name: "DeepSeek Flash", current: true },
            { provider: "anthropic", id: "claude-x", name: "Claude X", roles: [{ role: "smol", label: "SMOL" }] },
          ],
          recent: 1,
          total: 2,
        });
      else if (frame.type === "get_available_models")
        answer({
          models: [
            { provider: "opencodex", id: "deepseek-flash", contextWindow: 950000, cost: { input: 0, output: 0 }, tps: 132 },
            { provider: "anthropic", id: "claude-x", contextWindow: 200000, cost: { input: 3, output: 15 }, int: 61.5 },
          ],
        });
      else if (frame.type === "get_available_commands") answer({ commands: [{ name: "compact", description: "Compact the context", input: { hint: "[instructions]" }, source: "builtin" }] });
      else if (frame.type === "cycle_thinking_level") answer({ level: "high" });
      else if (frame.type === "abort_and_deliver_queue") answer({ aborted: true });
      else if (frame.type === "fork") {
        openFile = path.join(workspace, `fork-${String(frame.entryId ?? "end")}.jsonl`);
        answer({ cancelled: false });
      } else if (frame.type === "branch") {
        openFile = path.join(workspace, "branch.jsonl");
        answer({ text: "rewrite me", cancelled: false });
      } else if (frame.type === "get_tree")
        answer({
          leafId: "c2",
          tree: [
            {
              entry: { type: "model_change", id: "m0", parentId: null },
              children: [
                {
                  entry: { type: "message", id: "u1", parentId: "m0", message: { role: "user", content: "first question" } },
                  children: [
                    { entry: { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } }, children: [] },
                    {
                      entry: { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
                      label: "retry",
                      children: [{ entry: { type: "custom", id: "c2", parentId: "a2" }, children: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        });
      else if (frame.type === "export_html") answer({ path: frame.outputPath });
      else if (frame.type === "get_session_stats")
        answer({
          sessionId: "x",
          userMessages: 2,
          assistantMessages: 3,
          toolCalls: 1,
          toolResults: 1,
          totalMessages: 6,
          tokens: { input: 724, output: 52, reasoning: 3, cacheRead: 43520, cacheWrite: 0, total: 44296 },
          cost: 0.0123,
          premiumRequests: 0,
        });
      else if (frame.type === "promote_queued_message") answer({ promoted: frame.message === "later" });
      else if (frame.type === "remove_queued_message") answer({ removed: frame.queue === "steering" && frame.message === "now" });
      else if (frame.type === "cancel_subagent") answer({ cancelled: frame.subagentId === "sa-1" });
      else if (frame.type === "get_subagent_messages")
        answer({
          sessionFile: "/tmp/sa-1.jsonl",
          fromByte: 0,
          nextByte: 100,
          reset: false,
          entries: [],
          messages: [
            { role: "user", content: "find the parser" },
            { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "parse" } }] },
            { role: "toolResult", toolCallId: "c1", toolName: "grep", content: [{ type: "text", text: "src/parse.ts" }], isError: false },
            { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "ENOENT" }], isError: true },
          ],
        });
      else if (frame.type === "goal") {
        if (frame.op === "create") goal = { id: "g1", objective: frame.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
        else if (frame.op === "pause" && goal) goal = { ...goal, status: "paused" };
        else if (frame.op === "resume" && goal) goal = { ...goal, status: "active" };
        else if (frame.op === "drop") goal = null;
        answer({ goal, state: goal ? { enabled: goal.status === "active", mode: "active", goal } : null });
      } else if (frame.type === "btw") answer({ record: { id: "btw-1", leafId: null, question: frame.question, answer: "", status: "running", createdAt: 1, updatedAt: 1 } });
      else answer();
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
    commandRules: commandRules as never,
  });
  return { directory, workspace, sessionFile, store, events, claim, detect, controller, processes, spawn, prompts: () => prompts, addRule };
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
    expect(session.capabilities).toMatchObject({ send: true, cancel: true, streaming: true, goal: true, fork: true, git: false });
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
    // opening also reads omp's command list and model picker for the composer
    expect(started!.child.written.map((frame) => frame.type)).toEqual(["negotiate_protocol", "set_event_filter", "set_ask_dialog", "set_subagent_subscription", "get_state", "get_available_commands", "get_model_picker", "get_available_models"]);
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

  it("sends pictures as omp's images and names other files by their path, and refuses an empty message", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.sendMessage(session.id, { text: "  ", images: [], files: [] })).rejects.toThrow("The message is empty");
    await context.controller.sendMessage(session.id, {
      text: "look",
      images: [{ id: "i", name: "a.png", mimeType: "image/png", data: "AAAA" }],
      files: [{ id: "f", name: "notes.md", mimeType: "text/markdown", size: 3, nativePath: "/tmp/notes.md" }],
    });
    expect(context.processes[0]!.child.sent("prompt")[0]).toMatchObject({
      message: "look\n\nAttached file: /tmp/notes.md",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });

  it("renames and deletes, ending the chat's omp", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    await settle();
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

  it("reads a chat back with the same ids after an app restart, and resumes its session file on open", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    copyFileSync(new URL("./fixtures/session-approval-parallel.jsonl", import.meta.url), context.sessionFile);
    const before = (await context.controller.getTranscriptPage(session.id)).items.map((item) => item.id);
    context.controller.dispose();
    // a fresh app: a new controller on the same store
    const spawned: { args: readonly string[] }[] = [];
    const next = new OmpRpcController({
      store: new OmpRpcSessionStore(context.directory),
      detect: context.detect,
      environment: async () => ({ PATH: "/usr/bin" }),
      spawn: (command, args, spawnOptions) => {
        spawned.push({ args });
        return context.spawn(command, args, spawnOptions);
      },
      emit: () => undefined,
      log: () => undefined,
    });
    expect((await next.listSessions()).map((row) => [row.id, row.status])).toEqual([[session.id, "idle"]]);
    // reading needs no omp
    expect((await next.getTranscriptPage(session.id)).items.map((item) => item.id)).toEqual(before);
    expect(spawned).toEqual([]);
    await next.refreshSessionContext(session.id);
    expect(spawned[0]!.args).toContain("--resume");
    expect(spawned[0]!.args[spawned[0]!.args.indexOf("--resume") + 1]).toBe(context.sessionFile);
    next.dispose();
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

describe("OmpRpcController approvals and questions (P3)", () => {
  async function working(context: ReturnType<typeof setup>) {
    const session = await newChat(context);
    await context.controller.getTranscriptPage(session.id);
    await context.controller.sendMessage(session.id, { text: "go", images: [], files: [] });
    const child = context.processes[0]!.child;
    child.emitFrames({ type: "agent_start" });
    return { session, child };
  }
  const statusOf = async (context: ReturnType<typeof setup>) => (await context.controller.listSessions())[0]!.status;
  const uiResponses = (child: FakeRpcProcess) => child.sent("extension_ui_response");

  it("lays each of two parallel approvals on its own call's row and answers with omp's options", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames(
      { type: "tool_execution_start", toolCallId: "call_a", toolName: "bash", args: { command: "echo gajae-a" } },
      { type: "tool_execution_start", toolCallId: "call_b", toolName: "bash", args: { command: "echo gajae-b" } },
      // the prompts arrive in the other order: the content decides
      { type: "extension_ui_request", id: "req-b", method: "select", title: "Allow tool: bash\nCommand: echo gajae-b", options: ["Approve", "Approve bash for this session", "Deny"] },
      { type: "extension_ui_request", id: "req-a", method: "select", title: "Allow tool: bash\nCommand: echo gajae-a", options: ["Approve", "Approve bash for this session", "Deny"] },
    );
    await settle();
    const rows = await context.controller.getTranscript(session.id);
    const card = (callId: string) => rows.find((item) => item.id === `${session.id}:${callId}`);
    expect(card("call_a")).toMatchObject({
      status: "approval-required",
      permissionOptions: [{ optionId: "allow_once" }, { optionId: "allow_session", kind: "allow_session" }, { optionId: "reject_once" }],
    });
    expect(context.controller.toolDecisionInfo(`${session.id}:call_a`, { optionId: "allow_session" })).toEqual({
      name: "이 세션 동안 허용\n이 세션에서 bash는 다시 묻지 않습니다.",
      requiresConfirmation: true,
    });
    expect(card("call_b")).toMatchObject({ status: "approval-required" });
    expect(await statusOf(context)).toBe("waiting");
    expect(context.events).toContainEqual(expect.objectContaining({ type: "session.activity", category: "permission" }));
    expect(context.controller.sessionOfTool(`${session.id}:call_a`)).toBe(session.id);
    expect(context.controller.toolDecisionInfo(`${session.id}:call_a`, { optionId: "allow_once" })).toEqual({ name: "이번만 허용", requiresConfirmation: true });

    await context.controller.resolveToolCall(`${session.id}:call_a`, { optionId: "allow_once" });
    await context.controller.resolveToolCall(`${session.id}:call_b`, { optionId: "reject_once", comment: "not now" });
    await settle();
    expect(uiResponses(child)).toEqual([
      { type: "extension_ui_response", id: "req-a", value: "Approve" },
      { type: "extension_ui_response", id: "req-b", value: "Deny" },
    ]);
    // omp's select takes no words: the reason goes to the agent as a steer, after the refusal
    expect(child.sent("steer").at(-1)).toMatchObject({ message: "[bash 거절 사유] not now" });
    const after = await context.controller.getTranscript(session.id);
    expect(after.find((item) => item.id === `${session.id}:call_a`)).toMatchObject({ status: "approved" });
    expect(after.find((item) => item.id === `${session.id}:call_b`)).toMatchObject({ status: "denied" });
    expect(after.find((item) => item.id === `${session.id}:call_b`)).not.toHaveProperty("permissionOptions");
    expect(await statusOf(context)).toBe("running");
    await expect(context.controller.resolveToolCall(`${session.id}:call_a`, { optionId: "allow_once" })).rejects.toThrow("No pending permission");
  });

  it("answers a card with omp's session grant label, wherever the answer comes from", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames(
      { type: "tool_execution_start", toolCallId: "call_s", toolName: "bash", args: { command: "echo s" } },
      { type: "extension_ui_request", id: "req-s", method: "select", title: "Allow tool: bash\nCommand: echo s", options: ["Approve", "Approve bash for this session", "Deny"] },
    );
    await settle();
    await context.controller.resolveToolCall(`${session.id}:call_s`, { optionId: "allow_session" });
    expect(uiResponses(child).at(-1)).toEqual({ type: "extension_ui_response", id: "req-s", value: "Approve bash for this session" });
    expect(child.sent("steer")).toEqual([]);
  });

  it("answers from a project command rule without a card, and saves a rule a card asks for", async () => {
    const context = setup({ rules: { "echo ": "allow" } });
    const { session, child } = await working(context);
    child.emitFrames(
      { type: "tool_execution_start", toolCallId: "call_r", toolName: "bash", args: { command: "echo ok" } },
      { type: "extension_ui_request", id: "req-r", method: "select", title: "Allow tool: bash\nCommand: echo ok", options: ["Approve", "Deny"] },
      { type: "tool_execution_start", toolCallId: "call_s", toolName: "bash", args: { command: "npm test" } },
      { type: "extension_ui_request", id: "req-s", method: "select", title: "Allow tool: bash\nCommand: npm test", options: ["Approve", "Deny"] },
    );
    await settle();
    expect(uiResponses(child)).toEqual([{ type: "extension_ui_response", id: "req-r", value: "Approve" }]);
    const rows = await context.controller.getTranscript(session.id);
    expect(rows.find((item) => item.id === `${session.id}:call_r`)).toMatchObject({ status: "approved", autoDecision: { prefix: "echo ", decision: "allow" } });
    await context.controller.resolveToolCall(`${session.id}:call_s`, { optionId: "allow_once", rule: { prefix: "npm test" } });
    expect(context.addRule).toHaveBeenCalledWith(context.workspace, "npm test", "allow");
    expect(uiResponses(child).at(-1)).toEqual({ type: "extension_ui_response", id: "req-s", value: "Approve" });
  });

  it("shows a prompt it cannot pair as a card of its own, and closes it when omp cancels it", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames({ type: "extension_ui_request", id: "req-x", method: "select", title: "Allow tool: write\nPath: notes.md", options: ["Approve", "Deny"] });
    await settle();
    const id = `${session.id}:ui:approval-req-x`;
    expect((await context.controller.getTranscript(session.id)).find((item) => item.id === id)).toMatchObject({
      kind: "tool",
      name: "write",
      description: "Path: notes.md",
      status: "approval-required",
    });
    child.emitFrames({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "req-x" });
    await settle();
    expect((await context.controller.getTranscript(session.id)).find((item) => item.id === id)).toMatchObject({ status: "cancelled" });
    expect(await statusOf(context)).toBe("running");
  });

  it("asks the ask tool's form as question cards and answers with its data once every field has one", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames({
      type: "extension_ui_request",
      id: "form-1",
      method: "form",
      html: '<form><fieldset><legend>Pick a color</legend><label><input type="radio" name="color" value="Red"> Red</label><label><input type="radio" name="color" value="Blue"> Blue</label></fieldset><label>Why <input type="text" name="why"></label></form>',
    });
    await settle();
    const pending = await context.controller.listPendingQuestions(session.id);
    expect(pending.map((card) => [card.question, card.options.map((option) => option.label)])).toEqual([
      ["Pick a color", ["Red", "Blue"]],
      ["Why", []],
    ]);
    expect(await statusOf(context)).toBe("waiting");
    await context.controller.answerQuestion(session.id, pending[0]!.id, { selected: ["Blue"] });
    expect(uiResponses(child)).toEqual([]);
    await context.controller.answerQuestion(session.id, pending[1]!.id, { selected: [], custom: "calm" });
    await settle();
    expect(uiResponses(child)).toEqual([{ type: "extension_ui_response", id: "form-1", data: { color: "Blue", why: "calm" } }]);
    const cards = (await context.controller.getTranscript(session.id)).filter((item) => item.kind === "question");
    expect(cards.map((card) => card.kind === "question" && [card.status, card.answerSummary])).toEqual([
      ["answered", "Blue"],
      ["answered", "calm"],
    ]);
    expect(await statusOf(context)).toBe("running");
  });

  it("keeps a card open with a reason when the answer does not fit, and maps confirm, input and notify", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames(
      { type: "extension_ui_request", id: "f", method: "form", html: '<form><label>Env <select name="env"><option value="dev">Dev</option></select></label></form>' },
      { type: "extension_ui_request", id: "c", method: "confirm", title: "Overwrite?", message: "notes.md exists" },
      { type: "extension_ui_request", id: "i", method: "input", title: "Branch name" },
      { type: "extension_ui_request", id: "n", method: "notify", message: "Indexed 3 files", notifyType: "info" },
      { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "x" },
    );
    await settle();
    const [envCard, confirmCard, inputCard] = await context.controller.listPendingQuestions(session.id);
    await context.controller.answerQuestion(session.id, envCard!.id, { selected: [], custom: "prod" });
    expect((await context.controller.listPendingQuestions(session.id))[0]).toMatchObject({ status: "rejected", error: "목록에서 골라 주세요" });
    expect(confirmCard).toMatchObject({ question: "Overwrite?\nnotes.md exists", options: [{ label: "예" }, { label: "아니요" }] });
    await context.controller.answerQuestion(session.id, confirmCard!.id, { selected: ["예"] });
    await context.controller.answerQuestion(session.id, inputCard!.id, { selected: [], custom: "feat/x" });
    await settle();
    expect(uiResponses(child)).toEqual([
      { type: "extension_ui_response", id: "c", confirmed: true },
      { type: "extension_ui_response", id: "i", value: "feat/x" },
    ]);
    const notice = (await context.controller.getTranscript(session.id)).find((item) => item.kind === "notice");
    expect(notice).toMatchObject({ title: "omp", content: "Indexed 3 files", tone: "neutral" });
  });

  it("closes the open cards when omp ends", async () => {
    const context = setup();
    const { session, child } = await working(context);
    child.emitFrames({ type: "extension_ui_request", id: "i", method: "input", title: "Branch name" });
    await settle();
    child.exit(1);
    await settle();
    // the card closes; once the file is read back the ask tool's own row tells how it ended
    expect(context.events).toContainEqual(expect.objectContaining({ type: "question.updated", question: expect.objectContaining({ status: "closed", answerable: false }) }));
    expect(await context.controller.listPendingQuestions(session.id)).toEqual([]);
  });
});

describe("OmpRpcController model, commands, compaction, queue and side questions (P4)", () => {
  it("offers omp's model picker and thinking levels to the composer, and changes them", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    // the picker and the catalog answer after the chat opens
    for (let tries = 0; tries < 20 && !context.events.some((event) => event.type === "session.config" && event.options[0]?.scopes); tries += 1) await settle();
    const config = context.events.filter((event) => event.type === "session.config").at(-1);
    expect(config).toMatchObject({
      sessionId: session.id,
      options: [
        { id: "model", category: "model", currentValue: "opencodex/deepseek-flash", options: [{ value: "opencodex/deepseek-flash", name: "DeepSeek Flash", group: "opencodex", kind: "model" }, { value: "anthropic/claude-x" }] },
        { id: "thinking", category: "thought_level", currentValue: "low", options: [{ value: "off" }, { value: "auto" }, { value: "low" }, { value: "high" }] },
      ],
    });
    // the picker's rows carry the catalog's figures and the roles models hold; only the main scope takes a choice
    const model = config?.type === "session.config" ? config.options.find((option) => option.id === "model") : undefined;
    expect(model?.options?.map((choice) => choice.catalog)).toEqual([
      { provider: "opencodex", recent: true, tokensPerSecond: 132, contextWindow: 950000, cost: { input: 0, output: 0 } },
      { provider: "anthropic", roles: [{ role: "smol", label: "SMOL" }], intelligence: 61.5, contextWindow: 200000, cost: { input: 3, output: 15 } },
    ]);
    expect(model?.scopes).toEqual([
      { id: "default", name: "메인", enabled: true, current: "DeepSeek Flash" },
      { id: "smol", name: "smol", enabled: false, current: "Claude X" },
    ]);
    await context.controller.setSessionConfig(session.id, "model", "opencodex/opengateway/deepseek/flash");
    await context.controller.setSessionConfig(session.id, "thinking", "auto");
    await expect(context.controller.cycleThinking(session.id)).resolves.toBe("high");
    const child = context.processes[0]!.child;
    expect(child.sent("set_model")[0]).toMatchObject({ provider: "opencodex", modelId: "opengateway/deepseek/flash" });
    expect(child.sent("set_thinking_level")[0]).toMatchObject({ level: "auto" });
    await expect(context.controller.setSessionConfig(session.id, "model", "bad")).rejects.toThrow("provider/id");
  });

  it("follows omp's command list, compaction and retries on the row", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    const child = context.processes[0]!.child;
    child.emitFrames(
      { type: "available_commands_update", commands: [{ name: "btw", description: "Side question", source: "builtin" }, { description: "nameless" }] },
      { type: "manual_compaction_start" },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" },
    );
    await settle();
    const goalCommand = { name: "goal", description: "목표 모드: 목표 정하기, pause, resume, drop", hint: "[set] <목표>" };
    expect(context.events).toContainEqual({ type: "session.commands", sessionId: session.id, commands: [{ name: "btw", description: "Side question" }, goalCommand] });
    // a list without btw or goal still offers them: the RPC answers them
    expect(context.events).toContainEqual({
      type: "session.commands",
      sessionId: session.id,
      commands: [
        { name: "compact", description: "Compact the context", hint: "[instructions]" },
        { name: "btw", description: "대화에 남기지 않고 묻는 사이드 질문", hint: "<질문>" },
        goalCommand,
      ],
    });
    const row = (await context.controller.listSessions())[0]!;
    expect(row).toMatchObject({ phase: "compacting", retry: { attempt: 1, maxAttempts: 3, error: "overloaded" } });
    child.emitFrames({ type: "manual_compaction_end", aborted: false }, { type: "auto_retry_end", success: true, attempt: 1 });
    await settle();
    const settled = (await context.controller.listSessions())[0]!;
    expect(settled.phase).toBeUndefined();
    expect(settled.retry).toBeUndefined();
    await context.controller.compactSession(session.id);
    expect(child.sent("compact")).toHaveLength(1);
  });

  it("lists omp's queue and delivers it now, and steers or queues a running turn", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.sendMessage(session.id, { text: "first", images: [], files: [] });
    const child = context.processes[0]!.child;
    child.emitFrames({ type: "queue_update", steering: ["a"], followUp: ["b"], liveSteered: 0 });
    await settle();
    expect(await context.controller.listQueuedMessages(session.id)).toEqual([
      { id: "steer-0", text: "a", mode: "steer", label: "a" },
      { id: "follow-0", text: "b", mode: "followUp", label: "b" },
    ]);
    await expect(context.controller.flushQueuedNow(session.id)).resolves.toBe(true);
    await context.controller.steerSession(session.id, { text: "steer it", images: [], files: [] });
    await context.controller.queueFollowUp(session.id, { text: "later", images: [], files: [] });
    expect(child.sent("steer").at(-1)).toMatchObject({ message: "steer it" });
    expect(child.sent("follow_up").at(-1)).toMatchObject({ message: "later" });
  });

  it("answers a side question from omp's btw record", async () => {
    const context = setup();
    const session = await newChat(context);
    const answer = context.controller.askSideQuestion(session.id, "what is this repo?");
    await settle();
    const child = context.processes[0]!.child;
    expect(child.sent("btw")[0]).toMatchObject({ question: "what is this repo?" });
    child.emitFrames(
      { type: "btw_delta", recordId: "btw-1", delta: "A desk" },
      { type: "btw_record", record: { id: "btw-1", leafId: null, question: "q", answer: "A desktop app.", status: "complete", createdAt: 1, updatedAt: 2 } },
    );
    await expect(answer).resolves.toBe("A desktop app.");
  });
});

describe("OmpRpcController status line and subagents (P6)", () => {
  it("tells the status line how long the turn runs, what it does, its todo progress and context", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.sendMessage(session.id, { text: "go", images: [], files: [] });
    const child = context.processes[0]!.child;
    child.emitFrames({ type: "agent_start" }, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } });
    await settle();
    const row = (await context.controller.listSessions())[0]!;
    expect(row.liveStatus).toMatchObject({ activity: "bash · npm test", contextPercent: 1.5 });
    expect(row.liveStatus?.turnStartedAtMs).toEqual(expect.any(Number));
  });

  it("lists the subagents omp reports, with what their progress says", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    const child = context.processes[0]!.child;
    expect(child.sent("set_subagent_subscription")[0]).toMatchObject({ level: "progress" });
    child.emitFrames(
      { type: "subagent_lifecycle", payload: { id: "sa-1", agent: "scout", status: "started", description: "find the parser", sessionFile: "/tmp/sa-1.jsonl" } },
      { type: "subagent_progress", payload: { id: "sa-1", progress: { status: "running", model: "deepseek-flash", toolCount: 3, contextTokens: 5000, contextWindow: 100000, cost: 0.0123, lastActivity: "grep parser" } } },
    );
    await settle();
    expect(await context.controller.listSubagents(session.id)).toEqual([
      {
        id: "sa-1",
        label: "scout",
        status: "running",
        objective: "find the parser",
        model: "deepseek-flash",
        costUsd: 0.0123,
        contextTokens: 5000,
        contextWindow: 100000,
        toolCount: 3,
        recent: "grep parser",
        sessionFile: "/tmp/sa-1.jsonl",
      },
    ]);
  });
});

describe("OmpRpcController context breakdown", () => {
  it("reads omp's /context report with no model call or row, with the model and where auto-compaction starts", async () => {
    const context = setup();
    const session = await newChat(context);
    const before = context.events.length;
    const breakdown = await context.controller.getContextBreakdown(session.id);
    const child = context.processes[0]!.child;
    expect(child.sent("prompt").map((frame) => frame.message)).toEqual(["/context"]);
    expect(context.prompts()).toBe(0);
    expect(breakdown).toMatchObject({
      model: "DeepSeek Flash",
      contextWindow: 950000,
      usedTokens: 14350,
      autoCompactBufferTokens: 142500,
      freeTokens: 793150,
      autoCompactAtTokens: 807500,
    });
    expect(breakdown!.categories.map((category) => [category.id, category.tokens])).toEqual([
      ["systemPrompt", 1861],
      ["systemTools", 5743],
      ["systemContext", 0],
      ["instructionFiles", 0],
      ["skills", 0],
      ["messages", 6746],
    ]);
    expect(context.events.slice(before).filter((event) => event.type.startsWith("transcript"))).toEqual([]);
    const row = (await context.controller.listSessions())[0]!;
    expect(row.liveStatus).toMatchObject({ contextPercent: 1.5, contextTokens: 14350, contextWindow: 950000 });
  });
});

describe("OmpRpcController slash commands omp answers itself", () => {
  it("leaves the chat idle and shows what the command printed", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.sendMessage(session.id, { text: "/session", images: [], files: [] })).resolves.toBe("prompt");
    await settle();
    expect((await context.controller.listSessions())[0]!.status).toBe("idle");
    const notice = context.events.find((event) => event.type === "transcript.appended" && event.item.kind === "notice");
    expect(notice).toMatchObject({ item: { kind: "notice", title: "omp", content: "Session\n  Messages: 4", tone: "neutral" } });
  });

  it("shows no notice for the report the context dialog reads", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.getContextBreakdown(session.id);
    expect(context.events.some((event) => event.type === "transcript.appended" && event.item.kind === "notice")).toBe(false);
  });
});

describe("OmpRpcController goal mode", () => {
  it("sets a goal from /goal, shows it on the goal row with omp's operations, and pauses, resumes and drops it", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.getGoal(session.id)).resolves.toMatchObject({ enabled: false });
    await expect(context.controller.sendMessage(session.id, { text: "/goal ship the parser", images: [], files: [] })).resolves.toBe("prompt");
    const child = context.processes[0]!.child;
    expect(child.sent("goal").at(-1)).toMatchObject({ op: "create", objective: "ship the parser" });
    expect(child.sent("prompt")).toEqual([]);
    await expect(context.controller.getGoal(session.id)).resolves.toEqual({
      enabled: true,
      mode: "active",
      objective: "ship the parser",
      completed: 0,
      total: 0,
      operations: ["pause", "resume", "drop"],
    });
    await expect(context.controller.operateGoal(session.id, "pause")).resolves.toMatchObject({ mode: "paused" });
    await context.controller.sendMessage(session.id, { text: "/goal resume", images: [], files: [] });
    await expect(context.controller.getGoal(session.id)).resolves.toMatchObject({ mode: "active" });
    await expect(context.controller.operateGoal(session.id, "complete")).rejects.toMatchObject({ code: "unsupported" });
    await expect(context.controller.sendMessage(session.id, { text: "/goal budget 5000", images: [], files: [] })).resolves.toMatchObject({ kind: "not_executed" });
    await expect(context.controller.operateGoal(session.id, "drop")).resolves.toMatchObject({ enabled: false });
    expect(context.prompts()).toBe(0);
  });
});

describe("OmpRpcController subagent control", () => {
  it("stops a subagent, tells it more, and reads its conversation as the panel's rows", async () => {
    const context = setup();
    const session = await newChat(context);
    // no omp yet: nothing to stop, nothing to tell
    await expect(context.controller.cancelSubagent(session.id, "sa-1")).resolves.toBe(false);
    await expect(context.controller.steerSubagent(session.id, "sa-1", "x")).rejects.toThrow("not running");
    await context.controller.refreshSessionContext(session.id);
    const child = context.processes[0]!.child;
    await expect(context.controller.cancelSubagent(session.id, "sa-1")).resolves.toBe(true);
    await expect(context.controller.cancelSubagent(session.id, "sa-2")).resolves.toBe(false);
    await context.controller.steerSubagent(session.id, "sa-1", "  also check tests  ");
    expect(child.sent("steer_subagent")[0]).toMatchObject({ subagentId: "sa-1", message: "also check tests" });
    await expect(context.controller.getSubagentMessages(session.id, "sa-1")).resolves.toEqual([
      { role: "user", text: "find the parser" },
      { role: "assistant", text: "Looking." },
      { role: "tool", tool: "grep", text: "parse" },
      { role: "tool", tool: "grep", text: "src/parse.ts" },
      { role: "tool", tool: "read", text: "ENOENT", error: true },
    ]);
    expect(child.sent("get_subagent_messages")[0]).toMatchObject({ subagentId: "sa-1" });
  });
});

describe("OmpRpcController queue editing", () => {
  it("lists omp's queue on the row and sends a follow-up now or takes a message out", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    const child = context.processes[0]!.child;
    child.emitFrames({ type: "queue_update", steering: ["now"], followUp: ["later"] });
    await settle();
    const updated = context.events.filter((event) => event.type === "session.updated").at(-1);
    expect(updated).toMatchObject({
      session: {
        liveStatus: {
          queued: [
            { id: "steer-0", text: "now", mode: "steer", label: "now" },
            { id: "follow-0", text: "later", mode: "followUp", label: "later" },
          ],
        },
      },
    });
    await expect(context.controller.promoteQueuedMessage(session.id, "later")).resolves.toBe(true);
    await expect(context.controller.removeQueuedMessage(session.id, "now", "steer")).resolves.toBe(true);
    expect(child.sent("remove_queued_message")[0]).toMatchObject({ message: "now", queue: "steering" });
    await expect(context.controller.removeQueuedMessage(session.id, "later", "followUp")).resolves.toBe(false);
  });
});

describe("OmpRpcController switches", () => {
  it("shows omp's switches from its state and flips them", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.refreshSessionContext(session.id);
    await settle();
    let row = (await context.controller.listSessions())[0]!;
    expect(row.liveStatus?.modes).toEqual([
      { id: "fast", enabled: false },
      { id: "autoCompaction", enabled: true },
      { id: "autoRetry", enabled: true, assumed: true },
    ]);
    await context.controller.setRuntimeMode(session.id, "fast", true);
    await context.controller.setRuntimeMode(session.id, "autoCompaction", false);
    await context.controller.setRuntimeMode(session.id, "autoRetry", false);
    const child = context.processes[0]!.child;
    expect(child.sent("set_fast_mode")[0]).toMatchObject({ enabled: true });
    expect(child.sent("set_auto_retry")[0]).toMatchObject({ enabled: false });
    row = (await context.controller.listSessions())[0]!;
    expect(row.liveStatus?.modes).toEqual([
      { id: "fast", enabled: true, inactive: true },
      { id: "autoCompaction", enabled: false },
      { id: "autoRetry", enabled: false },
    ]);
  });
});

describe("OmpRpcController session statistics", () => {
  it("reads cost, tokens and requests from get_session_stats", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.getSessionStats(session.id)).resolves.toEqual({
      costUsd: 0.0123,
      tokens: { input: 724, output: 52, reasoning: 3, cacheRead: 43520, cacheWrite: 0, total: 44296 },
      requests: 3,
      userMessages: 2,
      toolCalls: 1,
      premiumRequests: 0,
    });
    expect(context.prompts()).toBe(0);
  });
});

describe("OmpRpcController session name", () => {
  it("names omp's session when the chat is renamed, now or when its omp starts", async () => {
    const context = setup();
    const session = await newChat(context);
    await context.controller.renameSession(session.id, "before start");
    await context.controller.refreshSessionContext(session.id);
    const child = context.processes[0]!.child;
    expect(child.sent("set_session_name")).toMatchObject([{ name: "before start" }]);
    await context.controller.renameSession(session.id, "while running");
    expect(child.sent("set_session_name").at(-1)).toMatchObject({ name: "while running" });
    expect(context.controller.sessionTitle(session.id)).toBe("while running");
  });
});

describe("OmpRpcController HTML export", () => {
  it("asks omp to write the page where the save dialog chose", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.exportSessionHtml(session.id, "/tmp/out/chat.html")).resolves.toBe("/tmp/out/chat.html");
    expect(context.processes[0]!.child.sent("export_html")[0]).toMatchObject({ outputPath: "/tmp/out/chat.html" });
  });
});

describe("OmpRpcController tree, fork and branch", () => {
  it("flattens omp's tree with the current branch first and marked", async () => {
    const context = setup();
    const session = await newChat(context);
    await expect(context.controller.getSessionTree(session.id)).resolves.toEqual([
      { id: "u1", role: "user", text: "first question", depth: 0, onPath: true, current: false },
      { id: "a2", role: "tool", text: "bash", depth: 0, onPath: true, current: true, label: "retry" },
      { id: "a1", role: "assistant", text: "old answer", depth: 1, onPath: false, current: false },
    ]);
  });

  it("forks into a new chat with an omp of its own, and rewrites from a message in place", async () => {
    const context = setup();
    const source = await newChat(context, "source");
    await context.controller.refreshSessionContext(source.id);
    writeFileSync(context.sessionFile, "{}\n");
    const fork = await context.controller.forkSession({ sourceSessionId: source.id, entryId: "u1" });
    expect(fork).toMatchObject({ title: "source (포크)", parentId: source.id, runtime: "omp-rpc" });
    expect(context.processes).toHaveLength(2);
    expect(context.processes[1]!.args).toContain("--resume");
    expect(context.processes[1]!.child.sent("fork")[0]).toMatchObject({ entryId: "u1" });
    expect(context.store.get(fork.id)?.sessionFile).toBe(path.join(context.workspace, "fork-u1.jsonl"));
    expect(context.store.get(source.id)?.sessionFile).toBe(context.sessionFile);
    expect(context.events).toContainEqual({ type: "session.created", session: expect.objectContaining({ id: fork.id }) });
    await expect(context.controller.branchSession(source.id, "u1")).resolves.toBe("rewrite me");
    expect(context.store.get(source.id)?.sessionFile).toBe(path.join(context.workspace, "branch.jsonl"));
  });

  it("drops the new chat when omp cannot fork", async () => {
    const context = setup();
    const source = await newChat(context, "source");
    await expect(context.controller.forkSession({ sourceSessionId: source.id })).rejects.toThrow("nothing to fork");
    expect(context.store.list()).toHaveLength(1);
  });
});
