import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionRecord } from "../../shared/terminal-ipc.js";
import type { ChannelHandlers, HcConnection, HelloInfo } from "./connection.js";
import { AGENT_LABEL, HcSessionTerminals, SESSION_LABEL } from "./terminals.js";

interface FakeTerminal {
  address: string;
  state: "live" | "finished";
  labels: Record<string, string>;
}

/** A core that keeps terminals in a map and records every call and attach. */
function fakeCore(initial: FakeTerminal[] = []) {
  const terminals = new Map(initial.map((terminal) => [terminal.address, { ...terminal }]));
  let next = terminals.size + 1;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const attaches: { params: Record<string, unknown>; handlers: ChannelHandlers; written: string[]; closed: boolean }[] = [];
  const hc = {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const address = params.terminal as string;
      switch (method) {
        case "terminal.run": {
          const terminal: FakeTerminal = { address: `t${next++}`, state: "live", labels: params.labels as Record<string, string> };
          terminals.set(terminal.address, terminal);
          return { ...terminal, argv: params.argv };
        }
        case "terminal.get": {
          const terminal = terminals.get(address);
          if (!terminal) throw Object.assign(new Error("not_found"), { kind: "not_found" });
          return terminal;
        }
        case "terminal.kill": {
          const terminal = terminals.get(address);
          if (terminal) terminal.state = "finished";
          return terminal;
        }
        case "terminal.rm":
          terminals.delete(address);
          return { removed: address };
        case "terminal.list":
          return { hidden_finished: 0, machines: [], terminals: [...terminals.values()].filter((terminal) => params.all || terminal.state === "live") };
        default:
          throw new Error(`unexpected ${method}`);
      }
    }),
    open: vi.fn(async (_method: string, params: Record<string, unknown>, handlers: ChannelHandlers) => {
      const attach = { params, handlers, written: [] as string[], closed: false };
      attaches.push(attach);
      return {
        result: { channel: attaches.length },
        channel: {
          id: attaches.length,
          automaticInput: false,
          write: (data: string) => attach.written.push(data),
          writeAutomatic: (data: string) => attach.written.push(data),
          resize: () => {},
          credit: () => {},
          focus: () => {},
          facts: () => {},
          close: async () => {
            attach.closed = true;
          },
        },
      };
    }),
  };
  const access = {
    connection: async () => hc as unknown as HcConnection,
    core: { version: "0.1.18", core: { id: "core-1", name: "mac" }, methods: [], features: [] } as HelloInfo,
    isRunning: () => true,
  };
  return { hc, access, terminals, calls, attaches };
}

function fakeStore(records: TerminalSessionRecord[]) {
  const map = new Map(records.map((record) => [record.id, { ...record }]));
  return {
    get: (id: string) => (map.has(id) ? { ...map.get(id)! } : undefined),
    list: () => [...map.values()].map((record) => ({ ...record })),
    bindTerminal: vi.fn((id: string, binding: { coreId: string; terminalAddress: string } | undefined) => {
      const record = map.get(id);
      if (!record) return;
      if (binding) Object.assign(record, binding);
      else {
        delete record.coreId;
        delete record.terminalAddress;
      }
    }),
    map,
  };
}

