import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/agent-contract.js";
import type { AgentAvailability } from "../../shared/terminal-ipc.js";
import { TerminalSessionStore } from "../terminal-session-store.js";
import { HerdrAgentController } from "./agent-controller.js";
import { claudeTranscriptPath } from "./claude-session.js";
import { HcReplyError, type ChannelHandlers, type HcConnection, type HelloInfo } from "./connection.js";
import type { HookChannel } from "./agent-hooks.js";
import type { PrepareWorktree } from "../worktree-service.js";

function hookChannel() {
  const replies: string[] = [];
  const listeners: (() => void)[] = [];
  let closed = false;
  const channel: HookChannel & { replies: string[] } = {
    replies,
    reply(answer: string) {
      if (closed) return;
      closed = true;
      replies.push(answer);
      for (const listener of listeners.splice(0)) listener();
    },
    get closed() {
      return closed;
    },
    onClose(listener: () => void) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
  return channel;
}

function setup(
  options: {
    snapshot?: (store: TerminalSessionStore) => unknown[];
    installed?: boolean;
    startTerminal?: (record: { id: string }) => Promise<void>;
    readiness?: { timeoutMs?: number; pollMs?: number };
    prepareWorktree?: PrepareWorktree;
  } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "gajae-agents-"));
  const home = mkdtempSync(path.join(tmpdir(), "gajae-agents-home-"));
  const store = new TerminalSessionStore(directory);
  const events: AgentEvent[] = [];
  let stream: ChannelHandlers | undefined;
  const calls: { method: string; params: unknown }[] = [];
  const hc = {
    open: vi.fn(async (_method: string, _params: unknown, handlers: ChannelHandlers) => {
      stream = handlers;
      return { result: { seq: 0, terminals: options.snapshot?.(store) ?? [] }, channel: { close: async () => undefined } };
    }),
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    }),
  };
  const endTerminal = vi.fn(async () => undefined);
  const claim = vi.fn();
  const detect = vi.fn(async (id: string): Promise<AgentAvailability> =>
    options.installed === false
      ? { id: id as AgentAvailability["id"], name: "Claude Code", installed: false, reason: "설치되어 있지 않습니다" }
      : { id: id as AgentAvailability["id"], name: id, installed: true, binary: `/bin/${id}` },
  );
  const controller = new HerdrAgentController({
    store,
    core: {
      connection: async () => hc as unknown as HcConnection,
      core: { version: "0.1.18", core: { id: "core-1", name: "mac" }, methods: [], features: [] } as HelloInfo,
      isRunning: () => true,
    },
    endTerminal,
    detect,
    listAgents: async () => [],
    claudeSettingsPath: () => "/data/agent-hooks/claude-settings.json",
    hooksListening: () => true,
    emit: (event) => events.push(event),
    claim,
    home,
    log: () => undefined,
    ...(options.startTerminal ? { startTerminal: options.startTerminal } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.prepareWorktree ? { prepareWorktree: options.prepareWorktree } : {}),
  });
  const push = (type: string, terminal: string, data: Record<string, unknown>) =>
    stream!.onData(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, terminal, data, seq: 1 } })}\n`));
  const statuses = () => events.flatMap((event) => (event.type === "session.updated" ? [event.session.status] : []));
  const activities = () => events.flatMap((event) => (event.type === "session.activity" ? [event.category] : []));
  return { controller, store, events, hc, calls, push, statuses, activities, endTerminal, claim, detect, directory, home };
}

const STATUS = (state: string | null) => ({ reported: true, records: {}, status: state === null ? null : { app: "claude-code", state } });

describe("HerdrAgentController sessions", () => {
  it("creates an agent session for an installed agent, claims it and announces it", async () => {
    const { controller, claim, events, directory } = setup();
    const session = await controller.createSession({ runtime: "herdr", agentKind: "claude", workspace: directory, title: "리뷰", isolation: "workspace", launch: { model: "haiku" } });
    expect(session).toMatchObject({ id: expect.stringMatching(/^terminal-/u), runtime: "herdr", agentKind: "claude", status: "idle", title: "리뷰" });
    expect(session.subtitle).toMatch(/^Claude Code · /u);
    expect(claim).toHaveBeenCalledWith(session.id);
    expect(events[0]).toEqual({ type: "session.created", session });
  });

  it("refuses an agent that is not installed, GJC, and a missing folder", async () => {
    const missing = setup({ installed: false });
    await expect(missing.controller.createTerminalSession({ title: "a", workspace: missing.directory, agentKind: "claude" })).rejects.toThrow("Claude Code: 설치되어 있지 않습니다");
    const { controller, directory } = setup();
    await expect(controller.createTerminalSession({ title: "a", workspace: directory, agentKind: "gjc" })).rejects.toThrow(/invalid/u);
    await expect(controller.createTerminalSession({ title: "a", workspace: path.join(directory, "nope"), agentKind: "shell" })).rejects.toThrow(/existing folder/u);
  });

  it("launches Claude Code on the session id it recorded, with the hook settings", async () => {
    const { controller, store, directory } = setup();
    const session = await controller.createTerminalSession({ title: "a", workspace: directory, agentKind: "claude" });
    const record = store.get(session.id)!;
    const plan = await controller.launchPlan(record);
    expect(plan.argv).toEqual(["/bin/claude", "--session-id", record.agentSessionRef, "--settings", "/data/agent-hooks/claude-settings.json"]);
    expect(plan.env).toEqual({ GAJAE_SESSION_ID: session.id });
  });

  it("ends the terminal, forgets the session and tells everyone on delete", async () => {
    const { controller, store, events, endTerminal, directory } = setup();
    const session = await controller.createTerminalSession({ title: "a", workspace: directory, agentKind: "shell" });
    await controller.deleteSession(session.id);
    expect(endTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
    expect(store.get(session.id)).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "session.deleted", sessionId: session.id });
  });

  it("hides shells from remote devices, not agents", async () => {
    const { controller, directory } = setup();
    const shell = await controller.createTerminalSession({ title: "s", workspace: directory, agentKind: "shell" });
    const agent = await controller.createTerminalSession({ title: "c", workspace: directory, agentKind: "codex" });
    expect(controller.hiddenFromRemote(shell.id)).toBe(true);
    expect(controller.hiddenFromRemote(agent.id)).toBe(false);
    expect(controller.hiddenFromRemote("terminal-gone")).toBe(false);
  });

  it("refuses sending to a session it does not have, or one with no chat", async () => {
    const { controller, directory } = setup();
    const text = { text: "hi", images: [], files: [] };
    await expect(controller.sendMessage("terminal-1", text)).rejects.toMatchObject({ code: "unsupported" });
    const shell = await controller.createTerminalSession({ title: "s", workspace: directory, agentKind: "shell" });
    await expect(controller.sendMessage(shell.id, text)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("gives omp a chat screen beside the terminal, Claude Code its terminal only, and shells none", async () => {
    const { controller, directory } = setup();
    const claude = await controller.createTerminalSession({ title: "c", workspace: directory, agentKind: "claude" });
    const omp = await controller.createTerminalSession({ title: "o", workspace: directory, agentKind: "omp" });
    const shell = await controller.createTerminalSession({ title: "s", workspace: directory, agentKind: "shell" });
    expect(claude.surfaces).toEqual(["terminal"]);
    // omp's chat is its RPC session, so its terminal session shows only the terminal
    expect(omp.surfaces).toEqual(["terminal"]);
    expect(claude.capabilities).toMatchObject({ send: false, cancel: true, approvals: false, attachments: false, streaming: false, goal: false, git: false });
    expect(shell.surfaces).toEqual(["terminal"]);
    expect(await controller.getTranscriptPage(shell.id)).toMatchObject({ items: [] });
  });
});

describe("HerdrAgentController sessions in a worktree", () => {
  /** A repository with one commit; its worktrees land beside it, inside its own parent folder. */
  function repository(): string {
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "gajae-agents-repo-")));
    const repo = path.join(parent, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe", encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README"), "seed");
    git("add", "README");
    git("commit", "-q", "-m", "seed");
    return repo;
  }
  const gitIn = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" });

  it("starts the session in a new worktree on a branch of its own, records it, and fills it from the project's settings", async () => {
    const repo = repository();
    const prepare = vi.fn<PrepareWorktree>(async () => ({ problems: { copy: [] } }));
    const { controller, store, events, claim } = setup({ prepareWorktree: prepare });
    const session = await controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "claude", isolation: "worktree" });
    const worktree = session.worktree!;
    expect(worktree).toMatchObject({ sourceWorkspace: repo, managed: true });
    expect(worktree.path).toContain(`${path.sep}repo.gajae-worktrees${path.sep}`);
    expect(worktree.branch).toMatch(/^peacock\/[0-9a-z]+-[0-9a-f]{6}$/u);
    expect(session.workspace).toBe(worktree.path);
    expect(existsSync(path.join(worktree.path, "README"))).toBe(true);
    expect(gitIn(worktree.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(worktree.branch);
    expect(prepare).toHaveBeenCalledWith(worktree);
    expect(store.get(session.id)).toMatchObject({ workspace: worktree.path, worktree });
    expect(claim).toHaveBeenCalledWith(session.id);
    expect(events[0]).toEqual({ type: "session.created", session });
  });

  it("keeps the worktree across a restart, and offers it on the listed row", async () => {
    const repo = repository();
    const { controller, directory } = setup();
    const session = await controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "codex", isolation: "worktree", worktreeBranch: "feat/own" });
    expect(session.worktree?.branch).toBe("feat/own");
    const reloaded = new TerminalSessionStore(directory);
    expect(reloaded.get(session.id)?.worktree).toEqual(session.worktree);
    expect((await controller.listSessions()).find((row) => row.id === session.id)?.worktree).toEqual(session.worktree);
  });

  it("tells the caller, and only the caller, what the worktree's setup did not manage", async () => {
    const repo = repository();
    const prepare: PrepareWorktree = async () => ({
      problems: { copy: [{ path: ".env", reason: "symlink" }], setup: { status: "failed", exitCode: 2, output: "boom", durationMs: 1 } },
    });
    const { controller, events } = setup({ prepareWorktree: prepare });
    const session = await controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "claude", isolation: "worktree" });
    expect(session.worktreeSetup).toEqual({
      copyProblems: [{ path: ".env", reason: "symlink" }],
      setup: { status: "failed", exitCode: 2, output: "boom" },
    });
    expect(events[0]).toMatchObject({ type: "session.created", session: expect.not.objectContaining({ worktreeSetup: expect.anything() }) });
    expect((await controller.listSessions())[0]).not.toHaveProperty("worktreeSetup");
  });

  it("opens the session even when preparing the worktree fails", async () => {
    const repo = repository();
    const { controller } = setup({
      prepareWorktree: async () => {
        throw new Error("settings unreadable");
      },
    });
    const session = await controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "shell", isolation: "worktree" });
    expect(session.worktree).toBeDefined();
    expect(session).not.toHaveProperty("worktreeSetup");
  });

  it("makes no worktree for a session it refuses", async () => {
    const repo = repository();
    const missing = setup({ installed: false });
    await expect(missing.controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "claude", isolation: "worktree" })).rejects.toThrow("설치되어 있지 않습니다");
    expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("gajae-worktrees");
    expect(existsSync(path.join(path.dirname(repo), "repo.gajae-worktrees"))).toBe(false);
  });

  it("takes the worktree and its branch back when the session cannot be recorded", async () => {
    const repo = repository();
    const { controller, store, claim } = setup();
    vi.spyOn(store, "create").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "claude", isolation: "worktree" })).rejects.toThrow("disk full");
    expect(claim).not.toHaveBeenCalled();
    expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("gajae-worktrees");
    expect(gitIn(repo, "branch", "--list", "peacock/*").trim()).toBe("");
  });

  it("keeps a branch that was there before when it takes the worktree back", async () => {
    const repo = repository();
    gitIn(repo, "branch", "mine");
    const { controller, store } = setup();
    vi.spyOn(store, "create").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      controller.createTerminalSession({ title: "a", workspace: repo, agentKind: "claude", isolation: "worktree", worktreeBranch: "mine" }),
    ).rejects.toThrow("disk full");
    expect(gitIn(repo, "branch", "--list", "mine")).toContain("mine");
    expect(gitIn(repo, "worktree", "list", "--porcelain")).not.toContain("gajae-worktrees");
  });

  it("refuses a folder that is not in a repository, leaving no session", async () => {
    const { controller, store, directory } = setup();
    await expect(controller.createTerminalSession({ title: "a", workspace: directory, agentKind: "shell", isolation: "worktree" })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("asks nothing of the folder for a session that runs in it as it is", async () => {
    const repo = repository();
    const prepare = vi.fn<PrepareWorktree>(async () => ({ problems: { copy: [] } }));
    const { controller } = setup({ prepareWorktree: prepare });
    const session = await controller.createSession({ runtime: "herdr", agentKind: "claude", workspace: repo, isolation: "workspace" });
    expect(session.workspace).toBe(repo);
    expect(session.worktree).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("takes the isolation of a session made through the router", async () => {
    const repo = repository();
    const { controller } = setup();
    const session = await controller.createSession({ runtime: "herdr", agentKind: "claude", workspace: repo, isolation: "worktree", worktreeBranch: "feat/router" });
    expect(session.worktree?.branch).toBe("feat/router");
    expect(readFileSync(path.join(session.workspace, "README"), "utf8")).toBe("seed");
  });
});

describe("HerdrAgentController status", () => {
  async function agentSession(fixture: ReturnType<typeof setup>) {
    const session = await fixture.controller.createTerminalSession({ title: "작업", workspace: fixture.directory, agentKind: "claude" });
    fixture.store.bindTerminal(session.id, { coreId: "core-1", terminalAddress: "t1" });
    await fixture.controller.launchPlan(fixture.store.get(session.id)!);
    await vi.waitFor(() => expect(fixture.hc.open).toHaveBeenCalled());
    fixture.push("created", "t1", { address: "t1", state: "live", reported: false, labels: { "gajae.session": session.id } });
    fixture.events.length = 0;
    return session;
  }

  it("follows 7501 through working, waiting and done, and announces the wait and the finished turn", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    fixture.push("status", "t1", STATUS("blocked"));
    fixture.push("status", "t1", STATUS(null));
    fixture.push("status", "t1", STATUS("idle"));
    fixture.push("status", "t1", STATUS("working"));
    fixture.push("status", "t1", STATUS("done"));
    // a brief null keeps waiting; done is idle with the turn announced
    expect(fixture.statuses()).toEqual(["waiting", "idle", "running", "idle"]);
    expect(fixture.activities()).toEqual(["permission", "completed"]);
    expect(fixture.events.find((event) => event.type === "session.activity")).toEqual({
      type: "session.activity",
      sessionId: session.id,
      title: "작업",
      unread: true,
      category: "permission",
    });
    expect((await fixture.controller.listSessions())[0]).toMatchObject({ status: "idle", unread: true, runRevision: 5 });
    await fixture.controller.markSessionRead(session.id);
    expect((await fixture.controller.listSessions())[0]!.unread).toBe(false);
  });

  it("announces an agent that died, not one Gajae ended", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    fixture.push("status", "t1", STATUS("working"));
    fixture.push("finished", "t1", { exit_code: 1, reason: "exited" });
    expect(fixture.statuses().at(-1)).toBe("failed");
    expect(fixture.activities()).toEqual(["failed"]);

    const second = setup();
    const ended = await agentSession(second);
    second.push("status", "t1", STATUS("working"));
    const deleting = second.controller.deleteSession(ended.id);
    second.push("finished", "t1", { exit_code: null, reason: "killed", signal: 1 });
    await deleting;
    expect(second.activities()).toEqual([]);
    expect(session.id).not.toBe(ended.id);
  });

  it("takes what already was so from the snapshot without announcing it, then follows on", async () => {
    const fixture = setup({
      snapshot: (store) =>
        store.list().map((record) => ({ address: "t3", state: "live", reported: true, status: { state: "blocked" }, labels: { "gajae.session": record.id } })),
    });
    const session = await fixture.controller.createTerminalSession({ title: "x", workspace: fixture.directory, agentKind: "codex" });
    fixture.events.length = 0;
    fixture.controller.start();
    await vi.waitFor(() => expect(fixture.statuses()).toEqual(["waiting"]));
    expect(fixture.activities()).toEqual([]);
    fixture.push("status", "t3", STATUS("done"));
    expect(fixture.activities()).toEqual(["completed"]);
    expect((await fixture.controller.listSessions()).find((row) => row.id === session.id)?.status).toBe("idle");
  });

  it("stands hooks in for a program that does not report, and records the agent's session from SessionStart", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    fixture.controller.onHook({ event: "UserPromptSubmit", session: session.id, payload: {} });
    fixture.controller.onHook({ event: "Stop", session: session.id, payload: {} });
    expect(fixture.statuses()).toEqual(["running", "idle"]);
    expect(fixture.activities()).toEqual(["completed"]);

    fixture.controller.onHook({ event: "SessionStart", session: session.id, payload: { session_id: "new-ref", transcript_path: "/t/new-ref.jsonl", source: "clear" } });
    expect(fixture.store.get(session.id)).toMatchObject({ agentSessionRef: "new-ref", transcriptPath: "/t/new-ref.jsonl" });

    // once 7501 reports, hooks no longer move the status
    fixture.push("status", "t1", STATUS("working"));
    fixture.events.length = 0;
    fixture.controller.onHook({ event: "Stop", session: session.id, payload: {} });
    expect(fixture.events).toEqual([]);
  });

  it("finds a hook's session by the agent's own id when the terminal did not say", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    const ref = fixture.store.get(session.id)!.agentSessionRef!;
    fixture.controller.onHook({ event: "SessionStart", payload: { session_id: ref, transcript_path: "/t/a.jsonl" } });
    expect(fixture.store.get(session.id)!.transcriptPath).toBe("/t/a.jsonl");
  });

  it("catches up from Claude Code's pid file what the hooks said while the app was closed", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gajae-agents-"));
    const home = mkdtempSync(path.join(tmpdir(), "gajae-agents-home-"));
    mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "sessions", "777.json"), JSON.stringify({ pid: 777, sessionId: "after-clear", cwd: directory }));
    const store = new TerminalSessionStore(directory);
    const record = store.create({ title: "x", workspace: directory, agentKind: "claude", agentSessionRef: "before" });
    let stream: ChannelHandlers | undefined;
    const controller = new HerdrAgentController({
      store,
      core: {
        connection: async () =>
          ({
            open: async (_m: string, _p: unknown, handlers: ChannelHandlers) => {
              stream = handlers;
              return {
                result: { seq: 0, terminals: [{ address: "t2", state: "live", reported: true, status: { state: "idle" }, labels: { "gajae.session": record.id }, foreground: { pid: 777 } }] },
                channel: { close: async () => undefined },
              };
            },
          }) as unknown as HcConnection,
        core: { version: "0.1.18", core: { id: "core-1", name: "mac" }, methods: [], features: [] } as HelloInfo,
        isRunning: () => true,
      },
      endTerminal: async () => undefined,
      detect: async (id) => ({ id: id as AgentAvailability["id"], name: id, installed: true, binary: "/bin/x" }),
      listAgents: async () => [],
      emit: () => undefined,
      home,
      log: () => undefined,
    });
    controller.start();
    await vi.waitFor(() => expect(store.get(record.id)!.agentSessionRef).toBe("after-clear"));
    expect(store.get(record.id)!.transcriptPath).toMatch(/after-clear\.jsonl$/u);
    expect(stream).toBeDefined();
    controller.dispose();
  });

  it("offers sending only while the agent reports its state and its terminal runs", async () => {
    const fixture = setup();
    await agentSession(fixture);
    fixture.push("status", "t1", STATUS("idle"));
    const sendable = () => fixture.events.flatMap((event) => (event.type === "session.updated" ? [event.session.capabilities?.send] : []));
    expect(sendable()).toEqual([true]);
    fixture.push("finished", "t1", { exit_code: 0, reason: "exited" });
    expect(sendable()).toEqual([true, false]);
  });

  it("types a message into the agent's terminal, and reports a dialog it waits on as not executed", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    fixture.push("status", "t1", { reported: true, status: { app: "claude-code", state: "blocked", kind: "permission", msg: "approve Bash: rm x" } });
    fixture.hc.call.mockImplementationOnce(async () => {
      throw new HcReplyError("blocked", "t1 is blocked (permission)");
    });
    const text = { text: "  go on  ", images: [], files: [] };
    expect(await fixture.controller.sendMessage(session.id, text)).toEqual({ kind: "not_executed", detail: "approve Bash: rm x" });
    fixture.push("status", "t1", STATUS("idle"));
    expect(await fixture.controller.sendMessage(session.id, text)).toBe("prompt");
    expect(fixture.hc.call).toHaveBeenLastCalledWith("terminal.send", { terminal: "t1", text: "go on" }, 30_000);
    await expect(
      fixture.controller.sendMessage(session.id, { text: "x", images: [{ id: "i", name: "a.png", mimeType: "image/png", data: "" } as never], files: [] }),
    ).rejects.toThrow(/text only/u);
  });

  it("starts a parallel attempt's terminal with no window, waits out the folder-trust dialog, then types the request once", async () => {
    const started: string[] = [];
    let fixture: ReturnType<typeof setup>;
    fixture = setup({
      readiness: { pollMs: 5, timeoutMs: 2000 },
      startTerminal: async (record) => {
        started.push(record.id);
        // the terminal hc runs: bound, reported, and first showing Claude Code's trust dialog
        fixture.store.bindTerminal(record.id, { coreId: "core-1", terminalAddress: "t9" });
        await fixture.controller.launchPlan(fixture.store.get(record.id)!);
        await vi.waitFor(() => expect(fixture.hc.open).toHaveBeenCalled());
        fixture.push("created", "t9", { address: "t9", state: "live", reported: false, labels: { "gajae.session": record.id } });
        fixture.push("status", "t9", { reported: true, records: {}, status: { app: "claude-code", state: "blocked", kind: "permission", msg: "trust this folder" } });
      },
    });
    const session = await fixture.controller.createTerminalSession({ title: "시도", workspace: fixture.directory, agentKind: "claude" });
    const sent = fixture.controller.sendWhenReady(session.id, "  Reply OK  ");
    await vi.waitFor(() => expect(started).toEqual([session.id]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // nothing typed while the dialog waits on the user
    expect(fixture.calls.filter((call) => call.method === "terminal.send")).toEqual([]);
    fixture.push("status", "t9", STATUS("idle"));
    expect(await sent).toBe("prompt");
    expect(fixture.calls.filter((call) => call.method === "terminal.send").map((call) => call.params)).toEqual([{ terminal: "t9", text: "Reply OK" }]);
  });

  it("reports what the agent still waits on when it never gets ready", async () => {
    const fixture = setup({ readiness: { pollMs: 5, timeoutMs: 60 } });
    const session = await agentSession(fixture);
    fixture.push("status", "t1", { reported: true, status: { app: "claude-code", state: "blocked", kind: "permission", msg: "trust this folder" } });
    expect(await fixture.controller.sendWhenReady(session.id, "go")).toEqual({ kind: "not_executed", detail: expect.stringContaining("trust this folder") });
    const shell = await fixture.controller.createTerminalSession({ title: "셸", workspace: fixture.directory, agentKind: "shell" });
    await expect(fixture.controller.sendWhenReady(shell.id, "ls")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reads the Claude Code transcript as chat rows, and follows the file a /clear moves it to", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    const record = fixture.store.get(session.id)!;
    const line = (uuid: string, text: string) =>
      `${JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid, timestamp: "2026-11-24T06:00:00.000Z", origin: { kind: "human" }, permissionMode: "default" })}\n`;
    const first = claudeTranscriptPath(record.workspace, record.agentSessionRef!, fixture.home);
    mkdirSync(path.dirname(first), { recursive: true });
    writeFileSync(first, line("u1", "first"));
    expect((await fixture.controller.getTranscriptPage(session.id)).items).toMatchObject([{ id: `${session.id}:u1`, content: "first" }]);
    const second = path.join(path.dirname(first), "after-clear.jsonl");
    writeFileSync(second, line("u2", "second"));
    fixture.controller.onHook({ event: "SessionStart", session: session.id, payload: { session_id: "after-clear", transcript_path: second, source: "clear" } });
    expect((await fixture.controller.getTranscript(session.id)).map((item) => item.id)).toEqual([`${session.id}:u2`]);
    expect(fixture.events).toContainEqual({ type: "transcript.invalidated", sessionId: session.id });
    expect(await fixture.controller.getTranscriptRevision(session.id)).toMatch(/after-clear\.jsonl/u);
  });

  it("finds the transcript omp writes for a session, and keeps it and omp's session id on the record", async () => {
    const fixture = setup();
    const session = await fixture.controller.createTerminalSession({ title: "o", workspace: fixture.directory, agentKind: "omp" });
    const folder = path.join(fixture.home, ".omp", "agent", "sessions", `--${realpathSync(fixture.directory).replace(/^\//u, "").replace(/[/\\:]/gu, "-")}--`);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "2026-11-24T00-00-00-000Z_01abc.jsonl");
    writeFileSync(
      file,
      [
        { type: "title", v: 1, title: "", pad: " ".repeat(40) },
        { type: "session", version: 3, id: "01abc-def", timestamp: "2026-11-24T00:00:00.000Z", cwd: realpathSync(fixture.directory) },
        { type: "message", id: "e1", parentId: null, timestamp: "2026-11-24T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello omp" }] } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    expect((await fixture.controller.getTranscriptPage(session.id)).items).toMatchObject([{ id: `${session.id}:e1`, content: "hello omp" }]);
    expect(fixture.store.get(session.id)).toMatchObject({ transcriptPath: file, agentSessionRef: "01abc-def" });
  });

  it("shows a Claude Code approval as a card on the call's row, and answers its hook from the card", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    const record = fixture.store.get(session.id)!;
    const file = claudeTranscriptPath(record.workspace, record.agentSessionRef!, fixture.home);
    mkdirSync(path.dirname(file), { recursive: true });
    const common = { isSidechain: false, timestamp: "2026-11-24T06:00:00.000Z" };
    writeFileSync(
      file,
      [
        { ...common, parentUuid: null, type: "user", uuid: "u1", message: { role: "user", content: "run the tests" }, origin: { kind: "human" }, permissionMode: "default" },
        { ...common, parentUuid: "u1", type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }], stop_reason: "tool_use" } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await fixture.controller.getTranscriptPage(session.id);
    fixture.events.length = 0;
    fixture.controller.onHook({ event: "PreToolUse", session: session.id, payload: { tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: "npm test" } } });
    const hook = hookChannel();
    fixture.controller.onHook({ event: "PermissionRequest", session: session.id, payload: { tool_name: "Bash", tool_input: { command: "npm test" } } }, hook);
    const toolId = `${session.id}:toolu_1`;
    await vi.waitFor(() =>
      expect(fixture.events).toContainEqual({ type: "transcript.appended", item: expect.objectContaining({ id: toolId, status: "approval-required" }) }),
    );
    const page = await fixture.controller.getTranscriptPage(session.id);
    expect(page.items.map((item) => item.id)).toEqual([`${session.id}:u1`, toolId]);
    expect(fixture.controller.sessionOfTool(toolId)).toBe(session.id);
    expect(fixture.controller.toolDecisionInfo(toolId, { optionId: "allow_once" }).requiresConfirmation).toBe(true);
    await fixture.controller.resolveToolCall(toolId, { optionId: "allow_once" });
    expect(JSON.parse(hook.replies[0]!).hookSpecificOutput.decision).toEqual({ behavior: "allow" });
    await vi.waitFor(async () =>
      expect((await fixture.controller.getTranscript(session.id)).find((item) => item.id === toolId)).toMatchObject({ status: "approved" }),
    );
  });

  it("closes a card the user answered at the terminal, when the agent's dialog closes or the turn stops", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    fixture.push("status", "t1", { reported: true, status: { app: "claude-code", state: "blocked", kind: "permission" } });
    const answered = hookChannel();
    fixture.controller.onHook({ event: "PermissionRequest", session: session.id, payload: { tool_name: "Bash", tool_input: { command: "ls" } } }, answered);
    await vi.waitFor(() => expect(fixture.controller.sessionOfTool(`${session.id}:approval-1`)).toBe(session.id));
    fixture.push("status", "t1", STATUS("working"));
    expect(answered.replies).toEqual([""]);
    const stopped = hookChannel();
    fixture.controller.onHook({ event: "PermissionRequest", session: session.id, payload: { tool_name: "Write", tool_input: { file_path: "/w/a" } } }, stopped);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixture.controller.onHook({ event: "Stop", session: session.id, payload: {} });
    expect(stopped.replies).toEqual([""]);
  });

  it("offers approvals once the agent runs with the hook and the app listens", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    expect((await fixture.controller.listSessions())[0]!.capabilities?.approvals).toBe(false);
    fixture.controller.onHook({ event: "PreToolUse", session: session.id, payload: { tool_use_id: "toolu_1", tool_name: "Read", tool_input: {} } });
    expect((await fixture.controller.listSessions())[0]!.capabilities?.approvals).toBe(true);
    expect(fixture.events.at(-1)).toMatchObject({ type: "session.updated", session: { capabilities: { approvals: true } } });
  });

  it("answers a hook of a session it does not have with no decision", () => {
    const fixture = setup();
    const hook = hookChannel();
    fixture.controller.onHook({ event: "PermissionRequest", session: "terminal-gone", payload: { tool_name: "Bash" } }, hook);
    expect(hook.replies).toEqual([""]);
  });

  it("interrupts the agent's turn on cancel", async () => {
    const fixture = setup();
    const session = await agentSession(fixture);
    await fixture.controller.cancelRun(session.id);
    expect(fixture.calls).toContainEqual({ method: "terminal.interrupt", params: { terminal: "t1" } });
  });
});