const record = (id: string, extra: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord => ({
  id,
  title: id,
  workspace: "/tmp",
  createdAt: "2026-11-24T00:00:00.000Z",
  agentKind: "shell",
  ...extra,
});

const SHELL = async () => ({ argv: ["/bin/zsh", "-l"] });
const noop = { onData: () => {}, onExit: () => {} };

describe("HcSessionTerminals", () => {
  it("starts a labelled login shell with an absolute program and records where it runs", async () => {
    const { access, calls, attaches } = fakeCore();
    const store = fakeStore([record("terminal-a")]);
    const terminals = new HcSessionTerminals(access, store, SHELL);
    await terminals.open({ record: record("terminal-a"), cols: 90, rows: 30, restart: false, ...noop });
    expect(calls[0]).toEqual({
      method: "terminal.run",
      params: {
        argv: ["/bin/zsh", "-l"],
        cwd: "/tmp",
        labels: { [SESSION_LABEL]: "terminal-a", [AGENT_LABEL]: "shell" },
        no_parent: true,
        no_notify: true,
        size: { cols: 90, rows: 30 },
      },
    });
    expect(store.map.get("terminal-a")).toMatchObject({ coreId: "core-1", terminalAddress: "t1" });
    expect(attaches[0]!.params).toMatchObject({ terminal: "t1", cols: 90, rows: 30, history: 2000 });
  });

  it("attaches to the session's running shell instead of starting another", async () => {
    const { access, calls } = fakeCore([{ address: "t4", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } }]);
    const store = fakeStore([record("terminal-a", { coreId: "core-1", terminalAddress: "t4" })]);
    await new HcSessionTerminals(access, store, SHELL).open({ record: record("terminal-a"), restart: false, ...noop });
    expect(calls.map((call) => call.method)).toEqual(["terminal.get"]);
  });

  it("starts fresh when the recorded shell finished, lives on another core, or is restarted", async () => {
    const finished = fakeCore([{ address: "t4", state: "finished", labels: { [SESSION_LABEL]: "terminal-a" } }]);
    const store = fakeStore([record("terminal-a", { coreId: "core-1", terminalAddress: "t4" })]);
    await new HcSessionTerminals(finished.access, store, SHELL).open({ record: record("terminal-a"), restart: false, ...noop });
    expect(finished.calls.map((call) => call.method)).toEqual(["terminal.get", "terminal.rm", "terminal.run"]);

    const elsewhere = fakeCore([{ address: "t4", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } }]);
    const moved = fakeStore([record("terminal-a", { coreId: "core-0", terminalAddress: "t4" })]);
    await new HcSessionTerminals(elsewhere.access, moved, SHELL).open({ record: record("terminal-a"), restart: false, ...noop });
    expect(elsewhere.calls.map((call) => call.method)).toEqual(["terminal.run"]);

    const restarted = fakeCore([{ address: "t4", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } }]);
    const bound = fakeStore([record("terminal-a", { coreId: "core-1", terminalAddress: "t4" })]);
    await new HcSessionTerminals(restarted.access, bound, SHELL).open({ record: record("terminal-a"), restart: true, ...noop });
    expect(restarted.calls.map((call) => call.method)).toEqual(["terminal.get", "terminal.kill", "terminal.rm", "terminal.run"]);
  });

  it("detaching lets go of the shell, killing ends it", async () => {
    const { access, calls, attaches, terminals } = fakeCore();
    const store = fakeStore([record("terminal-a")]);
    const provider = new HcSessionTerminals(access, store, SHELL);
    const viewing = await provider.open({ record: record("terminal-a"), restart: false, ...noop });
    viewing.handle({ t: "i", d: "ls\r" });
    await vi.waitFor(() => expect(attaches[0]!.written).toEqual(["ls\r"]));
    viewing.detach();
    expect(attaches[0]!.closed).toBe(true);
    expect(terminals.get("t1")?.state).toBe("live");

    const ending = await provider.open({ record: record("terminal-a"), restart: false, ...noop });
    ending.kill();
    await vi.waitFor(() => expect(terminals.has("t1")).toBe(false));
    expect(calls.some((call) => call.method === "terminal.kill")).toBe(true);
  });

  it("reports an exit with its code, a kill as a signal, and a dropped line as disconnected", async () => {
    const { access, attaches } = fakeCore();
    const store = fakeStore([record("terminal-a")]);
    const provider = new HcSessionTerminals(access, store, SHELL);
    const ends: unknown[] = [];
    for (let index = 0; index < 3; index += 1)
      await provider.open({ record: record("terminal-a"), restart: false, onData: () => {}, onExit: (end) => ends.push(end) });
    await vi.waitFor(() => expect(attaches).toHaveLength(3));
    attaches[0]!.handlers.onClose({ exit_code: 3, reason: "exited", finished_ms: 1 });
    attaches[1]!.handlers.onClose({ exit_code: null, reason: "killed", signal: 1, finished_ms: 1 });
    attaches[2]!.handlers.onClose({ reason: "connection_lost" });
    expect(ends).toEqual([{ exitCode: 3 }, { exitCode: 129, signal: 1 }, { exitCode: 0, disconnected: true }]);
  });

  it("ends a deleted session's shell, recorded or only labelled, and forgets it", async () => {
    const { access, terminals } = fakeCore([
      { address: "t1", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } },
      { address: "t2", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } },
      { address: "t3", state: "live", labels: { [SESSION_LABEL]: "terminal-b" } },
    ]);
    const store = fakeStore([record("terminal-a", { coreId: "core-1", terminalAddress: "t1" }), record("terminal-b")]);
    await new HcSessionTerminals(access, store, SHELL).kill(record("terminal-a"));
    expect([...terminals.keys()]).toEqual(["t3"]);
    expect(store.map.get("terminal-a")?.terminalAddress).toBeUndefined();
  });

  it("does not start a core just to find nothing to end", async () => {
    const { access, hc } = fakeCore();
    access.isRunning = () => false;
    const provider = new HcSessionTerminals(access, fakeStore([record("terminal-a")]), SHELL);
    await provider.kill(record("terminal-a"));
    expect(await provider.killAll()).toBe(0);
    expect(hc.call).not.toHaveBeenCalled();
  });

  it("ends every session shell on request, and leaves the user's own terminals alone", async () => {
    const { access, terminals } = fakeCore([
      { address: "t1", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } },
      { address: "t2", state: "live", labels: {} },
      { address: "t3", state: "finished", labels: { [SESSION_LABEL]: "terminal-b" } },
    ]);
    const store = fakeStore([record("terminal-a", { coreId: "core-1", terminalAddress: "t1" })]);
    expect(await new HcSessionTerminals(access, store, SHELL).killAll()).toBe(1);
    expect([...terminals.keys()]).toEqual(["t2"]);
    expect(store.map.get("terminal-a")?.terminalAddress).toBeUndefined();
  });

  it("reconciles at startup: orphans end, finished ones go, gone ones are forgotten, unrecorded ones are adopted", async () => {
    const { access, terminals } = fakeCore([
      { address: "t1", state: "live", labels: { [SESSION_LABEL]: "terminal-a" } },
      { address: "t2", state: "live", labels: { [SESSION_LABEL]: "terminal-deleted" } },
      { address: "t3", state: "finished", labels: { [SESSION_LABEL]: "terminal-b" } },
      { address: "t5", state: "live", labels: { [SESSION_LABEL]: "terminal-d" } },
    ]);
    const store = fakeStore([
      record("terminal-a", { coreId: "core-1", terminalAddress: "t1" }),
      record("terminal-b", { coreId: "core-1", terminalAddress: "t3" }),
      record("terminal-c", { coreId: "core-1", terminalAddress: "t9" }),
      record("terminal-d"),
    ]);
    const result = await new HcSessionTerminals(access, store, SHELL).reconcile();
    expect(result).toEqual({ orphans: 1, forgotten: 2 });
    expect([...terminals.keys()].sort()).toEqual(["t1", "t5"]);
    expect(store.map.get("terminal-d")).toMatchObject({ coreId: "core-1", terminalAddress: "t5" });
    expect(store.map.get("terminal-c")?.terminalAddress).toBeUndefined();
  });
});
